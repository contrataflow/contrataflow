import { AttachmentRejected } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { JOB_QUEUE } from '#shared/jobs/job-queue.js';
import type { JobQueuePort } from '#shared/jobs/job-queue.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';
import { StorageService } from '#shared/storage/storage.service.js';

import { AttachmentAccess, actorUserId } from './attachment-access.js';
import {
  ATTACHMENT_REPOSITORY,
  FILES_CLOCK,
  FILES_SETTINGS,
  FILES_TRANSACTIONS,
} from './files-ports.js';
import type {
  AttachmentRepository,
  FilesClock,
  FilesSettings,
  FilesTransactions,
} from './files-ports.js';
import { storageUnavailable } from './files.errors.js';
import { FILE_SCAN_JOB, FILE_SCAN_QUEUE } from './scan-file.job.js';
import { confirmUpload, reasonCodeOf } from '../domain/attachment.js';
import type { Attachment } from '../domain/attachment.js';

/*
 * ATT-03 — Confirmar upload (US-068 · RN-DOC-73 · padrão B de queues.md §3):
 *
 *   prepare (fora da transação): o anexo é do usuário (403) e, se ainda `PENDING_UPLOAD`, `HEAD` na
 *     quarentena — ausente → 409 `UPLOAD_NOT_RECEIVED` (nada gravado).
 *   handle (UMA transação): tamanho igual ao declarado → `UPLOADED`; divergente → `REJECTED`
 *     (`SIZE_MISMATCH`, sem varredura) + `AttachmentRejected`; auditoria `attachment.confirm`.
 *   depois do commit: `UPLOADED` → enfileira `file-scan` com `jobId = attachmentId`. Fila fora → o
 *     anexo fica `UPLOADED` e o reconciliador reenfileira; a resposta continua 202.
 *
 * Confirmar de novo um anexo que já saiu de `PENDING_UPLOAD` devolve o estado atual, sem efeito
 * (storage.md §5.3) — e reenfileira se ainda `UPLOADED` (o `jobId` deduplica).
 */

export interface ConfirmAttachmentUploadInput {
  readonly id: string;
  readonly idempotencyKey: string | null;
}

export interface ConfirmAttachmentUploadResult {
  readonly attachment: Attachment;
}

interface Prepared {
  /** Tamanho do objeto na quarentena; `null` = não há o que confirmar (estado já avançou). */
  readonly objectSizeBytes: number | null;
}

@Injectable()
export class ConfirmAttachmentUploadCommand extends TransactionalCommandHandler<
  ConfirmAttachmentUploadInput,
  Prepared,
  ConfirmAttachmentUploadResult
> {
  constructor(
    @Inject(FILES_TRANSACTIONS) private readonly transactions: FilesTransactions,
    @Inject(ATTACHMENT_REPOSITORY) private readonly attachments: AttachmentRepository,
    @Inject(FILES_CLOCK) private readonly clock: FilesClock,
    @Inject(FILES_SETTINGS) private readonly settings: FilesSettings,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    @Inject(JOB_QUEUE) private readonly jobs: JobQueuePort,
    private readonly access: AttachmentAccess,
    private readonly storage: StorageService,
  ) {
    super('attachment.confirm', transactions);
  }

  override async execute(
    input: ConfirmAttachmentUploadInput,
  ): Promise<ConfirmAttachmentUploadResult> {
    const result = await super.execute(input);
    if (result.attachment.status === 'UPLOADED') await this.enqueue(result.attachment);
    return result;
  }

  protected async prepare(input: ConfirmAttachmentUploadInput): Promise<Prepared> {
    const attachment = await this.transactions.read((tx) => this.ownAttachment(tx, input.id));
    if (attachment.status !== 'PENDING_UPLOAD') return { objectSizeBytes: null };
    let head;
    try {
      head = await this.storage.head({ bucket: 'quarantine', key: attachment.quarantineKey ?? '' });
    } catch (error) {
      throw storageUnavailable(error);
    }
    if (head === null) {
      throw new ApiError('UPLOAD_NOT_RECEIVED', {
        detail: 'Não encontramos o arquivo enviado. Tente novamente.',
      });
    }
    return { objectSizeBytes: head.sizeBytes };
  }

  protected async handle(
    tx: TenantTx,
    input: ConfirmAttachmentUploadInput,
    prepared: Prepared,
  ): Promise<ConfirmAttachmentUploadResult> {
    const current = await this.ownAttachment(tx, input.id);
    if (current.status !== 'PENDING_UPLOAD' || prepared.objectSizeBytes === null) {
      return { attachment: current };
    }
    const userId = actorUserId();
    const next = confirmUpload(current, prepared.objectSizeBytes, this.clock(), userId);
    if (!(await this.attachments.update(tx, next, current.version))) {
      // Corrida com outra confirmação: o estado que venceu é a resposta (sem efeito).
      return { attachment: await this.ownAttachment(tx, input.id) };
    }
    const reasonCode = reasonCodeOf(next);
    await this.audit.record(tx, {
      action: 'attachment.confirm',
      entityType: 'Attachment',
      entityId: next.id,
      processId: next.processId,
      metadata: {
        attachmentId: next.id,
        status: next.status,
        ...(reasonCode === null ? {} : { reasonCode }),
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (next.status === 'REJECTED' && reasonCode !== null) {
      await this.outbox.record(
        tx,
        AttachmentRejected.of({
          aggregateId: next.id,
          processId: next.processId,
          payload: { attachmentId: next.id, status: 'REJECTED', reasonCode },
        }),
      );
    }
    return { attachment: next };
  }

  /** Anexo da intenção do PRÓPRIO usuário (ATT-03: "uploader"); excluído/visível conforme DEC-024. */
  private async ownAttachment(tx: TenantTx, id: string): Promise<Attachment> {
    const { attachment } = await this.access.visible(tx, await this.attachments.findById(tx, id));
    if (attachment.uploadedById !== actorUserId()) {
      throw new ApiError('PERMISSION_DENIED', {
        detail: 'Somente quem enviou o arquivo pode confirmar o envio.',
        auditReasonCode: 'ATTACHMENT_UPLOADER',
      });
    }
    return attachment;
  }

  /** Padrão B: depois do commit; falha da fila não desfaz a confirmação. */
  private async enqueue(attachment: Attachment): Promise<void> {
    try {
      await this.jobs.enqueue(
        FILE_SCAN_QUEUE,
        FILE_SCAN_JOB,
        { attachmentId: attachment.id },
        {
          jobId: attachment.id,
          attempts: this.settings.scanAttempts,
          backoffMs: this.settings.scanBackoffMs,
        },
      );
    } catch (error) {
      this.logger.warn(
        {
          event: 'attachment.enqueue_deferred',
          attachmentId: attachment.id,
          cause: error instanceof Error ? error.name : 'unknown',
          correlationId: requireRequestContext().correlationId,
        },
        'attachment.enqueue_deferred',
      );
    }
  }
}
