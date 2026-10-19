import type { AiGenerationErrorCode } from '@contrataflow/types';
import { AiGenerationCompleted, AiGenerationFailed } from '@contrataflow/validation';
import type { AiOutputWarning } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { canonicalJson, sha256Hex } from '#shared/integrity/canonical-json.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { AiCircuitBreaker } from './ai-circuit-breaker.js';
import { AiPostProcessorRegistry, AiTenantGateRegistry } from './ai-extension-points.js';
import { AiGeneratorRegistry, AiPolicyRevokedError, promptOf } from './ai-generator.js';
import type { AiGenerator, AiGeneratorContext } from './ai-generator.js';
import { AI_PROVIDER, AiProviderError } from './ai-provider.port.js';
import type {
  AiProvider,
  AiProviderMessage,
  AiProviderRequest,
  AiProviderResponse,
  AiTokenUsage,
} from './ai-provider.port.js';
import {
  countGeneration,
  countProviderError,
  recordCost,
  recordDuration,
  recordGroundingReplacements,
  recordUsage,
} from './ai-telemetry.js';
import { AI_CLOCK, AI_GENERATION_REPOSITORY, AI_SETTINGS, AI_TRANSACTIONS } from './ports.js';
import type { AiClock, AiGenerationRepository, AiSettings, AiTransactions } from './ports.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import {
  addUsage,
  cancelGeneration,
  claimGeneration,
  completeGeneration,
  failGeneration,
} from '../domain/ai-generation.js';
import type { AiGeneration } from '../domain/ai-generation.js';
import { costOf } from '../domain/ai-pricing.js';
import { ContextTooLargeError, sanitizeContext } from '../domain/context-sanitizer.js';
import type { ContextPart, SanitizedContext } from '../domain/context-sanitizer.js';
import { convertStructuredOutput } from '../domain/output-converter.js';
import type { ConversionResult } from '../domain/output-converter.js';
import { postProcessingIssues, runPostProcessors } from '../domain/post-processing.js';
import type { PostProcessingResult } from '../domain/post-processing.js';
import { AI_PRICING_TABLE } from '../domain/pricing-table.js';
import { renderPrompt, repairInstruction } from '../domain/prompts.js';
import type { RenderedPrompt } from '../domain/prompts.js';
import { responseJsonSchema } from '../domain/structured-output.js';

/*
 * `AiGenerationProcessor` — o pipeline do job `ai-generation` (US-115 · queues.md §4.5.1 ·
 * RN-AI-02..11):
 *
 *   1. Claim (transação curta): `QUEUED → RUNNING`, ou `RUNNING → RUNNING` na retentativa do PRÓPRIO
 *      job (tentativas coerentes). Outra entrega do mesmo `generationId` → encerra sem executar.
 *   2. Revalidação e contexto (transação de LEITURA do tenant, RLS): gerador, portão do órgão,
 *      POL-02 do solicitante sobre o alvo e o contexto pelas fachadas de leitura. Recusa → `CANCELED`
 *      (`CANCELED_BY_POLICY`) sem chamar o provedor (FA-06).
 *   3. `ContextSanitizer` (LGPD/sigilo) e prompt versionado.
 *   4. Provedor FORA de qualquer transação, com timeout (RN-AI-02/08). Falha transitória → nova
 *      tentativa do job (backoff da fila); na última, `FAILED`. Disjuntor alimentado aqui.
 *   5. Validação Zod + conversão TipTap; saída inválida → 1 reparo; persistindo, `OUTPUT_INVALID`.
 *   6. Ganchos de pós-processamento (GroundingGuard — US-122).
 *   7. Gravação (transação curta): `SUCCEEDED` + auditoria + `AiGenerationCompleted` (timeline no
 *      mesmo `tx`), condicionada a `RUNNING` — cancelada no meio → só os tokens são registrados.
 *
 * Nada do contexto, do prompt ou da saída vai para log, métrica ou evento (DEC-138).
 */

