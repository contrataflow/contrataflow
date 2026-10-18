import { describe, expect, it } from 'vitest';

import {
  applyDfdPatch,
  createDfdFromProcess,
  dfdHeaderValues,
  isInSecretariat,
  normalizeCompletedSteps,
} from './dfd.js';
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

describe('applyDfdPatch (DFD-04 · RN-DFD-27)', () => {
  const dfd = createDfdFromProcess(PROCESS, input);
  const LATER = new Date('2026-10-17T16:00:00.000Z');
  const stamp = { actorId: '0192f014-0000-7000-8000-0000000000a2', now: LATER };

  it('aplica só os campos enviados e devolve as mudanças efetivas com o carimbo', () => {
    const { dfd: next, changes } = applyDfdPatch(
      dfd,
      { priority: 'URGENT', objectSummary: '  Novo objeto do DFD  ', pcaItemCode: '  ' },
      stamp,
    );
    expect(changes).toEqual([
      { field: 'objectSummary', old: dfd.objectSummary, new: 'Novo objeto do DFD' },
      { field: 'priority', old: 'HIGH', new: 'URGENT' },
      { field: 'pcaItemCode', old: 'PCA-12', new: null },
    ]);
    expect(next).toMatchObject({
      priority: 'URGENT',
      objectSummary: 'Novo objeto do DFD',
      pcaItemCode: null,
      requestDate: dfd.requestDate,
      updatedAt: LATER,
      updatedById: stamp.actorId,
      version: 1,
    });
  });

  it('patch igual ao atual não muda nada (nem o carimbo)', () => {
    const result = applyDfdPatch(dfd, { priority: 'HIGH', completedSteps: [] }, stamp);
    expect(result.changes).toEqual([]);
    expect(result.dfd).toBe(dfd);
  });

  it('completedSteps sem repetição e na ordem do wizard', () => {
    expect(normalizeCompletedSteps(['PLANNING', 'IDENTIFICATION', 'PLANNING'])).toEqual([
      'IDENTIFICATION',
      'PLANNING',
    ]);
    const { changes } = applyDfdPatch(
      dfd,
      { wizardStep: 'REVIEW', completedSteps: ['JUSTIFICATION', 'IDENTIFICATION'] },
      stamp,
    );
    expect(changes).toEqual([
      { field: 'wizardStep', old: 'IDENTIFICATION', new: 'REVIEW' },
      { field: 'completedSteps', old: [], new: ['IDENTIFICATION', 'JUSTIFICATION'] },
    ]);
  });
});

describe('applyDfdPatch (DFD-04 · RN-DFD-27)', () => {
  const dfd = createDfdFromProcess(PROCESS, input);
  const LATER = new Date('2026-10-17T16:00:00.000Z');
  const stamp = { actorId: '0192f014-0000-7000-8000-0000000000a2', now: LATER };

  it('aplica só os campos enviados e devolve as mudanças efetivas com o carimbo', () => {
    const { dfd: next, changes } = applyDfdPatch(
      dfd,
      { priority: 'URGENT', objectSummary: '  Novo objeto do DFD  ', pcaItemCode: '  ' },
      stamp,
    );
    expect(changes).toEqual([
      { field: 'objectSummary', old: dfd.objectSummary, new: 'Novo objeto do DFD' },
      { field: 'priority', old: 'HIGH', new: 'URGENT' },
      { field: 'pcaItemCode', old: 'PCA-12', new: null },
    ]);
    expect(next).toMatchObject({
      priority: 'URGENT',
      objectSummary: 'Novo objeto do DFD',
      pcaItemCode: null,
      requestDate: dfd.requestDate,
      updatedAt: LATER,
      updatedById: stamp.actorId,
      version: 1,
    });
  });

  it('patch igual ao atual não muda nada (nem o carimbo)', () => {
    const result = applyDfdPatch(dfd, { priority: 'HIGH', completedSteps: [] }, stamp);
    expect(result.changes).toEqual([]);
    expect(result.dfd).toBe(dfd);
  });

  it('completedSteps sem repetição e na ordem do wizard', () => {
    expect(normalizeCompletedSteps(['PLANNING', 'IDENTIFICATION', 'PLANNING'])).toEqual([
      'IDENTIFICATION',
      'PLANNING',
    ]);
    const { changes } = applyDfdPatch(
      dfd,
      { wizardStep: 'REVIEW', completedSteps: ['JUSTIFICATION', 'IDENTIFICATION'] },
      stamp,
    );
    expect(changes).toEqual([
      { field: 'wizardStep', old: 'IDENTIFICATION', new: 'REVIEW' },
      { field: 'completedSteps', old: [], new: ['IDENTIFICATION', 'JUSTIFICATION'] },
    ]);
  });
});
