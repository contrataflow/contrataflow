import { InMemoryPriceResearchRepository } from '#modules/price-research/infrastructure/price-research.repositories.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { TestApi } from './api-test-app.js';
import type { PriceResearch } from '../../src/modules/price-research/domain/price-research.js';

/*
 * Pesquisa de preços em memória para os testes de outros módulos (US-036: o valor estimado do TR).
 * O documento da pesquisa é semeado à parte (`document-fixtures`); a conclusão é da US-032.
 */

export function seedPriceResearch(
  api: TestApi,
  research: Pick<PriceResearch, 'id' | 'tenantId' | 'processId' | 'totalEstimatedValue'> & {
    readonly completedAt: Date | null;
    readonly now: Date;
  },
): void {
  void api.app.get(InMemoryPriceResearchRepository, { strict: false }).insert({} as TenantTx, {
    id: research.id,
    tenantId: research.tenantId,
    processId: research.processId,
    documentId: research.id,
    referenceDate: '2026-10-01',
    parameters: {
      defaultMethod: 'AUTO_CV',
      cvThresholdPercent: '25.0000',
      minQuotations: 3,
      directQuoteMaxAgeDays: 180,
      similarContractMaxAgeDays: 365,
      outlierLowerPercent: '70.0000',
      outlierUpperPercent: '130.0000',
      unitPriceDecimals: 2,
      roundingMode: 'HALF_UP',
    },
    totalEstimatedValue: research.totalEstimatedValue,
    itemsCount: 1,
    itemsWithAlertsCount: 0,
    lastCalculatedAt: research.now,
    completedAt: research.completedAt,
    completedById: null,
    createdAt: research.now,
    updatedAt: research.now,
    createdById: null,
    updatedById: null,
    version: 1,
  });
}
