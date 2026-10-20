import { localDateOf } from '@contrataflow/types';
import { DFD_MESSAGES } from '@contrataflow/validation';
import type { DfdDto, DfdDuplicateTarget, DfdMeta } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import { DfdDocumentCreator } from './dfd-document.creator.js';
import type { CreateDfdDocumentInput } from './dfd-document.creator.js';
import { toDfdDto, toDfdMeta } from './dfd.presenter.js';
import { dfdNotFound } from './dfd.queries.js';
import { DFD_CLOCK, DFD_REPOSITORY, DFD_TRANSACTIONS } from './ports.js';
import type { DfdClock, DfdRepository, DfdTransactions } from './ports.js';
import { NumberingFacade } from '../../catalog/application/numbering.facade.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import type { CreatedStructuredDocument } from '../../document/application/document.facade.js';
import { ProcessFacade } from '../../process/application/process.facade.js';
import { duplicateDfd } from '../domain/dfd.js';

/*
 * DFD-05 — Duplicar DFD (US-018 · fluxo principal 4): UMA transação do tenant. Destino "novo
 * processo" (RN-DFD-74): o processo nasce pela mecânica da duplicação do processo (US-011), com
 * `PROCESS_CREATE`, e os itens da origem renumerados; destino "processo existente" (RN-DFD-73/75):
 * o documento tipado confere `DFD_CREATE`, custódia, status, etapa e o DFD ativo único, e os itens
 * do DFD viram `ProcessItem` no destino. Em seguida o `Document`/`Dfd` em `DRAFT` com o conteúdo
 * das seções copiado, `sourceDocumentId` e os itens remapeados (RN-DFD-76..78). Qualquer falha
 * desfaz tudo, inclusive o número. Não notifica (RN-DFD-22). Logs sem textos nem valores.
 */

let duplicatedCounter: Counter | undefined;

/** `dfd_duplicated_total` (DFD-05). */
function countDuplicated(targetType: DfdDuplicateTarget): void {
  duplicatedCounter ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('dfd_duplicated_total', { description: 'DFDs duplicados (DFD-05).' });
  duplicatedCounter.add(1, { targetType });
}

export interface DuplicateDfdInput {
  readonly dfdId: string;
  readonly targetType: DfdDuplicateTarget;
  readonly targetProcessId: string | null;
  readonly idempotencyKey: string | null;
}

export interface DuplicatedDfd {
  readonly dto: DfdDto;
  readonly meta: DfdMeta;
  readonly sourceDocumentId: string;
  readonly processId: string;
  readonly targetType: DfdDuplicateTarget;
  readonly itemsCloned: number;
}

interface Prepared {
  readonly now: Date;
}

/** V-03: o processo destino não existe neste tenant (ou não é visível) — `REFERENCE_NOT_FOUND`. */
function targetNotFound(): ApiError {
  return validationError([
    {
      field: 'targetProcessId',
      code: 'REFERENCE_NOT_FOUND',
      message: DFD_MESSAGES.duplicateTargetInvalid,
    },
  ]);
}

@Injectable()
export class DuplicateDfdCommand extends TransactionalCommandHandler<
  DuplicateDfdInput,
  Prepared,
  DuplicatedDfd