export interface ProcessGenerationInput {
  readonly generationId: string;
  /** Tentativa do job (1..maxAttempts). */
  readonly attempt: number;
  /** Vínculo do solicitante ainda ativo (relido pelo job); inativo → cancelamento por política. */
  readonly requesterActive?: boolean;
}

export type ProcessOutcome = 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'SKIPPED';

/**
 * Falha transitória antes da última tentativa: o job relança e a fila tenta de novo com backoff
 * (RN-AI-08). `consumesAttempt = false` quando o circuito está aberto (o job só aguarda).
 */
export class AiRetryableError extends Error {
  constructor(
    readonly errorCode: AiGenerationErrorCode,
    readonly retryAfterMs: number | null,
    readonly consumesAttempt: boolean,
  ) {
    super(`Geração com IA: falha transitória (${errorCode}).`);
    this.name = 'AiRetryableError';
  }
}

/** Falha final da geração (vira `FAILED` com o código). */
class GenerationFailure extends Error {
  constructor(
    readonly errorCode: Exclude<AiGenerationErrorCode, 'CANCELED_BY_POLICY'>,
    readonly usage: AiTokenUsage,
  ) {
    super(`Geração com IA: ${errorCode}`);
    this.name = 'GenerationFailure';
  }
}

interface PreparedRun {
  readonly generator: AiGenerator;
  readonly context: AiGeneratorContext;
}

const NO_USAGE: AiTokenUsage = { inputTokens: 0, outputTokens: 0 };

function sum(a: AiTokenUsage, b: AiTokenUsage): AiTokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

const PROVIDER_ERROR_CODES = {
  RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  CONTENT_FILTERED: 'CONTENT_FILTERED',
  CONTEXT_TOO_LARGE: 'CONTEXT_TOO_LARGE',
} as const satisfies Record<AiProviderError['kind'], AiGenerationErrorCode>;

@Injectable()
export class AiGenerationProcessor {
  private readonly logger = new Logger('AiGenerationProcessor');

  constructor(
    @Inject(AI_TRANSACTIONS) private readonly transactions: AiTransactions,
    @Inject(AI_GENERATION_REPOSITORY) private readonly generations: AiGenerationRepository,
    @Inject(AI_SETTINGS) private readonly settings: AiSettings,
    @Inject(AI_CLOCK) private readonly clock: AiClock,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly generators: AiGeneratorRegistry,
    private readonly gates: AiTenantGateRegistry,
    private readonly postProcessors: AiPostProcessorRegistry,
    private readonly circuit: AiCircuitBreaker,
    private readonly documents: DocumentFacade,
  ) {}

  async process(input: ProcessGenerationInput): Promise<ProcessOutcome> {
    const claimed = await this.claim(input);
    if (claimed === null) {
      this.logger.log({
        event: 'ai.job_skipped',
        generationId: input.generationId,
        attempt: input.attempt,
      });
      return 'SKIPPED';
    }

    let prepared: PreparedRun;
    try {
      if (input.requesterActive === false) throw new AiPolicyRevokedError('MEMBERSHIP_INACTIVE');
      prepared = await this.transactions.read((tx) => this.prepare(tx, claimed));
    } catch (error) {
      if (!isPolicyRefusal(error)) throw error;
      await this.cancelByPolicy(claimed, error);
      return 'CANCELED';
    }

    let sanitized: SanitizedContext;
    try {
      sanitized = sanitizeContext([...requestParts(claimed), ...prepared.context.parts], {
        isBudgetConfidential: prepared.context.isBudgetConfidential,
        maxChars: this.settings.maxContextChars,
      });
    } catch (error) {
      if (!(error instanceof ContextTooLargeError)) throw error;
      return this.fail(claimed, new GenerationFailure('CONTEXT_TOO_LARGE', NO_USAGE), null, null);
    }

    const prompt = renderPrompt(promptOf(prepared.generator, claimed.action), {
      sections: prepared.context.sections,
      context: sanitized,
      action: claimed.action,
    });
    const model =
      claimed.kind === 'DRAFT' ? this.settings.models.draft : this.settings.models.section;
    const startedAt = performance.now();
    let usage: AiTokenUsage = NO_USAGE;
    try {
      const {
        result,
        usage: spent,
        model: usedModel,
        providerRequestId,
      } = await this.generate(claimed, prepared, sanitized, prompt, model);
      usage = spent;
      const latencyMs = Math.round(performance.now() - startedAt);
      return await this.complete(claimed, {
        result,
        usage,
        model: usedModel,
        providerRequestId,
        sanitized,
        latencyMs,
      });
    } catch (error) {
      if (error instanceof GenerationFailure) {
        return this.fail(
          claimed,
          error,
          sanitized,
          Math.round(performance.now() - startedAt),
          model,
        );
      }
      if (error instanceof AiProviderError) {
        return this.providerFailure(claimed, input, error, sanitized, model);
      }
      throw error;
    }
  }

