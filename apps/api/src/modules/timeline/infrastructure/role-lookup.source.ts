import { Injectable } from '@nestjs/common';

import { AccessFacade } from '#modules/access/application/access.facade.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { TimelineLookupSource } from '../application/ports.js';
import type { TimelineLookupRecords } from '../domain/timeline-lookups.js';

/**
 * Fonte `ROLE` (US-051): nome do perfil aprovador de `APPROVAL_REQUESTED` ("Aprovação solicitada a
 * Autoridade competente"), pela fachada do `access`, no `tx` do caso de uso (RLS do tenant).
 */
@Injectable()
export class RoleLookupSource implements TimelineLookupSource<'ROLE'> {
  readonly kind = 'ROLE';

  constructor(private readonly access: AccessFacade) {}

  async lookup(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, TimelineLookupRecords['ROLE']>> {
    const roles = await this.access.roleSummaries(tx, ids);
    return new Map([...roles].map(([id, role]) => [id, { name: role.name }]));
  }
}
