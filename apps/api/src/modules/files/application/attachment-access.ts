import { Injectable, Logger } from '@nestjs/common';

import { ProcessAccessRegistry, isProcessVisible } from '#shared/auth/process-access.js';
import type { ProcessAccessTarget } from '#shared/auth/process-access.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { AttachmentTargetRegistry } from '#shared/files/attachment-targets.js';

import { AccessFacade } from '../../access/application/access.facade.js';
import type { Attachment } from '../domain/attachment.js';

/*
 * Visibilidade e permissões sobre um anexo já gravado (US-068 · DEC-024): o anexo segue o processo
 * dele — processo invisível = 404 igual ao inexistente. Anexo de ativo do tenant (sem processo)
 * vale no tenant inteiro.
 */

export interface AttachmentProcess {
  readonly process: ProcessAccessTarget | null;
}

export interface VisibleAttachment extends AttachmentProcess {
  readonly attachment: Attachment;
}

export function attachmentNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: 'Anexo não encontrado.' });
}

export const CONFIDENTIAL_ATTACHMENT_MESSAGE = 'Você não tem permissão para baixar este arquivo.';

export function actorUserId(): string {
  const userId = requireRequestContext().actor.userId;
  if (userId === null) throw new ApiError('UNAUTHENTICATED');
  return userId;
}

@Injectable()
export class AttachmentAccess {
  private readonly logger = new Logger('Attachments');

  constructor(
    private readonly processes: ProcessAccessRegistry,
    private readonly access: AccessFacade,
    private readonly targets: AttachmentTargetRegistry,
  ) {}

  /** Anexo não excluído e visível ao usuário da requisição; senão 404. */
  async visible(tx: TenantTx, attachment: Attachment | null): Promise<VisibleAttachment> {
    if (attachment === null || attachment.status === 'DELETED') throw attachmentNotFound();
    if (attachment.processId === null) return { attachment, process: null };
    const process = await this.processes.load(tx, attachment.processId);
    if (
      process === null ||
      !isProcessVisible(await this.access.processVisibilityScope(), process)
    ) {
      throw attachmentNotFound();
    }
    return { attachment, process };
  }

  /**
   * `visible` + POL-09 sobre o alvo sigiloso (US-069 · RN-DOC-86): alvo `RESTRICTED` sem
   * `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo → 403 `PERMISSION_DENIED`
   * (`reasonCode = POL-09`) — o arquivo não é mascarado, é bloqueado. Alvo sumido = 404.
   */
  async viewable(tx: TenantTx, attachment: Attachment | null): Promise<VisibleAttachment> {
    const visible = await this.visible(tx, attachment);
    const { attachment: found } = visible;
    // Ativo do tenant (sem processo) não tem alvo sigiloso: vale no tenant inteiro.
    if (found.targetId === null || found.processId === null) return visible;
    const confidentiality = await this.targets.confidentiality(tx, {
      targetType: found.targetType,
      targetId: found.targetId,
    });
    if (confidentiality === null) throw attachmentNotFound();
    if (confidentiality.restricted && !confidentiality.allowed) {
      this.logger.warn(
        {
          event: 'attachment.download_denied_confidential',
          attachmentId: found.id,
          processId: found.processId,
          correlationId: requireRequestContext().correlationId,
        },
        'attachment.download_denied_confidential',
      );
      throw new ApiError('PERMISSION_DENIED', {
        detail: CONFIDENTIAL_ATTACHMENT_MESSAGE,
        auditReasonCode: 'POL-09',
        extensions: { reasonCode: 'POL-09' },
      });
    }
    return visible;
  }

  /** A permissão cobre o processo do anexo (sem auditoria) — decisão entre caminhos. */
  async can(permission: 'ATTACHMENT_UPLOAD' | 'ATTACHMENT_DELETE', target: AttachmentProcess) {
    return target.process === null
      ? this.access.can(permission)
      : await this.access.canOnProcess(permission, target.process);
  }

  /** Exige a permissão sobre o processo do anexo (403 auditado como `access.denied`). */
  async assert(
    permission: 'ATTACHMENT_UPLOAD' | 'ATTACHMENT_DELETE',
    target: AttachmentProcess,
    detail?: string,
  ): Promise<void> {
    if (target.process === null) {
      this.access.assertCan(permission, { mfaPolicy: 'NONE' });
      return;
    }
    await this.access.assertCanOnProcess(permission, target.process, detail);
  }
}