  // --- 1. Claim ---------------------------------------------------------------------------------

  private claim(input: ProcessGenerationInput): Promise<AiGeneration | null> {
    return this.transactions.run(async (tx) => {
      const current = await this.generations.findById(tx, input.generationId);
      if (current === null) return null;
      const next = claimGeneration(current, input.attempt, this.clock());
      if (next === null) return null;
      const won = await this.generations.update(tx, next, {
        status: current.status,
        attempts: current.attempts,
      });
      return won ? next : null;
    });
  }

  // --- 2. Revalidação (POL-18) e contexto --------------------------------------------------------

  private async prepare(tx: TenantTx, generation: AiGeneration): Promise<PreparedRun> {
    const generator = this.generators.find(generation.targetModule, generation.kind);
    if (generator === undefined) throw new AiPolicyRevokedError('GENERATOR_UNAVAILABLE');
    const gate = await this.gates.check(tx, {
      userId: generation.createdById,
      processId: generation.processId,
      targetModule: generation.targetModule,
      kind: generation.kind,
      reservedTokens: generation.reservedTokens,
      stage: 'EXECUTION',
      generationId: generation.id,
      createdAt: generation.createdAt,
    });
    if (!gate.allowed) throw new AiPolicyRevokedError(gate.code);
    // POL-02 do solicitante sobre o alvo, no tenant e com o ator do job (DEC-164).
    await this.documents.aiTargetIn(tx, {
      processId: generation.processId,
      systemModule: generation.targetModule,
      documentId: generation.documentId,
    });
    return { generator, context: await generator.buildContext(tx, generation) };
  }

  private async cancelByPolicy(generation: AiGeneration, error: unknown): Promise<void> {
    const reason = error instanceof ApiError ? error.code : (error as AiPolicyRevokedError).reason;
    await this.transactions.run(async (tx) => {
      const current = await this.generations.findById(tx, generation.id);
      if (current?.status !== 'RUNNING') return;
      const canceled = cancelGeneration(current, { byPolicy: true, userId: null }, this.clock());
      if (!(await this.generations.update(tx, canceled, { status: 'RUNNING' }))) return;
      await this.audit.record(tx, {
        action: 'ai.generation_discard',
        entityType: 'AiGeneration',
        entityId: generation.id,
        processId: generation.processId,
        metadata: {
          generationId: generation.id,
          statusBefore: 'RUNNING',
          statusAfter: 'CANCELED',
          errorCode: 'CANCELED_BY_POLICY',
          reason,
        },
      });
    });
    countGeneration(generation.targetModule, generation.kind, 'CANCELED');
    this.logger.warn({
      event: 'ai.generation_canceled_by_policy',
      generationId: generation.id,
      reason,
    });
  }

  // --- 4/5. Provedor, validação e reparo ---------------------------------------------------------

