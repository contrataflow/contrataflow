import { Injectable } from '@nestjs/common';

import { FilesFacade } from '#modules/files/application/files.facade.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { TimelineLookupSource } from '../application/ports.js';
import type { TimelineLookupRecords } from '../domain/timeline-lookups.js';

/**
 * Fonte `ATTACHMENT` (US-068 · RN-TML-04): nome do arquivo e tipo do alvo, congelados na entrada
 * `ATTACHMENT_REMOVED`. Pela fachada do `files`, no `tx` do caso de uso (RLS do tenant).
 */
@Injectable()
export class AttachmentLookupSource implements TimelineLookupSource<'ATTACHMENT'> {
  readonly kind = 'ATTACHMENT';

  constructor(private readonly files: FilesFacade) {}

  lookup(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, TimelineLookupRecords['ATTACHMENT']>> {
    return this.files.attachmentLabels(tx, ids);
  }
}