> {
  constructor(
    @Inject(DFD_TRANSACTIONS) transactions: DfdTransactions,
    @Inject(DFD_REPOSITORY) private readonly dfds: DfdRepository,
    @Inject(DFD_CLOCK) private readonly clock: DfdClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    private readonly documents: DocumentFacade,
    private readonly documentCreator: DfdDocumentCreator,
    private readonly processes: ProcessFacade,
    private readonly numbering: NumberingFacade,
  ) {
    super('dfd.duplicate', transactions);
  }

  protected prepare(): Promise<Prepared> {
    return Promise.resolve({ now: this.clock() });
  }

  protected async handle(
    tx: TenantTx,
    input: DuplicateDfdInput,
    { now }: Prepared,
  ): Promise<DuplicatedDfd> {
    // Origem visível ao usuário (DEC-024); inexistente, de outro tenant ou não visível = 404.
    const source = await this.dfds.findById(tx, input.dfdId);
    if (source === null) throw dfdNotFound();
    const sourceView = await this.documents.typedDocumentIn(tx, source.documentId);
    if (sourceView === null) throw dfdNotFound();
    const sourceRows = [...(await this.documents.documentItemsIn(tx, source.documentId))].sort(
      (a, b) => a.sortOrder - b.sortOrder,
    );

    const target = await this.prepareTarget(tx, input, sourceView.processId);
    const created = await this.createDocument(tx, input, target.processId, {
      documentId: source.documentId,
      draftContent: sourceView.document.draftContent,
    });
    const { document, process } = created;

    // RN-DFD-75: no processo existente, cada item do DFD vira um item do processo.
    const itemMap =
      target.itemMap ??
      (await this.processes.cloneItemsForDfdIn(tx, {
        sourceProcessId: sourceView.processId,
        targetProcessId: process.id,
        sourceItemIds: sourceRows.map((row) => row.processItemId),
      }));
    const lines = sourceRows.flatMap((row) => {
      const processItemId = itemMap.get(row.processItemId);
      return processItemId === undefined
        ? []
        : [{ processItemId, quantity: row.quantity, notes: row.notes }];
    });
    const itemsCloned = await this.documents.copyItemsIn(tx, document, lines);

    const { timezone } = await this.numbering.settingsOf(tx);
    const dfd = duplicateDfd(source, {
      documentId: document.id,
      tenantId: document.tenantId,
      processId: process.id,
      requestingDepartmentId: process.requestingDepartmentId,
      creatorId: document.createdById,
      today: localDateOf(now, timezone),
      now,
      // POL-09: o valor de processo com orçamento sigiloso não migra para outro processo.
      copyEstimatedValue: !sourceView.isBudgetConfidential,
    });
    await this.dfds.insert(tx, dfd);

    await this.audit.record(tx, {
      action: 'document.duplicate',
      entityType: 'Document',
      entityId: document.id,
      processId: process.id,
      metadata: {
        sourceDocumentId: source.documentId,
        sourceProcessId: sourceView.processId,
        targetProcessId: process.id,
        targetType: input.targetType,
        itemsCloned,
        code: document.code,
        idempotencyKey: input.idempotencyKey,
      },
    });

    // O mesmo recorte do DFD-03: sigilo da estimativa e ações permitidas do usuário no destino.
    const view = await this.documents.typedDocumentIn(tx, document.id);
    return {
      dto: toDfdDto(dfd, document, {
        masked: view !== null && view.isBudgetConfidential && !view.canViewConfidentialBudget,
      }),
      meta: toDfdMeta(view?.template ?? created.template, view?.allowedActions ?? []),
      sourceDocumentId: source.documentId,
      processId: process.id,
      targetType: input.targetType,
      itemsCloned,
    };
  }

  /** "Novo processo" cria o processo e os itens agora; "existente" só confirma o id do destino. */
  private async prepareTarget(
    tx: TenantTx,
    input: DuplicateDfdInput,
    sourceProcessId: string,
  ): Promise<{ processId: string; itemMap: ReadonlyMap<string, string> | null }> {
    if (input.targetType === 'EXISTING_PROCESS') {
      if (input.targetProcessId === null) throw targetNotFound();
      return { processId: input.targetProcessId, itemMap: null };
    }
    const created = await this.processes.createProcessForDfdIn(tx, {
      sourceProcessId,
      idempotencyKey: input.idempotencyKey,
      permissionDetail: DFD_MESSAGES.duplicatePermissionDenied,
    });
    return { processId: created.processId, itemMap: created.itemMap };
  }

  private async createDocument(
    tx: TenantTx,
    input: DuplicateDfdInput,
    processId: string,
    source: NonNullable<CreateDfdDocumentInput['source']>,
  ): Promise<CreatedStructuredDocument> {
    try {
      return await this.documentCreator.create(tx, {
        processId,
        templateId: null,
        idempotencyKey: input.idempotencyKey,
        source,
      });
    } catch (error) {
      // Processo destino de outro tenant, inexistente ou não visível (V-03).
      const missing = error instanceof ApiError && error.code === 'NOT_FOUND';
      if (missing && input.targetType === 'EXISTING_PROCESS') throw targetNotFound();
      throw error;
    }
  }

  protected override committed(result: DuplicatedDfd, durationMs: number): void {
    countDuplicated(result.targetType);
    const context = requireRequestContext();
    this.logger.log(
      {
        event: 'dfd.duplicated',
        sourceDocumentId: result.sourceDocumentId,
        newDocumentId: result.dto.documentId,
        processId: result.processId,
        targetType: result.targetType,
        itemsCloned: result.itemsCloned,
        durationMs,
        tenantId: context.tenantId,
        userId: context.actor.userId,
        correlationId: context.correlationId,
      },
      'dfd.duplicated',
    );
  }
}