  private async generate(
    generation: AiGeneration,
    prepared: PreparedRun,
    sanitized: SanitizedContext,
    prompt: RenderedPrompt,
    model: string,
  ): Promise<{
    readonly result: PostProcessingResult;
    readonly usage: AiTokenUsage;
    readonly model: string;
    readonly providerRequestId: string | null;
  }> {
    const circuit = await this.circuit.view();
    if (circuit.open)
      throw new AiProviderError('UNAVAILABLE', { retryAfterMs: circuit.retryAfterSeconds * 1_000 });

    const spec = {
      sections: prepared.context.sections,
      warnings: mergeWarnings(sanitized.warnings, prepared.context.warnings ?? []),
      ...(prepared.generator.responseSchema ? { schema: prepared.generator.responseSchema } : {}),
      ...(prepared.context.refineRisks ? { refineRisks: prepared.context.refineRisks } : {}),
      ...(prepared.context.ignoreUnknownSections ? { ignoreUnknownSections: true } : {}),
    };
    const base = {
      model,
      system: prompt.system,
      responseSchema: responseJsonSchema(prepared.generator.responseSchema),
      maxOutputTokens: prepared.generator.maxOutputTokens,
      temperature: 0.2,
      timeoutMs: this.settings.requestTimeoutMs,
    };
    const metadata = {
      promptKey: generation.promptKey,
      promptVersion: generation.promptVersion,
      contextHash: sanitized.contextHash,
      sectionKeys: prepared.context.sections.map((section) => section.sectionKey),
    };
    const messages: AiProviderMessage[] = [{ role: 'user', content: prompt.user }];

    const first = await this.call(
      { ...base, messages, metadata: { ...metadata, call: 'initial' } },
      NO_USAGE,
    );
    let usage = first.usage;
    let response = first;
    let conversion = this.convert(first, spec);
    if (!conversion.ok) {
      this.logger.warn({
        event: 'ai.output_repair',
        generationId: generation.id,
        issues: conversion.issues.length,
      });
      const repair = await this.call(
        {
          ...base,
          messages: [
            ...messages,
            { role: 'assistant', content: textOf(first.output) },
            { role: 'user', content: repairInstruction(conversion.issues) },
          ],
          metadata: { ...metadata, call: 'repair' },
        },
        usage,
      );
      usage = sum(usage, repair.usage);
      response = repair;
      conversion = this.convert(repair, spec);
    }
    if (response.finishReason === 'content_filter')
      throw new GenerationFailure('CONTENT_FILTERED', usage);
    if (!conversion.ok) throw new GenerationFailure('OUTPUT_INVALID', usage);
    await this.circuit.success();
    return {
      result: this.postProcess(generation, prepared, conversion.output, sanitized, usage),
      usage,
      model: response.model,
      providerRequestId: response.providerRequestId,
    };
  }

  /**
   * Passo 6 (RN-AI-54): ganchos (GroundingGuard) e nova conferência do schema do editor e do
   * `maxChars`. Qualquer falha é FECHADA: `OUTPUT_INVALID` sem gravar `output` (V-09).
   */
  private postProcess(
    generation: AiGeneration,
    prepared: PreparedRun,
    output: Parameters<typeof runPostProcessors>[1],
    sanitized: SanitizedContext,
    usage: AiTokenUsage,
  ): PostProcessingResult {
    let result: PostProcessingResult;
    try {
      result = runPostProcessors(this.postProcessors.all(), output, sanitized);
    } catch (error) {
      this.groundingFailed(generation, error instanceof Error ? error.name : 'unknown');
      throw new GenerationFailure('OUTPUT_INVALID', usage);
    }
    const issues = postProcessingIssues(result.output, prepared.context.sections);
    if (issues.length > 0) {
      this.groundingFailed(generation, 'invalid_output');
      throw new GenerationFailure('OUTPUT_INVALID', usage);
    }
    this.logger.log(
      {
        event: 'ai.grounding_applied',
        generationId: generation.id,
        targetModule: generation.targetModule,
        replacements: result.groundingReplacements,
        placeholders: result.placeholdersCount,
      },
      'ai.grounding_applied',
    );
    return result;
  }

  private groundingFailed(generation: AiGeneration, cause: string): void {
    this.logger.error(
      {
        event: 'ai.grounding_failed',
        generationId: generation.id,
        cause,
        correlationId: requireRequestContext().correlationId,
      },
      'ai.grounding_failed',
    );
  }

