import { describe, expect, it } from 'vitest';

import type { TenantTx } from '#shared/database/prisma.js';

import { DfdFacade } from './dfd.facade.js';
import type { DfdRepository } from './ports.js';
import type { Dfd } from '../domain/dfd.js';

const tx = {} as TenantTx;

const DFD = {
  id: 'doc-1',
  documentId: 'doc-1',
  processId: 'proc-1',
  requestingDepartmentId: 'dep-1',
  responsibleId: 'user-1',
  objectSummary: 'Aquisição de computadores',
  priority: 'HIGH',
  requestDate: '2026-10-18',
  expectedDate: null,
  estimatedValue: '1500.00',
  pcaStatus: 'PLANNED',
  pcaYear: 2026,
  pcaItemCode: 'PCA-01',
} as unknown as Dfd;

function repository(found: Dfd | null): DfdRepository {
  return {
    insert: () => Promise.resolve(),
    findById: () => Promise.resolve(found),
    update: () => Promise.resolve(),
    listByProcess: () => Promise.resolve([]),
  };
}

describe('DfdFacade.aiDraftHeaderIn (US-117 · RN-AI-26)', () => {
  it('devolve o cabeçalho sem o responsável pela demanda (pessoa)', async () => {
    const header = await new DfdFacade(repository(DFD)).aiDraftHeaderIn(tx, 'doc-1');
    expect(header).toMatchObject({ objectSummary: 'Aquisição de computadores', pcaYear: 2026 });
    expect(header).not.toHaveProperty('responsibleId');
  });

  it('DFD inexistente no tenant → null', async () => {
    expect(await new DfdFacade(repository(null)).aiDraftHeaderIn(tx, 'x')).toBeNull();
  });
});
