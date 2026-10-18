import { describe, expect, it } from 'vitest';

import { createDfdFromProcess, dfdHeaderValues, isInSecretariat } from './dfd.js';
import type { DfdProcessSource } from './dfd.js';

const NOW = new Date('2026-10-17T15:00:00.000Z');
const DOCUMENT = '0192f014-0000-7000-8000-0000000000d1';
const CREATOR = '0192f014-0000-7000-8000-0000000000a1';

const PROCESS: DfdProcessSource = {
  id: '0192f014-0000-7000-8000-0000000000b1',
  requestingDepartmentId: '0192f014-0000-7000-8000-0000000000c1',
  object: '  Aquisição de insumos para a UBS Centro  ',
  priority: 'HIGH',
  pcaStatus: 'PLANNED',
  pcaYear: 2026,
  pcaItemCode: 'PCA-12',
  pcaJustification: null,
};

const input = {
  documentId: DOCUMENT,
  tenantId: 't',
  creatorId: CREATOR,
  today: '2026-10-17',
  now: NOW,
};

describe('createDfdFromProcess (RN-DFD-05)', () => {
  it('copia setor, objeto, prioridade e PCA do processo; responsável = criador; data = hoje', () => {
    const dfd = createDfdFromProcess(PROCESS, input);
    expect(dfd).toEqual({
      id: DOCUMENT,
      tenantId: 't',
      processId: PROCESS.id,
      documentId: DOCUMENT,
      requestingDepartmentId: PROCESS.requestingDepartmentId,
      responsibleId: CREATOR,
      requestDate: '2026-10-17',
      objectSummary: 'Aquisição de insumos para a UBS Centro',
      priority: 'HIGH',
      expectedDate: null,
      estimatedValue: null,
      pcaStatus: 'PLANNED',
      pcaYear: 2026,
      pcaItemCode: 'PCA-12',
      pcaJustification: null,
      wizardStep: 'IDENTIFICATION',
      completedSteps: [],
      createdAt: NOW,
      updatedAt: NOW,
      createdById: CREATOR,
      updatedById: CREATOR,
      version: 1,
    });
  });

  it('PCA: só copia os campos que a situação exige (RN-DFD-13)', () => {
    const notPlanned = createDfdFromProcess(
      { ...PROCESS, pcaStatus: 'NOT_PLANNED', pcaJustification: 'Demanda surgida após o PCA.' },
      input,
    );
    expect(notPlanned).toMatchObject({
      pcaYear: null,
      pcaItemCode: null,
      pcaJustification: 'Demanda surgida após o PCA.',
    });
    const notApplicable = createDfdFromProcess(
      { ...PROCESS, pcaStatus: 'NOT_APPLICABLE', pcaJustification: 'x' },
      input,
    );
    expect(notApplicable).toMatchObject({
      pcaYear: null,
      pcaItemCode: null,
      pcaJustification: null,
    });
  });

  it('dfdHeaderValues expõe só o cabeçalho tipado', () => {
    const header = dfdHeaderValues(createDfdFromProcess(PROCESS, input));
    expect(Object.keys(header)).toEqual([
      'requestDate',
      'requestingDepartmentId',
      'responsibleId',
      'objectSummary',
      'priority',
      'expectedDate',
      'estimatedValue',
      'pcaStatus',
      'pcaYear',
      'pcaItemCode',
      'pcaJustification',
    ]);
  });
});

describe('isInSecretariat (RN-DFD-09)', () => {
  const secretariat = { id: 'sec', organizationId: 'org' };

  it('unidade da subárvore da secretaria, no mesmo órgão', () => {
    expect(isInSecretariat({ path: '/sec/setor/', organizationId: 'org' }, secretariat)).toBe(true);
    expect(isInSecretariat({ path: '/sec/', organizationId: 'org' }, secretariat)).toBe(true);
  });

  it('fora da subárvore ou de outro órgão', () => {
    expect(isInSecretariat({ path: '/outra/setor/', organizationId: 'org' }, secretariat)).toBe(
      false,
    );
    expect(isInSecretariat({ path: '/sec/setor/', organizationId: 'org-2' }, secretariat)).toBe(
      false,
    );
    expect(isInSecretariat({ path: '/secretaria/', organizationId: 'org' }, secretariat)).toBe(
      false,
    );
  });
});
