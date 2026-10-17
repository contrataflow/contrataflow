import { AiGenerationRequested } from '@contrataflow/validation';
import type { RequestAiGeneration } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { JOB_QUEUE } from '#shared/jobs/job-queue.js';
import type { JobQueuePort } from '#shared/jobs/job-queue.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { AiCircuitBreaker } from './ai-circuit-breaker.js';
import { AiTenantGateRegistry } from './ai-extension-points.js';
import { AiGeneratorRegistry } from './ai-generator.js';
import type { AiGenerator } from './ai-generator.js';
import { countGeneration } from './ai-telemetry.js';
import {
  gateDenied,
  generationInProgress,
  generatorUnavailable,
  needSummaryRequired,
  providerUnavailable,
} from './ai.errors.js';
import {
  AI_CLOCK,
  AI_GENERATION_REPOSITORY,
  AI_SETTINGS,
  AI_TRANSACTIONS,
  AiGenerationActiveError,
} from './ports.js';
import type {
  AiClock,
  AiGenerationRepository,
  AiGenerationTarget,
  AiSettings,
  AiTransactions,
} from './ports.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import { discardGeneration, requestGeneration } from '../domain/ai-generation.js';
import type { AiGeneration } from '../domain/ai-generation.js';

/*
 * AI-01 — Solicitar geração com IA (US-115 · RN-AI-01/02/12 · padrão B de DEC-163):
 *
 *   prepare (fora da transação): provedor configurado e circuito fechado (503), gerador registrado
 *     para o par (V-01) e resumo exigido pelo gerador (V-03).
 *   handle (UMA transação curta): POL-18 → POL-02 sobre o alvo (fachada do `document`) → portão do
 *     órgão (US-116) → validação do gerador → uma ativa por alvo (V-08) → `AiGeneration` `QUEUED` →
 *     auditoria `ai.generation_request` → outbox `AiGenerationRequested` → commit.
 *   depois do commit: enfileira `ai-generation` com `jobId = generationId`. Fila fora → a geração
 *     fica `QUEUED` e o reconciliador reenfileira (FA-05); a resposta continua 202.
 *
 * Nenhuma chamada ao provedor aqui (RN-AI-02). Nada do resumo/instrução em log, evento ou auditoria.
 */

export interface RequestAiGenerationInput {
  readonly processId: string;
  readonly body: RequestAiGeneration;
  readonly idempotencyKey: string | null;
}

export interface RequestAiGenerationResult {
  readonly generation: AiGeneration;
}

interface Prepared {
  readonly generator: AiGenerator;
}

/** `AI_PROVIDER=none`: indisponível até a configuração mudar. */
const PROVIDER_OFF_RETRY_AFTER_SECONDS = 300;

@Injectable()
export class RequestAiGenerationCommand extends TransactionalCommandHandler<
  RequestAiGenerationInput,
  Prepared,
  RequestAiGenerationResult
