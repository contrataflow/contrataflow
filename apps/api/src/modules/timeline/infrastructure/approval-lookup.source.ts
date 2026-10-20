import { Injectable } from '@nestjs/common';

import { ApprovalFacade } from '#modules/approval/application/approval.facade.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { TimelineLookupSource } from '../application/ports.js';
import type { TimelineLookupRecords } from '../domain/timeline-lookups.js';

/**
 * Fonte `APPROVAL` (US-009): título congelado da aprovação de `APPROVAL_CANCELED` ("Aprovação da
 * autoridade cancelada"), pela fachada do `approval`, no `tx` do caso de uso (RLS do tenant).
 */
@Injectable()
export class ApprovalLookupSource implements TimelineLookupSource<'APPROVAL'> {
  readonly kind = 'APPROVAL';

  constructor(private readonly approvals: ApprovalFacade) {}

  async lookup(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, TimelineLookupRecords['APPROVAL']>> {
    const summaries = await this.approvals.approvalSummaries(tx, ids);
    return new Map([...summaries].map(([id, summary]) => [id, { title: summary.title }]));
  }
}
