import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { COMMENT_REPOSITORY } from './ports.js';
import type { CommentRepository } from './ports.js';
import { DocumentFacade } from '../../document/application/document.facade.js';

/** O comentário como a timeline o congela (fonte `COMMENT` — RN-CMT-15). */
export interface CommentTimelineLabel {
  /** Texto puro (a timeline corta em 140 caracteres). */
  readonly excerpt: string;
  /** Alvo em documento `RESTRICTED` (DEC-030): a entrada fica `BUDGET_RESTRICTED`. */
  readonly restricted: boolean;
  /** Excluído pelo autor ou por moderação: a leitura da timeline suprime o trecho. */
  readonly isDeleted: boolean;
}

/**
 * API pública do módulo `collaboration` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório. US-071: o trecho e o sigilo dos comentários para a timeline
 * (`COMMENT_ADDED`), no `tx` do chamador.
 */
@Injectable()
export class CollaborationFacade {
  constructor(
    @Inject(COMMENT_REPOSITORY) private readonly comments: CommentRepository,
    private readonly documents: DocumentFacade,
  ) {}

  async commentLabels(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<Map<string, CommentTimelineLabel>> {
    if (ids.length === 0) return new Map();
    const excerpts = await this.comments.excerpts(tx, ids);
    const documentIds = [
      ...new Set([...excerpts.values()].flatMap((row) => (row.documentId ? [row.documentId] : []))),
    ];
    const documents =
      documentIds.length > 0
        ? await this.documents.commentDocumentLabels(tx, documentIds)
        : new Map<string, never>();
    return new Map(
      [...excerpts].map(([id, row]) => [
        id,
        {
          excerpt: row.bodyText,
          restricted:
            row.documentId !== null &&
            documents.get(row.documentId)?.confidentiality === 'RESTRICTED',
          isDeleted: row.isDeleted,
        },
      ]),
    );
  }
}
