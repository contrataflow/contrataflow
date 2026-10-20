import type { EstimatedValueSource } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { referenceQuantityUpdates, syncFromDfd } from './process-dfd-sync.js';
import type { DfdSyncSource } from './process-dfd-sync.js';
import type { ProcessItem } from './process-items.js';
import type { Process } from './process.js';

/*
 * US-017 — `Process.syncFromDfd` (RN-DFD-63..66 · DEC-032) e a quantidade de referência dos itens
 * (RN-DFD-64 · DEC-019): precedência do valor estimado table-driven, PCA, prioridade e no-op.
 */

const ID = {
  process: '0192f005-0000-7000-8000-000000000001',
  tenant: '0192f005-0000-7000-8000-00000000000a',
  organization: '0192f005-0000-7000-8000-0000000000b1',
  otherOrganization: '0192f005-0000-7000-8000-0000000000b2',
  contractingType: '0192f005-0000-7000-8000-0000000000c1',
  origin: '0192f005-0000-7000-8000-0000000000c2',
  secretariat: '0192f005-0000-7000-8000-0000000000d1',
  department: '0192f005-0000-7000-8000-0000000000d2',
  otherDepartment: '0192f005-0000-7000-8000-0000000000d3',
  ana: '0192f005-0000-7000-8000-0000000000a1',
  juliana: '0192f005-0000-7000-8000-0000000000a2',
};

const NOW = new Date('2026-10-05T15:00:00.000Z');
const DFD_DOCUMENT = '0192f017-0000-7000-8000-0000000000e1';
const OTHER_DOCUMENT = '0192f017-0000-7000-8000-0000000000e2';

function processOf(overrides: Partial<Process> = {}): Process {
  return {
    id: ID.process,
    tenantId: ID.tenant,
    organizationId: ID.organization,
    number: 12,
    year: 2026,
    code: '0012/2026',
    internalCode: null,
    title: 'Aquisição de cimento para manutenção de vias',
    object: 'Cimento CP-II para a manutenção das vias urbanas.',
    description: null,
    contractingTypeId: ID.contractingType,
    modalityId: null,
    isPriceRegistration: false,
    requestingSecretariatId: ID.secretariat,
    requestingDepartmentId: ID.department,
    currentDepartmentId: ID.department,
    currentResponsibleId: ID.ana,
    priority: 'MEDIUM',
    status: 'IN_PROGRESS',
    workflowVersionId: '0192f005-0000-7000-8000-0000000000f1',
    currentStageId: null,
    currentWorkflowStageId: null,
    currentStageDueAt: null,
    openedAt: NOW,
    targetDate: null,
    estimatedValue: null,
    estimatedValueSource: null,
    isBudgetConfidential: false,
    originId: ID.origin,
    creationChannel: 'WEB',
    pcaStatus: 'NOT_APPLICABLE',
    pcaYear: null,
    pcaItemCode: null,
    pcaJustification: null,
    notes: null,
    duplicatedFromId: null,
    createdAt: NOW,
    updatedAt: NOW,
    createdById: ID.ana,
    updatedById: null,
    version: 8,
    ...overrides,
  };
}

const DFD: DfdSyncSource = {
  estimatedValue: '15000.00',
  priority: 'HIGH',
  pcaStatus: 'PLANNED',
  pcaYear: 2026,
  pcaItemCode: 'PCA-2026-017',
  pcaJustification: null,
};

function itemOf(id: string, fields: Partial<ProcessItem> = {}): ProcessItem {
  return {
    id,
    tenantId: ID.tenant,
    processId: ID.process,
    sequence: 1,
    lotNumber: null,
    lotName: null,
    kind: 'GOOD',
    description: 'Cimento CP-II 50 kg',
    unitOfMeasureId: 'saco',
    catalogSystem: null,
    catalogCode: null,
    notes: null,
    referenceQuantity: null,
    referenceQuantitySourceDocumentId: null,
    referenceUnitPrice: null,
    referenceUnitPriceSourceDocumentId: null,
    createdAt: NOW,
    updatedAt: NOW,
    createdById: ID.ana,
    updatedById: ID.ana,
    version: 1,
    ...fields,
  };
}

