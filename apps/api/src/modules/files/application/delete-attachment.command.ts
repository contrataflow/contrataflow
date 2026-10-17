import { createHash } from 'node:crypto';

import { AttachmentDeleted } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { AttachmentTargetRegistry } from '#shared/files/attachment-targets.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { AttachmentAccess, actorUserId, attachmentNotFound } from './attachment-access.js';
import type { AttachmentProcess } from './attachment-access.js';
import { ATTACHMENT_REPOSITORY, FILES_CLOCK, FILES_TRANSACTIONS } from './files-ports.js';
import type { AttachmentRepository, FilesClock, FilesTransactions } from './files-ports.js';
import { deleteAttachment } from '../domain/attachment.js';
import type { Attachment } from '../domain/attachment.js';

/*
 * ATT-06 — Excluir anexo (US-068 · RN-DOC-79 · DEC-034), numa transação:
 *
 *   anexo visível (404) → `If-Match` (412) → quem pode: `ATTACHMENT_DELETE` cobrindo o processo
 *   (qualquer anexo) OU o próprio uploader com `ATTACHMENT_UPLOAD` enquanto o alvo é editável
 *   (FA-07) → só `AVAILABLE` (409 `ATTACHMENT_NOT_AVAILABLE`: em verificação ou rejeitado) →
 *   exclusão lógica com motivo → auditoria `attachment.delete` (motivo como hash + tamanho) →
 *   `AttachmentDeleted` (timeline `ATTACHMENT_REMOVED`).
 *
 * O binário fica retido conforme a política de retenção (PEND-07).
 */

export interface DeleteAttachmentInput {
  readonly id: string;
  readonly deletionReason: string;
  readonly expectedVersion: number;
}

@Injectable()
export class DeleteAttachmentCommand extends TransactionalCommandHandler<
  DeleteAttachmentInput,
  null,
  Attachment
> {
  constructor(
    @Inject(FILES_TRANSACTIONS) transactions: FilesTransactions,
    @Inject(ATTACHMENT_REPOSITORY) private readonly attachments: AttachmentRepository,
    @Inject(FILES_CLOCK) private readonly clock: FilesClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly access: AttachmentAccess,
    private readonly targets: AttachmentTargetRegistry,
  ) {
    super('attachment.delete', transactions);
  }

  protected prepare(): Promise<null> {
    return Promise.resolve(null);
  }

  protected async handle(tx: TenantTx, input: DeleteAttachmentInput): Promise<Attachment> {
    const userId = actorUserId();
    const scope = await this.access.visible(tx, await this.attachments.findById(tx, input.id));
    const current = scope.attachment;
    if (current.version !== input.expectedVersion) {
      throw new VersionConflictError({
        aggregateType: 'Attachment',
        aggregateId: current.id,
        expectedVersion: input.expectedVersion,
      });
    }
    await this.authorize(tx, current, scope, userId);
    if (current.status !== 'AVAILABLE') {
      throw new ApiError('ATTACHMENT_NOT_AVAILABLE', {
        detail:
          current.status === 'INFECTED' || current.status === 'REJECTED'
            ? 'O arquivo foi rejeitado pela verificação e não está na lista de anexos.'
            : 'Aguarde a verificação de segurança do arquivo terminar.',
        extensions: { status: current.status },
      });
    }

    const next = deleteAttachment(current, input.deletionReason, this.clock(), userId);
    if (!(await this.attachments.update(tx, next, current.version))) {
      throw new VersionConflictError({
        aggregateType: 'Attachment',
        aggregateId: current.id,
        expectedVersion: input.expectedVersion,
      });
    }
    await this.audit.record(tx, {
      action: 'attachment.delete',
      entityType: 'Attachment',
      entityId: next.id,
      processId: next.processId,
      metadata: {
        attachmentId: next.id,
        // O texto do motivo pode ter dado pessoal: só hash e tamanho (api/12 ATT-06).
        deletionReason: {
          sha256: createHash('sha256').update(input.deletionReason).digest('hex'),
          length: input.deletionReason.length,
        },
        ownAttachment: current.uploadedById === userId,
      },
    });
    await this.outbox.record(
      tx,
      AttachmentDeleted.of({
        aggregateId: next.id,
        processId: next.processId,
        payload: { attachmentId: next.id, hasReason: true },
      }),
    );
    return next;
  }

  /** FA-07: anexo de terceiro exige `ATTACHMENT_DELETE`; o próprio, alvo ainda editável. */
  private async authorize(
    tx: TenantTx,
    attachment: Attachment,
    scope: AttachmentProcess,
    userId: string,
  ): Promise<void> {
    if (await this.access.can('ATTACHMENT_DELETE', scope)) {
      await this.access.assert('ATTACHMENT_DELETE', scope);
      return;
    }
    if (attachment.uploadedById !== userId || attachment.targetId === null) {
      await this.access.assert(
        'ATTACHMENT_DELETE',
        scope,
        'Você não tem permissão para excluir anexos de outras pessoas.',
      );
      return;
    }
    await this.access.assert('ATTACHMENT_UPLOAD', scope);
    const target = await this.targets.load(tx, {
      targetType: attachment.targetType,
      targetId: attachment.targetId,
    });
    if (target === null) throw attachmentNotFound();
    await this.targets.assertAttachable(tx, target);
  }
}
