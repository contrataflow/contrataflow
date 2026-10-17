import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { ATTACHMENT_REPOSITORY } from './files-ports.js';
import type { AttachmentRepository } from './files-ports.js';

/** Rótulo congelado de um anexo (timeline `ATTACHMENT_REMOVED` — RN-TML-04). */
export interface AttachmentLabel {
  readonly fileName: string;
  readonly targetType: string;
}

/**
 * API pública do módulo `files` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório.
 */
@Injectable()
export class FilesFacade {
  constructor(@Inject(ATTACHMENT_REPOSITORY) private readonly attachments: AttachmentRepository) {}

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