describe('syncFromDfd (RN-DFD-63..66)', () => {
  it.each<[EstimatedValueSource | null, boolean]>([
    [null, true],
    ['MANUAL', true],
    ['DFD', true],
    ['ETP', false],
    ['PRICE_RESEARCH', false],
    ['TERM', false],
  ])('origem atual %s → o valor do DFD é aplicado? %s (DEC-032)', (source, applied) => {
    const process = processOf({
      estimatedValue: source === null ? null : '9000.00',
      estimatedValueSource: source,
    });
    const result = syncFromDfd(process, DFD);
    expect(result.estimatedValueSkipped).toBe(!applied);
    expect(result.next.estimatedValue).toBe(applied ? '15000.00' : process.estimatedValue);
    expect(result.next.estimatedValueSource).toBe(applied ? 'DFD' : source);
    // Os demais efeitos ocorrem em qualquer caso (FA-03).
    expect(result.next).toMatchObject({ pcaStatus: 'PLANNED', pcaYear: 2026, priority: 'HIGH' });
  });

  it('lista só os campos alterados com o antes e o depois; não toca versão nem carimbo', () => {
    const process = processOf();
    const result = syncFromDfd(process, DFD);
    expect(result.changes).toEqual([
      { field: 'estimatedValue', old: null, new: '15000.00' },
      { field: 'estimatedValueSource', old: null, new: 'DFD' },
      { field: 'pcaStatus', old: 'NOT_APPLICABLE', new: 'PLANNED' },
      { field: 'pcaYear', old: null, new: 2026 },
      { field: 'pcaItemCode', old: null, new: 'PCA-2026-017' },
      { field: 'priority', old: 'MEDIUM', new: 'HIGH' },
    ]);
    expect(result.next).toMatchObject({ version: process.version, updatedAt: process.updatedAt });
  });

  it('PCA NOT_PLANNED: a justificativa do DFD vai ao processo; a do processo sai quando o DFD não tem', () => {
    const notPlanned = syncFromDfd(processOf(), {
      ...DFD,
      pcaStatus: 'NOT_PLANNED',
      pcaYear: null,
      pcaItemCode: null,
      pcaJustification: 'Demanda surgida após a aprovação do PCA do exercício.',
    });
    expect(notPlanned.changes).toContainEqual({
      field: 'pcaJustification',
      old: null,
      new: 'Demanda surgida após a aprovação do PCA do exercício.',
    });
    const cleared = syncFromDfd(processOf({ pcaJustification: 'Antiga' }), DFD);
    expect(cleared.next.pcaJustification).toBeNull();
  });

  it('DFD sem valor estimado: o valor do processo fica e não conta como precedência', () => {
    const process = processOf({ estimatedValue: '500.00', estimatedValueSource: 'MANUAL' });
    const result = syncFromDfd(process, { ...DFD, estimatedValue: null });
    expect(result.estimatedValueSkipped).toBe(false);
    expect(result.next).toMatchObject({ estimatedValue: '500.00', estimatedValueSource: 'MANUAL' });
    expect(result.changes.map((change) => change.field)).not.toContain('estimatedValue');
  });

  it('mesmo valor em outra escala (15000 = 15000.00) e mesmos campos: nenhuma mudança', () => {
    const process = processOf({
      estimatedValue: '15000',
      estimatedValueSource: 'DFD',
      priority: 'HIGH',
      pcaStatus: 'PLANNED',
      pcaYear: 2026,
      pcaItemCode: 'PCA-2026-017',
    });
    const result = syncFromDfd(process, DFD);
    expect(result.changes).toEqual([]);
  });
});

describe('referenceQuantityUpdates (RN-DFD-64 · DEC-019)', () => {
  const items = [
    itemOf('i1'),
    itemOf('i2', {
      referenceQuantity: '5.0000',
      referenceQuantitySourceDocumentId: OTHER_DOCUMENT,
    }),
    itemOf('i3', { referenceQuantity: '7.0000', referenceQuantitySourceDocumentId: DFD_DOCUMENT }),
    itemOf('i4'),
  ];

  it('itens com linha no DFD recebem a quantidade (4 casas) e a origem; os sem linha não mudam', () => {
    const updates = referenceQuantityUpdates(
      items,
      [
        { processItemId: 'i1', quantity: '10' },
        { processItemId: 'i2', quantity: '5.0000' },
        { processItemId: 'i3', quantity: '7' },
        { processItemId: 'removido', quantity: '3' },
      ],
      DFD_DOCUMENT,
    );
    expect(updates).toEqual([
      { itemId: 'i1', quantity: '10.0000', oldQuantity: null, oldSourceDocumentId: null },
      // Mesma quantidade, outra origem: a origem passa a ser o DFD.
      {
        itemId: 'i2',
        quantity: '5.0000',
        oldQuantity: '5.0000',
        oldSourceDocumentId: OTHER_DOCUMENT,
      },
    ]);
  });

  it('sem linhas, nada a gravar', () => {
    expect(referenceQuantityUpdates(items, [], DFD_DOCUMENT)).toEqual([]);
  });
});
