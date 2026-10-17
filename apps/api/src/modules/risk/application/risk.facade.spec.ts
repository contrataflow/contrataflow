import { describe, expect, it } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';

import { RiskFacade } from './risk.facade.js';
import { createRisk } from '../domain/risk.js';
import { InMemoryRiskRepository } from '../infrastructure/in-memory-risk.repository.js';

const TENANT = '0192d033-0000-7000-8000-00000000000a';
const PROCESS = '0192d033-0000-7000-8000-0000000000b1';
const RISK = '0192d033-0000-7000-8000-0000000000c1';

describe('RiskFacade', () => {
  it('riskLabels: código e título, inclusive de risco excluído; ids de outro tenant ficam fora', async () => {
    const repository = new InMemoryRiskRepository();
    const facade = new RiskFacade(repository);
    const labels = await runWithRequestContext(
      { correlationId: 'c-1', ip: '127.0.0.1', userAgent: 'vitest' },
      () => {
        updateRequestContext({ tenantId: TENANT });
        return runSimulatedTransaction(async (tx) => {
          const risk = createRisk(
            {
              title: 'Atraso na entrega',
              description: null,
              categoryId: '0192d033-0000-7000-8000-0000000000d1',
              phase: 'PLANNING',
              cause: 'Fornecedor com baixa capacidade',
              consequence: 'Paralisação da obra',
              probability: 4,
              impact: 4,
              ownerId: null,
              ownerDepartmentId: null,
            },
            {
              id: RISK,
              tenantId: TENANT,
              processId: PROCESS,
              code: 'R01',
              snapshot: {
                scale: { max: 5, probabilityLabels: [], impactLabels: [] },
                levelThresholds: [{ level: 'HIGH', minScore: 1, maxScore: 25 }],
              },
              now: new Date(),
              userId: null,
            },
          );
          await repository.insert(tx, risk);
          await repository.softDelete(tx, risk, 1, { at: new Date(), userId: null });
          return facade.riskLabels(tx, [RISK, '0192d033-0000-7000-8000-0000000000ff']);
        });
      },
    );
    expect([...labels]).toEqual([[RISK, { code: 'R01', title: 'Atraso na entrega' }]]);
  });
});
