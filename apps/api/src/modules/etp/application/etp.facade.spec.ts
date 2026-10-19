import { describe, expect, it } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';

import { EtpFacade } from './etp.facade.js';
import { createEtpAlternative } from '../domain/etp-alternative.js';
import { InMemoryEtpAlternativeRepository } from '../infrastructure/etp-alternative.repositories.js';

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
    const facade = new EtpFacade(repository);
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
});
