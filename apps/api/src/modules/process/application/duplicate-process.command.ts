import { ProcessDuplicated } from '@contrataflow/validation';
import type { DuplicateProcess, ProcessDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { CreateProcessCommand } from './create-process.command.js';
import { PROCESS_CLOCK, PROCESS_ITEM_REPOSITORY, PROCESS_TRANSACTIONS } from './ports.js';
import type { ProcessClock, ProcessItemRepository, ProcessTransactions } from './ports.js';
import { ProcessPanelReader } from './process-panel.queries.js';
import { processValidationError, recordProcessCreated } from './process.errors.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import { FilesFacade } from '../../files/application/files.facade.js';
import { duplicateItems } from '../domain/process-items.js';
import { draftIssues, duplicateDraft } from '../domain/process.js';
import type { Process } from '../domain/process.js';

export interface DuplicateProcessInput {
  /** Processo de origem (caminho do PRC-27). */
  readonly processId: string;
  readonly body: DuplicateProcess;
  /** `Idempotency-Key` da requisição (auditoria `process.create`/`process.duplicate`). */
  readonly idempotencyKey: string | null;
}

export interface DuplicatedProcess {
  readonly sourceProcessId: string;
  readonly process: Process;
  readonly dto: ProcessDto;
  readonly copyDocuments: boolean;
  readonly copyAttachments: boolean;
  readonly itemsCopied: number;
  readonly documentsCopied: number;
  readonly attachmentsCopied: number;
  /** Elegíveis que não puderam ser copiados (`process.duplicate_partial_copy`). */
  readonly skipped: number;
}

interface Prepared {
  readonly now: Date;
}

/** V-05: o `PROCESS_CREATE` não cobre o setor solicitante do novo processo. */
const CREATE_DENIED = 'Você não pode abrir processos para este setor.';

/**
 * `DuplicateProcessCommand` — PRC-27 (US-011 · DEC-033). O `PROCESS_DUPLICATE` cobrindo a origem já
 * foi conferido pelo guard (origem não visível = 404). Numa única transação: relê a origem visível
 * (DEC-024), monta o rascunho copiado (RN-PROC-118/119) com os ajustes do diálogo e o submete às
 * regras da criação; o `CreateProcessCommand` faz o resto como na US-001 (referências ativas,
 * `PROCESS_CREATE` no setor final — RN-PROC-124 —, workflow re-resolvido para os NOVOS dados,
 * número próprio, passagem nº 1, custódia de quem duplica, `ProcessAccess`, `process.create` e
 * `ProcessCreated` com `duplicatedFromId`). Depois copia itens (sequência própria), documentos
 * estruturados como rascunho (`copyDocuments` — RN-PROC-120) e anexos por cópia lógica
 * (`copyAttachments` — RN-PROC-121), e registra `process.duplicate` e `ProcessDuplicated` na origem
 * (timeline nos dois processos). A origem não muda (RN-PROC-125). Qualquer falha desfaz tudo,
 * inclusive o número. Sem notificação.
 */
@Injectable()
export class DuplicateProcessCommand extends TransactionalCommandHandler<
  DuplicateProcessInput,
  Prepared,
  DuplicatedProcess
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    @Inject(PROCESS_ITEM_REPOSITORY) private readonly items: ProcessItemRepository,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly panel: ProcessPanelReader,
    private readonly creator: CreateProcessCommand,
    private readonly documents: DocumentFacade,
    private readonly files: FilesFacade,
  ) {
    super('process.duplicate', transactions);
  }

  protected prepare(): Promise<Prepared> {
    return Promise.resolve({ now: this.clock() });
  }

  protected async handle(
    tx: TenantTx,
    input: DuplicateProcessInput,
    { now }: Prepared,
  ): Promise<DuplicatedProcess> {
    const userId = requireRequestContext().actor.userId ?? '';
    const { body } = input;

    // 4 — origem visível ao usuário no mesmo `tx` (não visível = 404, como no guard).
    const source = (await this.panel.load(tx, input.processId)).rows.process;

    // RN-PROC-118/119/122 — rascunho copiado, sob as mesmas regras da criação.
    const context = await this.creator.creationContext(tx, now);
    const draft = duplicateDraft(source, body);
    const issues = draftIssues(draft, context);
    if (issues.length > 0) throw processValidationError(issues);

    const created = await this.creator.createIn(tx, draft, context, {
      idempotencyKey: input.idempotencyKey,
      duplicatedFromId: source.id,
      permissionDetail: CREATE_DENIED,
    });
    const target = created.process;

    // Itens com sequência própria (as etiquetas entram com o modelo `ProcessTag`).
    const items = duplicateItems(await this.items.listActive(tx, source.id), {
      tenantId: target.tenantId,
      processId: target.id,
      now,
      userId,
      newId,
    });
    for (const item of items) await this.items.insert(tx, item);

    const documents = body.copyDocuments
      ? await this.documents.copyStructuredAsDraftsIn(tx, {
          sourceProcessId: source.id,
          targetProcessId: target.id,
          idempotencyKey: input.idempotencyKey,
        })
      : { copied: new Map<string, string>(), skipped: 0 };
    const attachments = body.copyAttachments
      ? await this.files.copyLogicallyIn(tx, {
          sourceProcessId: source.id,
          targetProcessId: target.id,
          documents: documents.copied,
        })
      : { copied: 0, skipped: 0 };

    // Auditoria na origem e evento (timeline `PROCESS_DUPLICATED` projetada no mesmo `tx`).
    const options = { copyDocuments: body.copyDocuments, copyAttachments: body.copyAttachments };
    await this.audit.record(tx, {
      action: 'process.duplicate',
      entityType: 'Process',
      entityId: source.id,
      processId: source.id,
      changes: [{ path: 'newProcessId', old: null, new: target.id }],
      metadata: {
        ...options,
        newProcessCode: target.code,
        itemsCopied: items.length,
        documentsCopied: documents.copied.size,
        attachmentsCopied: attachments.copied,
        idempotencyKey: input.idempotencyKey,
      },
    });
    await this.outbox.record(
      tx,
      ProcessDuplicated.of({
        aggregateId: source.id,
        processId: source.id,
        payload: { sourceProcessId: source.id, newProcessId: target.id, options },
      }),
    );

    return {
      sourceProcessId: source.id,
      process: target,
      dto: created.dto,
      ...options,
      itemsCopied: items.length,
      documentsCopied: documents.copied.size,
      attachmentsCopied: attachments.copied,
      skipped: documents.skipped + attachments.skipped,
    };
  }

  protected override committed(result: DuplicatedProcess, durationMs: number): void {
    const context = requireRequestContext();
    recordProcessCreated(result.process.creationChannel, durationMs);
    const facts = {
      sourceProcessId: result.sourceProcessId,
      newProcessId: result.process.id,
      correlationId: context.correlationId,
    };
    if (result.skipped > 0) {
      this.logger.warn(
        { event: 'process.duplicate_partial_copy', ...facts, skipped: result.skipped },
        'process.duplicate_partial_copy',
      );
    }
    // Nunca logar título, objeto nem conteúdo dos documentos copiados (story · Logs).
    this.logger.log(
      {
        event: 'process.duplicated',
        ...facts,
        code: result.process.code,
        copyDocuments: result.copyDocuments,
        copyAttachments: result.copyAttachments,
        itemsCopied: result.itemsCopied,
        documentsCopied: result.documentsCopied,
        attachmentsCopied: result.attachmentsCopied,
        durationMs,
        tenantId: context.tenantId,
        userId: context.actor.userId,
      },
      'process.duplicated',
    );
  }
}
