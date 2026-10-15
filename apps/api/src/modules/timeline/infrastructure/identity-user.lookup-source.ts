import { Injectable } from '@nestjs/common';

import { IdentityFacade } from '#modules/identity/application/identity.facade.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { TimelineLookupSource } from '../application/ports.js';
import type { TimelineLookupRecords } from '../domain/timeline-lookups.js';

/**
 * Fonte `USER` dos nomes congelados (RN-TML-04): nome exibido pela fachada do `identity`, só de
 * usuários com vínculo no tenant da transação.
 */
@Injectable()
export class IdentityUserLookupSource implements TimelineLookupSource<'USER'> {
  readonly kind = 'USER';

  constructor(private readonly identity: IdentityFacade) {}

  async lookup(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, TimelineLookupRecords['USER']>> {
    const names = await this.identity.userDisplayNames(tx, ids);
    return new Map([...names].map(([id, name]) => [id, { name }]));
  }
}
