import { Inject, Injectable } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { ATTACHMENT_REPOSITORY, FILES_CLOCK } from './files-ports.js';
import type { AttachmentRepository, FilesClock } from './files-ports.js';
import { logicalCopy } from '../domain/attachment.js';
import type { LogicalCopyTarget } from '../domain/attachment.js';

/** Rótulo congelado de um anexo (timeline `ATTACHMENT_REMOVED` — RN-TML-04). */
export interface AttachmentLabel {
  readonly fileName: string;
  readonly targetType: string;
}

/** Resultado da cópia lógica dos anexos na duplicação (US-011). */
export interface AttachmentCopies {
  readonly copied: number;
  /** Elegíveis cujo alvo não foi copiado (anexo de documento não copiado). */
  readonly skipped: number;
}

/**
 * API pública do módulo `files` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório.
 */
@Injectable()
export class FilesFacade {
  constructor(
    @Inject(ATTACHMENT_REPOSITORY) private readonly attachments: AttachmentRepository,
    @Inject(FILES_CLOCK) private readonly clock: FilesClock,
  ) {}

  /**
   * Duplicação do processo com `copyAttachments` (US-011 · RN-PROC-121 · DEC-033): cópia lógica de
   * cada anexo `AVAILABLE` do processo de origem — os do próprio processo e, quando o documento foi
   * copiado (`documents`: origem → novo), os do documento, religados ao novo. Anexos de versões,
   * comentários, tramitações e demais alvos nunca são copiados; anexo de documento não copiado
   * conta em `skipped`. No `tx` de quem chama.
   */
  async copyLogicallyIn(
    tx: TenantTx,
    input: {
      readonly sourceProcessId: string;
      readonly targetProcessId: string;
      readonly documents: ReadonlyMap<string, string>;
    },
  ): Promise<AttachmentCopies> {
    const userId = requireRequestContext().actor.userId;
    if (userId === null) throw new ApiError('UNAUTHENTICATED');
    const now = this.clock();
    let copied = 0;
    let skipped = 0;
    for (const source of await this.attachments.listAvailableByProcess(tx, input.sourceProcessId)) {
      let target: Pick<LogicalCopyTarget, 'targetType' | 'targetId'> | null = null;
      if (source.targetType === 'PROCESS') {
        target = { targetType: 'PROCESS', targetId: input.targetProcessId };
      } else if (source.targetType === 'DOCUMENT') {
        const documentId =
          source.targetId === null ? undefined : input.documents.get(source.targetId);
        if (documentId === undefined) {
          skipped += 1;
          continue;
        }
        target = { targetType: 'DOCUMENT', targetId: documentId };
      }
      if (target === null) continue;
      await this.attachments.insert(
        tx,
        logicalCopy(source, {
          id: newId(),
          processId: input.targetProcessId,
          ...target,
          userId,
          now,
        }),
      );
      copied += 1;
    }
    return { copied, skipped };
  }

  /** Nome e tipo de alvo dos anexos, em lote, no `tx` do chamador (RLS do tenant). */
  async attachmentLabels(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, AttachmentLabel>> {
    const rows = await this.attachments.findByIds(tx, ids);
    return new Map(
      rows.map((row) => [row.id, { fileName: row.fileName, targetType: row.targetType }]),
    );
  }
}
