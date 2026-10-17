import { MAX_PAGE_SIZE } from '@contrataflow/validation';
import type { AttachmentDto, AttachmentListQuery } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { ProcessAccessRegistry, isProcessVisible } from '#shared/auth/process-access.js';
import { pageResult, pageWindow } from '#shared/http/pagination.js';
import type { PageResult } from '#shared/http/pagination.js';

import { attachmentNotFound } from './attachment-access.js';
import { toAttachmentDto } from './attachment.view.js';
import { ATTACHMENT_REPOSITORY, FILES_TRANSACTIONS } from './files-ports.js';
import type { AttachmentRepository, FilesTransactions } from './files-ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';

/**
 * ATT-01 — Listar anexos do processo (US-069 · RN-DOC-81 · DEC-024): processo inexistente, de outro
 * tenant ou não visível → 404 igual; os `DELETED` ficam de fora; filtros `targetType`/`targetId`/
 * `categoryId` e ordenação `-createdAt`. Só metadados (RN-DOC-82): a URL do arquivo existe apenas
 * em ATT-05, onde valem o estado `AVAILABLE` e a POL-09 do alvo sigiloso. Somente leitura — sem
 * auditoria nem eventos.
 */
@Injectable()
export class ListAttachmentsQuery {
  constructor(
    @Inject(FILES_TRANSACTIONS) private readonly transactions: FilesTransactions,
    @Inject(ATTACHMENT_REPOSITORY) private readonly attachments: AttachmentRepository,
    private readonly processes: ProcessAccessRegistry,
    private readonly access: AccessFacade,
  ) {}

  execute(processId: string, query: AttachmentListQuery): Promise<PageResult<AttachmentDto>> {
    return this.transactions.read(async (tx) => {
      const process = await this.processes.load(tx, processId);
      if (
        process === null ||
        !isProcessVisible(await this.access.processVisibilityScope(), process)
      ) {
        throw attachmentNotFound();
      }
      const window = pageWindow(query, MAX_PAGE_SIZE);
      const { items, total } = await this.attachments.listByProcess(
        tx,
        {
          processId,
          ...(query.targetType === undefined ? {} : { targetType: query.targetType }),
          ...(query.targetId === undefined ? {} : { targetId: query.targetId }),
          ...(query.categoryId === undefined ? {} : { categoryId: query.categoryId }),
        },
        window,
      );
      return pageResult(items.map(toAttachmentDto), window, total);
    });
  }
}
