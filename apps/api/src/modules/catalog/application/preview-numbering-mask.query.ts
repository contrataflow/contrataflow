import type { NumberingPreview, NumberingPreviewResult } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';

import { CATALOG_TRANSACTIONS } from './catalog-ports.js';
import type { CatalogTransactions } from './catalog-ports.js';
import { logMaskInvalid, numberingMaskInvalid } from './numbering.errors.js';
import { NumberingFacade } from './numbering.facade.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { InvalidNumberMaskError } from '../domain/number-mask.js';

/**
 * `PreviewNumberingMaskQuery` — SET-04 (US-105 · fluxo principal, passos 2–3 · FA-04): exige
 * `SETTINGS_MANAGE` (+ MFA conforme `security.mfaPolicy` — POL-14), valida a máscara informada
 * (RN-TEN-67 → 422 `NUMBERING_MASK_INVALID`) e devolve o exemplo com o próximo valor hipotético, em
 * transação somente leitura — nada é gravado nem incrementado (RN-TEN-73).
 */
@Injectable()
export class PreviewNumberingMaskQuery {
  private readonly logger = new Logger('Numbering');

  constructor(
    private readonly numbering: NumberingFacade,
    @Inject(CATALOG_TRANSACTIONS) private readonly transactions: CatalogTransactions,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async execute(body: NumberingPreview): Promise<NumberingPreviewResult> {
    this.access.assertCan('SETTINGS_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
    try {
      return await this.transactions.read((tx) => this.numbering.preview(tx, body));
    } catch (error) {
      if (error instanceof InvalidNumberMaskError) {
        logMaskInvalid(this.logger, {
          mask: error.mask,
          problem: error.problem,
          correlationId: requireRequestContext().correlationId,
        });
        throw numberingMaskInvalid('mask', error.problem);
      }
      throw error;
    }
  }
}
