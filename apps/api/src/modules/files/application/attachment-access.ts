import { Injectable } from '@nestjs/common';

import { ProcessAccessRegistry, isProcessVisible } from '#shared/auth/process-access.js';
import type { ProcessAccessTarget } from '#shared/auth/process-access.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

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

export function actorUserId(): string {
  const userId = requireRequestContext().actor.userId;
  if (userId === null) throw new ApiError('UNAUTHENTICATED');
  return userId;
}

@Injectable()
export class AttachmentAccess {
  constructor(
    private readonly processes: ProcessAccessRegistry,
    private readonly access: AccessFacade,
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
