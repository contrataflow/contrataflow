import { Injectable } from '@nestjs/common';

import { CollaborationFacade } from '#modules/collaboration/application/collaboration.facade.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { TimelineLookupSource } from '../application/ports.js';
import type { TimelineLookupRecords } from '../domain/timeline-lookups.js';

/**
 * Fonte `COMMENT` (US-071): texto puro do comentário (a timeline corta o trecho em 140 caracteres)
 * e se o alvo é documento `RESTRICTED` (entrada `BUDGET_RESTRICTED` — DEC-030). Pela fachada do
 * `collaboration`, no `tx` do caso de uso (RLS do tenant).
 */
@Injectable()
export class CommentLookupSource implements TimelineLookupSource<'COMMENT'> {
  readonly kind = 'COMMENT';

  constructor(private readonly collaboration: CollaborationFacade) {}

  async lookup(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, TimelineLookupRecords['COMMENT']>> {
    const labels = await this.collaboration.commentLabels(tx, ids);
    return new Map(
      [...labels].map(([id, label]) => [
        id,
        { excerpt: label.excerpt, restricted: label.restricted },
      ]),
    );
  }
}