  private convert(
    response: AiProviderResponse,
    spec: Parameters<typeof convertStructuredOutput>[1],
  ): ConversionResult {
    if (response.finishReason === 'content_filter')
      return { ok: false, issues: ['(raiz): content_filter'] };
    return convertStructuredOutput(response.output, spec);
  }

  /** Uma chamada com timeout (RN-AI-08); erros carregam o uso já acumulado. */
  private async call(
    request: Omit<AiProviderRequest, 'signal'>,
    spent: AiTokenUsage,
  ): Promise<AiProviderResponse> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AiProviderError('TIMEOUT'));
      }, request.timeoutMs);
    });
    try {
      return await Promise.race([
        this.provider.generate({ ...request, signal: controller.signal }),
        timeout,
      ]);
    } catch (error) {
      if (error instanceof AiProviderError) {
        throw new AiProviderError(error.kind, {
          usage: sum(spent, error.usage),
          ...(error.retryAfterMs === null ? {} : { retryAfterMs: error.retryAfterMs }),
          cause: error,
        });
      }
      // Erro desconhecido do adaptador (rede): transitório.
      throw new AiProviderError('UNAVAILABLE', { usage: spent, cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  private async providerFailure(
    generation: AiGeneration,
    input: ProcessGenerationInput,
    error: AiProviderError,
    sanitized: SanitizedContext,
    model: string,
  ): Promise<ProcessOutcome> {
    const errorCode = PROVIDER_ERROR_CODES[error.kind];
    countProviderError(errorCode);
    this.logger.warn({
      event: 'ai.provider_retry',
      generationId: generation.id,
      attempt: input.attempt,
      errorCode,
      final: !error.transient || input.attempt >= this.settings.maxAttempts,
    });
    if (!error.transient) {
      return this.fail(
        generation,
        new GenerationFailure(errorCode, error.usage),
        sanitized,
        null,
        model,
      );
    }
    await this.circuit.failure(errorCode);
    if (input.attempt >= this.settings.maxAttempts) {
      return this.fail(
        generation,
        new GenerationFailure(errorCode, error.usage),
        sanitized,
        null,
        model,
      );
    }
    // Tokens da tentativa contam no uso (RN-AI-08) — gravados antes da próxima tentativa.
    if (error.usage.inputTokens + error.usage.outputTokens > 0) {
      await this.transactions.run(async (tx) => {
        const current = await this.generations.findById(tx, generation.id);
        if (current === null) return;
        await this.generations.update(tx, addUsage(current, error.usage, this.clock()), {
          status: current.status,
        });
      });
    }
    throw new AiRetryableError(errorCode, error.retryAfterMs, true);
  }

  // --- 7. Gravação --------------------------------------------------------------------------------

  private complete(
    generation: AiGeneration,
    done: {
      readonly result: PostProcessingResult;
      readonly usage: AiTokenUsage;
      readonly model: string;
      readonly providerRequestId: string | null;
      readonly sanitized: SanitizedContext;
      readonly latencyMs: number;
    },
  ): Promise<ProcessOutcome> {
    const cost = costOf(AI_PRICING_TABLE, done.model, done.usage);
    if (cost.costUsd === null) {
      this.logger.warn({
        event: 'ai.pricing_missing',
        model: done.model,
        pricingVersion: cost.pricingVersion,
      });
    }
    const output = done.result.output;
    const outputHash = sha256Hex(canonicalJson(output));
    return this.transactions.run(async (tx): Promise<ProcessOutcome> => {
      const current = await this.generations.findById(tx, generation.id);
      if (current === null) return 'SKIPPED';
      if (current.status !== 'RUNNING') return this.discardResponse(tx, current, done.usage);
      const completed = completeGeneration(
        current,
        {
          model: done.model,
          inputRefs: done.sanitized.inputRefs,
          contextHash: done.sanitized.contextHash,
          output,
          outputHash,
          placeholdersCount: done.result.placeholdersCount,
          groundingReplacements: done.result.groundingReplacements,
          usage: done.usage,
          costUsd: cost.costUsd,
          pricingVersion: cost.pricingVersion,
          latencyMs: done.latencyMs,
          providerRequestId: done.providerRequestId,
        },
        this.clock(),
      );
      if (
        !(await this.generations.update(tx, completed, {
          status: 'RUNNING',
          attempts: current.attempts,
        }))
      ) {
        const latest = await this.generations.findById(tx, generation.id);
        return latest === null ? 'SKIPPED' : this.discardResponse(tx, latest, done.usage);
      }
      await this.audit.record(tx, {
        action: 'ai.generation_complete',
        entityType: 'AiGeneration',
        entityId: completed.id,
        processId: completed.processId,
        metadata: {
          generationId: completed.id,
          provider: completed.provider,
          model: completed.model,
          promptKey: completed.promptKey,
          promptVersion: completed.promptVersion,
          inputRefs: completed.inputRefs,
          contextHash: completed.contextHash,
          outputHash: completed.outputHash,
          inputTokens: completed.inputTokens,
          outputTokens: completed.outputTokens,
          totalTokens: completed.totalTokens,
          costUsd: completed.costUsd,
          pricingVersion: completed.pricingVersion,
          attempts: completed.attempts,
        },
      });
      await this.outbox.record(
        tx,
        AiGenerationCompleted.of({
          aggregateId: completed.id,
          processId: completed.processId,
          payload: {
            generationId: completed.id,
            processId: completed.processId,
            documentId: completed.documentId,
            targetModule: completed.targetModule,
            kind: completed.kind,
            action: completed.action,
            sectionKey: completed.sectionKey,
            requestedById: completed.createdById,
            model: done.model,
            promptKey: completed.promptKey,
            promptVersion: completed.promptVersion,
            totalTokens: completed.totalTokens ?? 0,
            sectionsCount: output.sections.length,
            risksCount: output.risks?.length ?? 0,
            placeholdersCount: completed.placeholdersCount,
          },
        }),
      );
      // Sai de `RUNNING`: a reserva dá lugar ao consumo real inteiro da geração.
      await this.gates.settle(tx, completed, completed.totalTokens ?? 0);
      this.completedTelemetry(completed);
      return 'SUCCEEDED';
    });
  }

  private completedTelemetry(generation: AiGeneration): void {
    const model = generation.model ?? 'unknown';
    countGeneration(generation.targetModule, generation.kind, 'SUCCEEDED');
    recordUsage(model, generation.inputTokens ?? 0, generation.outputTokens ?? 0);
    recordCost(model, generation.costUsd);
    recordGroundingReplacements(generation.groundingReplacements);
    recordDuration(
      ((generation.completedAt?.getTime() ?? 0) - generation.createdAt.getTime()) / 1_000,
      generation.targetModule,
      generation.kind,
    );
    this.logger.log(
      {
        event: 'ai.generation_completed',
        generationId: generation.id,
        model,
        promptKey: generation.promptKey,
        promptVersion: generation.promptVersion,
        totalTokens: generation.totalTokens,
        costUsd: generation.costUsd,
        latencyMs: generation.latencyMs,
        attempts: generation.attempts,
        groundingReplacements: generation.groundingReplacements,
        placeholdersCount: generation.placeholdersCount,
      },
      'ai.generation_completed',
    );
  }

  /** Cancelada durante a execução (FA-02): descarta a resposta e registra só os tokens. */
  private async discardResponse(
    tx: TenantTx,
    current: AiGeneration,
    usage: AiTokenUsage,
  ): Promise<ProcessOutcome> {
    const withUsage = addUsage(current, usage, this.clock());
    if (await this.generations.update(tx, withUsage, { status: current.status })) {
      // Já encerrada (cancelada): os tokens anteriores já contavam; só os desta resposta entram.
      await this.gates.settle(tx, withUsage, usage.inputTokens + usage.outputTokens);
    }
    this.logger.log({
      event: 'ai.response_discarded',
      generationId: current.id,
      status: current.status,
    });
    return current.status === 'CANCELED' ? 'CANCELED' : 'SKIPPED';
  }

  private async fail(
    generation: AiGeneration,
    failure: GenerationFailure,
    sanitized: SanitizedContext | null,
    latencyMs: number | null,
    model: string | null = null,
  ): Promise<ProcessOutcome> {
    const cost = model === null ? null : costOf(AI_PRICING_TABLE, model, failure.usage);
    const outcome = await this.transactions.run(async (tx): Promise<ProcessOutcome> => {
      const current = await this.generations.findById(tx, generation.id);
      if (current === null) return 'SKIPPED';
      if (current.status !== 'RUNNING') return this.discardResponse(tx, current, failure.usage);
      const failed = failGeneration(
        current,
        {
          errorCode: failure.errorCode,
          usage: failure.usage,
          model,
          ...(sanitized === null
            ? {}
            : { inputRefs: sanitized.inputRefs, contextHash: sanitized.contextHash }),
          costUsd: cost?.costUsd ?? null,
          pricingVersion: cost?.pricingVersion ?? null,
          latencyMs,
        },
        this.clock(),
      );
      if (
        !(await this.generations.update(tx, failed, {
          status: 'RUNNING',
          attempts: current.attempts,
        }))
      ) {
        return 'SKIPPED';
      }
      await this.audit.record(tx, {
        action: 'ai.generation_fail',
        entityType: 'AiGeneration',
        entityId: failed.id,
        processId: failed.processId,
        metadata: {
          generationId: failed.id,
          errorCode: failed.errorCode,
          attempts: failed.attempts,
          inputTokens: failed.inputTokens,
          outputTokens: failed.outputTokens,
          totalTokens: failed.totalTokens,
        },
      });
      await this.outbox.record(
        tx,
        AiGenerationFailed.of({
          aggregateId: failed.id,
          processId: failed.processId,
          payload: {
            generationId: failed.id,
            processId: failed.processId,
            documentId: failed.documentId,
            targetModule: failed.targetModule,
            kind: failed.kind,
            requestedById: failed.createdById,
            errorCode: failure.errorCode,
            attempts: failed.attempts,
          },
        }),
      );
      await this.gates.settle(tx, failed, failed.totalTokens ?? 0);
      return 'FAILED';
    });
    if (outcome === 'FAILED') {
      countGeneration(generation.targetModule, generation.kind, 'FAILED');
      this.logger.error(
        {
          event: 'ai.generation_failed',
          generationId: generation.id,
          errorCode: failure.errorCode,
          attempts: generation.attempts,
          correlationId: requireRequestContext().correlationId,
        },
        'ai.generation_failed',
      );
    }
    return outcome;
  }
}

/** Avisos da sanitização + do gerador, sem repetir o mesmo código com os mesmos parâmetros. */
function mergeWarnings(
  first: readonly AiOutputWarning[],
  second: readonly AiOutputWarning[],
): AiOutputWarning[] {
  const seen = new Set<string>();
  return [...first, ...second].filter((warning) => {
    const key = canonicalJson(warning);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Resumo e orientações do pedido entram no contexto como dados (sanitizados e com hash). */
function requestParts(generation: AiGeneration): ContextPart[] {
  const parts: ContextPart[] = [];
  if (generation.needSummary !== null) {
    parts.push({
      ref: { kind: 'USER_SUMMARY', id: null },
      label: 'Resumo da necessidade informado pelo solicitante',
      data: generation.needSummary,
    });
  }
  if (generation.instruction !== null) {
    parts.push({
      ref: { kind: 'USER_INSTRUCTION', id: null },
      label: 'Orientações de redação do solicitante (não alteram as regras)',
      data: generation.instruction,
      optional: true,
    });
  }
  return parts;
}

/** Recusa de política no job: portão, POL-02 do solicitante (4xx) ou pré-requisito perdido. */
function isPolicyRefusal(error: unknown): boolean {
  if (error instanceof AiPolicyRevokedError) return true;
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

function textOf(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output ?? null);
}
