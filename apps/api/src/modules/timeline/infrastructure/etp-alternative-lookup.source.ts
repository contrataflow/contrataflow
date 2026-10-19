import { Injectable } from '@nestjs/common';

import { EtpFacade } from '#modules/etp/application/etp.facade.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { TimelineLookupSource } from '../application/ports.js';
import type { TimelineLookupRecords } from '../domain/timeline-lookups.js';

/**
 * Fonte `ETP_ALTERNATIVE` (US-021): nome da alternativa recomendada, congelado na entrada
 * `ETP_ALTERNATIVE_RECOMMENDED` (RN-TML-04). Pela fachada do `etp`, no `tx` do caso de uso.
 */
@Injectable()
export class EtpAlternativeLookupSource implements TimelineLookupSource<'ETP_ALTERNATIVE'> {
  readonly kind = 'ETP_ALTERNATIVE';

  constructor(private readonly etps: EtpFacade) {}

  lookup(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, TimelineLookupRecords['ETP_ALTERNATIVE']>> {
    return this.etps.alternativeNames(tx, ids);
  }
}
