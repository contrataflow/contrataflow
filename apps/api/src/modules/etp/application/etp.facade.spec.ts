import { describe, expect, it } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';

import { EtpFacade } from './etp.facade.js';
import { createEtpAlternative } from '../domain/etp-alternative.js';
import { createEtp } from '../domain/etp.js';
import { InMemoryEtpAlternativeRepository } from '../infrastructure/etp-alternative.repositories.js';
import { InMemoryEtpRepository } from '../infrastructure/etp.repositories.js';

const TENANT = '0192d021-0000-7000-8000-00000000000a';
const OTHER = '0192d021-0000-7000-8000-00000000000b';
const ETP = '0192d021-0000-7000-8000-0000000000e1';
const PROCESS = '0192d021-0000-7000-8000-0000000000b1';
const ALTERNATIVE = '0192d021-0000-7000-8000-0000000000c1';

const inTenant = <T>(tenantId: string, work: () => Promise<T>) =>
  runWithRequestContext({ correlationId: 'c-1', ip: '127.0.0.1', userAgent: 'vitest' }, () => {
    updateRequestContext({ tenantId });
    return work();
  });

describe('EtpFacade', () => {
  it('alternativeNames: nome da alternativa, inclusive excluída; ids de outro tenant ficam fora', async () => {
    const repository = new InMemoryEtpAlternativeRepository();
    const facade = new EtpFacade(repository, new InMemoryEtpRepository());
    const names = await inTenant(TENANT, () =>
      runSimulatedTransaction(async (tx) => {
        const alternative = createEtpAlternative(
          { name: 'Locação de equipamentos', description: { type: 'doc', content: [] } },
          {
            id: ALTERNATIVE,
            etp: { id: ETP, tenantId: TENANT, processId: PROCESS },
            sortOrder: 0,
            now: new Date('2026-10-18T10:00:00.000Z'),
            userId: null,
          },
        );
        await repository.insert(tx, alternative);
        await repository.softDelete(tx, alternative, 1, { at: new Date(), userId: null });
        return facade.alternativeNames(tx, [ALTERNATIVE]);
      }),
    );
    expect(names.get(ALTERNATIVE)).toEqual({ name: 'Locação de equipamentos' });
    const fromOther = await inTenant(OTHER, () =>
      runSimulatedTransaction((tx) => facade.alternativeNames(tx, [ALTERNATIVE])),
    );
    expect(fromOther.size).toBe(0);
  });
  it('aiDraftContextIn: decisões tipadas e alternativas como texto, sem o custo; outro tenant = null', async () => {
    const alternatives = new InMemoryEtpAlternativeRepository();
    const etps = new InMemoryEtpRepository();
    const facade = new EtpFacade(alternatives, etps);
    const paragraph = (text: string) => ({
      type: 'doc' as const,
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    const context = await inTenant(TENANT, () =>
      runSimulatedTransaction(async (tx) => {
        const now = new Date('2026-10-19T10:00:00.000Z');
        await etps.insert(
          tx,
          createEtp({
            documentId: ETP,
            tenantId: TENANT,
            processId: PROCESS,
            importedFromDfdVersionId: null,
            creatorId: null,
            now,
          }),
        );
        await alternatives.insert(
          tx,
          createEtpAlternative(
            {
              name: 'Aquisição',
              description: paragraph('Comprar os equipamentos'),
              advantages: paragraph('Patrimônio próprio'),
              estimatedCost: '1000.00',
            },
            {
              id: ALTERNATIVE,
              etp: { id: ETP, tenantId: TENANT, processId: PROCESS },
              sortOrder: 0,
              now,
              userId: null,
            },
          ),
        );
        return facade.aiDraftContextIn(tx, ETP);
      }),
    );
    expect(context).toMatchObject({
      id: ETP,
      conclusion: 'PENDING',
      parcelingDecision: null,
      recommendedAlternativeId: null,
      alternatives: [
        {
          name: 'Aquisição',
          description: 'Comprar os equipamentos',
          advantages: 'Patrimônio próprio',
          disadvantages: null,
          decision: 'UNDER_ANALYSIS',
        },
      ],
    });
    expect(JSON.stringify(context)).not.toContain('1000');
    const fromOther = await inTenant(OTHER, () =>
      runSimulatedTransaction((tx) => facade.aiDraftContextIn(tx, ETP)),
    );
    expect(fromOther).toBeNull();
  });
});