> {
  constructor(
    @Inject(AI_TRANSACTIONS) transactions: AiTransactions,
    @Inject(AI_GENERATION_REPOSITORY) private readonly generations: AiGenerationRepository,
    @Inject(AI_SETTINGS) private readonly settings: AiSettings,
    @Inject(AI_CLOCK) private readonly clock: AiClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    @Inject(JOB_QUEUE) private readonly jobs: JobQueuePort,
    private readonly generators: AiGeneratorRegistry,
    private readonly gates: AiTenantGateRegistry,
    private readonly circuit: AiCircuitBreaker,
    private readonly documents: DocumentFacade,
  ) {
    super('ai.generation_request', transactions);
  }

  override async execute(input: RequestAiGenerationInput): Promise<RequestAiGenerationResult> {
    const result = await super.execute(input);
    await this.enqueue(result.generation);
    return result;
  }

  protected async prepare(input: RequestAiGenerationInput): Promise<Prepared> {
    if (this.settings.provider === 'none') {
      throw providerUnavailable(PROVIDER_OFF_RETRY_AFTER_SECONDS);
    }
    const circuit = await this.circuit.view();
    if (circuit.open) throw providerUnavailable(circuit.retryAfterSeconds);

    const { body } = input;
    const generator = this.generators.find(body.targetModule, body.kind);
    if (generator === undefined) throw generatorUnavailable();
    if (generator.needSummary === 'REQUIRED' && body.needSummary === undefined) {
      throw needSummaryRequired();
    }
    if (body.documentId === undefined && body.targetModule !== 'RISK_MAP') {
      throw validationError([
        {
          field: 'documentId',
          code: 'CONDITIONAL_REQUIRED',
          message: 'Informe o documento a gerar.',
        },
      ]);
    }
    return { generator };
  }

  protected async handle(
    tx: TenantTx,
    input: RequestAiGenerationInput,
    { generator }: Prepared,
  ): Promise<RequestAiGenerationResult> {
    const { body, processId } = input;
    const userId = this.actorId();
    const now = this.clock();

    // POL-18 → POL-02 sobre o alvo (permissão de edição do tipo, custódia/participação, etapa,
    // status do documento): 403/409/422 do próprio `document`.
    const target = await this.documents.aiTargetIn(tx, {
      processId,
      systemModule: body.targetModule,
      documentId: body.documentId ?? null,
    });

    const gate = await this.gates.check(tx, {
      userId,
      processId,
      targetModule: body.targetModule,
      kind: body.kind,
      reservedTokens: generator.reservedTokens,
      stage: 'REQUEST',
    });
    if (!gate.allowed) throw gateDenied(gate.code);

    const request = {
      processId,
      targetModule: body.targetModule,
      kind: body.kind,
      documentId: target.documentId,
      sectionKey: body.sectionKey ?? null,
      action: body.action ?? null,
      needSummary: body.needSummary ?? null,
      instruction: body.instruction ?? null,
    };
    const check = await generator.validateRequest(tx, request);

    const active = await this.generations.findActive(tx, request);
    if (active !== null) throw generationInProgress(active.id);

    if (body.kind === 'DRAFT') await this.discardPreviousProposals(tx, request, userId, now);

    const generation = requestGeneration({
      id: newId(),
      tenantId: requireRequestContext().tenantId ?? '',
      processId,
      documentId: target.documentId,
      targetModule: body.targetModule,
      kind: body.kind,
      action: request.action,
      sectionKey: request.sectionKey,
      baseRevision: check.baseRevision,
      needSummary: request.needSummary,
      instruction: request.instruction,
      provider: this.settings.provider,
      promptKey: generator.prompt.key,
      promptVersion: generator.prompt.version,
      reservedTokens: generator.reservedTokens,
      createdById: userId,
      now,
    });
    try {
      await this.generations.insert(tx, generation);
    } catch (error) {
      if (!(error instanceof AiGenerationActiveError)) throw error;
      // Corrida com outro pedido para o mesmo alvo: o único parcial decide (RN-AI-12).
      throw generationInProgress(error.activeId);
    }

    await this.audit.record(tx, {
      action: 'ai.generation_request',
      entityType: 'AiGeneration',
      entityId: generation.id,
      processId,
      metadata: {
        generationId: generation.id,
        targetModule: generation.targetModule,
        kind: generation.kind,
        action: generation.action,
        sectionKey: generation.sectionKey,
        documentId: generation.documentId,
        provider: generation.provider,
        promptKey: generation.promptKey,
        promptVersion: generation.promptVersion,
        reservedTokens: generation.reservedTokens,
        idempotencyKey: input.idempotencyKey,
      },
    });
    await this.outbox.record(
      tx,
      AiGenerationRequested.of({
        aggregateId: generation.id,
        processId,
        payload: {
          generationId: generation.id,
          processId,
          documentId: generation.documentId,
          targetModule: generation.targetModule,
          kind: generation.kind,
          action: generation.action,
          sectionKey: generation.sectionKey,
        },
      }),
    );
    return { generation };
  }

  protected override committed(result: RequestAiGenerationResult): void {
    const { generation } = result;
    countGeneration(generation.targetModule, generation.kind, 'QUEUED');
    this.logger.log(
      {
        event: 'ai.generation_requested',
        generationId: generation.id,
        targetModule: generation.targetModule,
        kind: generation.kind,
        action: generation.action,
        reservedTokens: generation.reservedTokens,
        correlationId: requireRequestContext().correlationId,
      },
      'ai.generation_requested',
    );
  }

  /**
   * RN-AI-32 (api/16-ai.md, efeitos de AI-01): novo rascunho do mesmo alvo descarta as propostas
   * `SUCCEEDED` anteriores, não aplicadas, do mesmo usuário.
   */
  private async discardPreviousProposals(
    tx: TenantTx,
    target: AiGenerationTarget,
    userId: string,
    now: Date,
  ): Promise<void> {
    const previous = await this.generations.list(
      tx,
      target.processId,
      {
        targetModule: target.targetModule,
        kind: 'DRAFT',
        statuses: ['SUCCEEDED'],
        requestedById: userId,
      },
      { after: null, limit: 100 },
    );
    for (const generation of previous) {
      const discarded = discardGeneration(generation, userId, now);
      if (!(await this.generations.update(tx, discarded, { status: 'SUCCEEDED' }))) continue;
      await this.audit.record(tx, {
        action: 'ai.generation_discard',
        entityType: 'AiGeneration',
        entityId: generation.id,
        processId: generation.processId,
        metadata: {
          generationId: generation.id,
          statusBefore: 'SUCCEEDED',
          statusAfter: 'DISCARDED',
          reason: 'SUPERSEDED',
        },
      });
    }
  }

  /** Padrão B: depois do commit; falha da fila não desfaz o pedido (FA-05). */
  private async enqueue(generation: AiGeneration): Promise<void> {
    try {
      await this.jobs.enqueue(
        'ai-generation',
        'generate',
        { generationId: generation.id },
        {
          jobId: generation.id,
          attempts: this.settings.maxAttempts,
          backoffMs: this.settings.backoffBaseMs,
        },
      );
    } catch (error) {
      this.logger.warn(
        {
          event: 'ai.enqueue_deferred',
          generationId: generation.id,
          cause: error instanceof Error ? error.name : 'unknown',
          correlationId: requireRequestContext().correlationId,
        },
        'ai.enqueue_deferred',
      );
    }
  }

  private actorId(): string {
    const userId = requireRequestContext().actor.userId;
    if (userId === null) throw new ApiError('UNAUTHENTICATED');
    return userId;
  }
}
