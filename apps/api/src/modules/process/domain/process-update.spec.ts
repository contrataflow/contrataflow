import {
  PROCESS_STATUSES,
  PROCESS_UPDATE_MESSAGES,
  UPDATE_PROCESS_FIELDS,
  updateProcessSchema,
} from '@contrataflow/validation';
import type { ProcessStatus, UpdateProcessInput } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  applyProcessChanges,
  diffProcess,
  estimatedValueLockedBy,
  fieldLock,
  isEditableStatus,
  isProcessCustodian,
  lockIssues,
  notEditableStatusMessage,
  numberingDependsOnOrganization,
  revalidationIssues,
} from './process-update.js';
import type { FieldLock, FieldLockContext } from './process-update.js';
import type { Process } from './process.js';

/*
 * US-005 — regras puras da edição: política de bloqueio campo × status (table-driven, RN-PROC-60/61),
 * precedência do valor estimado (RN-PROC-63), revalidação parcial (RN-PROC-64) e detecção de no-op
 * com normalização (RN-PROC-67).
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

const patch = (input: UpdateProcessInput) => updateProcessSchema.parse(input);
const REVALIDATE = { today: '2026-10-05', currentYear: 2026, requireInternalCode: false };

describe('diffProcess (RN-PROC-67 — diferença efetiva com normalização)', () => {
  it('lista só os campos alterados, na ordem canônica, com os valores antigo e novo', () => {
    const changes = diffProcess(
      processOf(),
      patch({
        targetDate: '2026-11-30',
        priority: 'HIGH',
        title: 'Aquisição de cimento CP-II para manutenção de vias',
      }),
    );
    expect(changes.changes).toEqual([
      {
        field: 'title',
        old: 'Aquisição de cimento para manutenção de vias',
        new: 'Aquisição de cimento CP-II para manutenção de vias',
      },
      { field: 'priority', old: 'MEDIUM', new: 'HIGH' },
      { field: 'targetDate', old: null, new: '2026-11-30' },
    ]);
  });

  it('valores iguais após trim e decimal canônico não são alteração (no-op)', () => {
    const current = processOf({ estimatedValue: '85000.00', estimatedValueSource: 'MANUAL' });
    const changes = diffProcess(
      current,
      patch({
        title: '  Aquisição de cimento para manutenção de vias  ',
        estimatedValue: '85000',
        description: '   ',
        priority: 'MEDIUM',
      }),
    );
    expect(changes.changes).toEqual([]);
    expect(changes.sent.has('title')).toBe(true);
  });

  it('texto opcional vazio vira null; null limpa a modalidade e o prazo', () => {
    const changes = diffProcess(
      processOf({ notes: 'Antiga', modalityId: ID.origin, targetDate: '2026-12-01' }),
      patch({ notes: '', modalityId: null, targetDate: null }),
    );
    expect(changes.changes.map((change) => [change.field, change.new])).toEqual([
      ['modalityId', null],
      ['targetDate', null],
      ['notes', null],
    ]);
  });

  it('situação no PCA: os campos que não se aplicam à situação resultante são descartados', () => {
    const planned = processOf({ pcaStatus: 'PLANNED', pcaYear: 2026, pcaItemCode: 'ITEM-1' });
    const changes = diffProcess(
      planned,
      patch({ pcaStatus: 'NOT_PLANNED', pcaJustification: 'Demanda emergencial não prevista.' }),
    );
    expect(changes.changes.map((change) => change.field)).toEqual([
      'pcaStatus',
      'pcaYear',
      'pcaItemCode',
      'pcaJustification',
    ]);
    expect(changes.next).toMatchObject({ pcaYear: null, pcaItemCode: null });
    // Exercício enviado com situação "Não se aplica": descartado, sem diferença.
    expect(diffProcess(processOf(), patch({ pcaYear: 2027 })).changes).toEqual([]);
  });
});

describe('FieldLockPolicy (RN-PROC-60/61 — campo × status)', () => {
  const unlocked: FieldLockContext = {
    status: 'DRAFT',
    numbered: false,
    numberingDependsOnOrganization: false,
  };
  const DRAFT_ONLY = new Set([
    'organizationId',
    'requestingSecretariatId',
    'requestingDepartmentId',
  ]);
  const expected = (field: string, status: ProcessStatus): FieldLock => {
    if (!['DRAFT', 'IN_PROGRESS', 'RETURNED'].includes(status)) return 'STATUS';
    if (DRAFT_ONLY.has(field) && status !== 'DRAFT') return 'DRAFT_ONLY';
    return 'EDITABLE';
  };
  const cases = UPDATE_PROCESS_FIELDS.flatMap((field) =>
    PROCESS_STATUSES.map((status) => [field, status, expected(field, status)] as const),
  );

  it.each(cases)('%s em %s → %s', (field, status, lock) => {
    expect(fieldLock(field, { ...unlocked, status })).toBe(lock);
  });

  it.each([
    [true, true, 'NUMBERING'],
    [true, false, 'EDITABLE'],
    [false, true, 'EDITABLE'],
  ] as const)(
    'órgão em DRAFT (numerado=%s, numeração depende do órgão=%s) → %s',
    (numbered, depends, lock) => {
      const context = {
        status: 'DRAFT' as const,
        numbered,
        numberingDependsOnOrganization: depends,
      };
      expect(fieldLock('organizationId', context)).toBe(lock);
      // A ressalva vale só para o órgão: secretaria e setor seguem editáveis em rascunho.
      expect(fieldLock('requestingDepartmentId', context)).toBe('EDITABLE');
    },
  );

  it.each([
    [{ processScope: 'ORGANIZATION', processMask: '{seq:4}/{year}' }, true],
    [{ processScope: 'TENANT', processMask: '{org}-{seq:4}/{year}' }, true],
    [{ processScope: 'TENANT', processMask: '{seq:4}/{year}' }, false],
  ])('numeração depende do órgão: %o → %s', (settings, depends) => {
    expect(numberingDependsOnOrganization(settings)).toBe(depends);
  });

  it('lockIssues: NOT_ALLOWED só nos campos ALTERADOS que estão bloqueados', () => {
    const changes = diffProcess(
      processOf(),
      patch({
        requestingSecretariatId: ID.otherDepartment,
        requestingDepartmentId: ID.department,
        priority: 'HIGH',
      }),
    );
    expect(
      lockIssues(changes, {
        status: 'IN_PROGRESS',
        numbered: true,
        numberingDependsOnOrganization: false,
      }),
    ).toEqual([
      {
        field: 'requestingSecretariatId',
        code: 'NOT_ALLOWED',
        message: PROCESS_UPDATE_MESSAGES.lockedByStatus,
      },
    ]);
    const organization = diffProcess(
      processOf({ status: 'DRAFT' }),
      patch({ organizationId: ID.otherOrganization }),
    );
    expect(
      lockIssues(organization, {
        status: 'DRAFT',
        numbered: true,
        numberingDependsOnOrganization: true,
      }),
    ).toEqual([
      {
        field: 'organizationId',
        code: 'NOT_ALLOWED',
        message: PROCESS_UPDATE_MESSAGES.lockedByNumbering,
      },
    ]);
  });

  it.each(PROCESS_STATUSES.map((status) => [status] as const))(
    'status %s: editável apenas em DRAFT, IN_PROGRESS e RETURNED',
    (status) => {
      expect(isEditableStatus(status)).toBe(['DRAFT', 'IN_PROGRESS', 'RETURNED'].includes(status));
    },
  );

  it('mensagem do status não editável (FA-02)', () => {
    expect(notEditableStatusMessage('AWAITING_APPROVAL')).toBe(
      'Não é possível editar enquanto o processo aguarda aprovação.',
    );
    expect(notEditableStatusMessage('SUSPENDED')).toBe(
      'Não é possível editar com o processo suspenso.',
    );
  });
});

describe('EstimatedValuePolicy (RN-PROC-63 · DEC-032)', () => {
  const change = patch({ estimatedValue: '90000.00' });

  it.each([
    [null, null],
    ['MANUAL', null],
    ['DFD', 'DFD'],
    ['ETP', 'ETP'],
    ['PRICE_RESEARCH', 'PRICE_RESEARCH'],
    ['TERM', 'TERM'],
  ] as const)('fonte %s → bloqueada por %s', (source, blockedBy) => {
    const process = processOf({
      estimatedValue: source === null ? null : '85000.00',
      estimatedValueSource: source,
    });
    expect(estimatedValueLockedBy(process, diffProcess(process, change))).toBe(blockedBy);
  });

  it('sem alteração do valor, a fonte superior não bloqueia os demais campos', () => {
    const process = processOf({
      estimatedValue: '92450.00',
      estimatedValueSource: 'PRICE_RESEARCH',
    });
    const changes = diffProcess(process, patch({ priority: 'HIGH', estimatedValue: '92450.00' }));
    expect(estimatedValueLockedBy(process, changes)).toBeNull();
  });

  it('informar → MANUAL; limpar → valor e origem nulos; sem alteração → origem preservada', () => {
    const process = processOf();
    const informed = applyProcessChanges(process, diffProcess(process, change), {
      now: NOW,
      userId: ID.ana,
    });
    expect(informed).toMatchObject({ estimatedValue: '90000.00', estimatedValueSource: 'MANUAL' });
    const cleared = applyProcessChanges(
      informed,
      diffProcess(informed, patch({ estimatedValue: null })),
      { now: NOW, userId: ID.ana },
    );
    expect(cleared).toMatchObject({ estimatedValue: null, estimatedValueSource: null });
    const derived = processOf({
      estimatedValue: '92450.00',
      estimatedValueSource: 'PRICE_RESEARCH',
    });
    expect(
      applyProcessChanges(derived, diffProcess(derived, patch({ priority: 'HIGH' })), {
        now: NOW,
        userId: ID.ana,
      }),
    ).toMatchObject({
      priority: 'HIGH',
      estimatedValue: '92450.00',
      estimatedValueSource: 'PRICE_RESEARCH',
      version: 9,
      updatedById: ID.ana,
      updatedAt: NOW,
    });
  });
});

describe('revalidationIssues (RN-PROC-64 — só os campos enviados e as regras cruzadas)', () => {
  it('prazo alvo alterado para o passado → DATE_IN_PAST; prazo passado NÃO alterado não é revalidado', () => {
    const past = diffProcess(processOf(), patch({ targetDate: '2026-10-01' }));
    expect(revalidationIssues(past, REVALIDATE)).toEqual([
      expect.objectContaining({ field: 'targetDate', code: 'DATE_IN_PAST' }),
    ]);
    const kept = diffProcess(processOf({ targetDate: '2026-09-01' }), patch({ priority: 'HIGH' }));
    expect(revalidationIssues(kept, REVALIDATE)).toEqual([]);
  });

  it('NOT_PLANNED exige justificativa (V-10); PLANNED exige exercício corrente ou seguinte', () => {
    const notPlanned = diffProcess(processOf(), patch({ pcaStatus: 'NOT_PLANNED' }));
    expect(revalidationIssues(notPlanned, REVALIDATE)).toEqual([
      expect.objectContaining({ field: 'pcaJustification', code: 'CONDITIONAL_REQUIRED' }),
    ]);
    const planned = diffProcess(processOf(), patch({ pcaStatus: 'PLANNED', pcaYear: 2030 }));
    expect(revalidationIssues(planned, REVALIDATE)).toEqual([
      expect.objectContaining({ field: 'pcaYear', code: 'OUT_OF_RANGE' }),
    ]);
    const missing = diffProcess(processOf(), patch({ pcaStatus: 'PLANNED' }));
    expect(revalidationIssues(missing, REVALIDATE)).toEqual([
      expect.objectContaining({ field: 'pcaYear', code: 'CONDITIONAL_REQUIRED' }),
    ]);
  });

  it('código interno removido com process.requireInternalCode → REQUIRED (V-12)', () => {
    const changes = diffProcess(processOf({ internalCode: 'PROT-1' }), patch({ internalCode: '' }));
    expect(revalidationIssues(changes, { ...REVALIDATE, requireInternalCode: true })).toEqual([
      {
        field: 'internalCode',
        code: 'REQUIRED',
        message: PROCESS_UPDATE_MESSAGES.internalCodeRequired,
      },
    ]);
    expect(revalidationIssues(changes, REVALIDATE)).toEqual([]);
  });

  it('trocar o órgão exige secretaria e setor na mesma requisição (RN-PROC-61)', () => {
    const changes = diffProcess(
      processOf({ status: 'DRAFT' }),
      patch({ organizationId: ID.otherOrganization, requestingDepartmentId: ID.otherDepartment }),
    );
    expect(revalidationIssues(changes, REVALIDATE)).toEqual([
      expect.objectContaining({ field: 'requestingSecretariatId', code: 'CONDITIONAL_REQUIRED' }),
    ]);
  });
});

describe('isProcessCustodian (POL-01)', () => {
  it('responsável atual; na fila, lotado na unidade atual', () => {
    const viewer = { userId: ID.ana, departmentIds: [ID.department] };
    expect(isProcessCustodian(processOf(), viewer)).toBe(true);
    expect(isProcessCustodian(processOf(), { ...viewer, userId: ID.juliana })).toBe(false);
    const queued = processOf({ currentResponsibleId: null });
    expect(isProcessCustodian(queued, { userId: ID.juliana, departmentIds: [ID.department] })).toBe(
      true,
    );
    expect(isProcessCustodian(queued, { userId: ID.ana, departmentIds: [] })).toBe(false);
  });
});

describe('updateProcessSchema (RN-PROC-65 — schema estrito)', () => {
  it.each(['status', 'code', 'workflowVersionId', 'estimatedValueSource', 'isBudgetConfidential'])(
    'campo %s fora da lista de editáveis → unrecognized_keys',
    (field) => {
      const result = updateProcessSchema.safeParse({ [field]: 'X' });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
    },
  );

  it('valor negativo ou com mais de 2 casas é recusado (V-08)', () => {
    expect(updateProcessSchema.safeParse({ estimatedValue: '-1' }).success).toBe(false);
    expect(updateProcessSchema.safeParse({ estimatedValue: '10.123' }).success).toBe(false);
    expect(updateProcessSchema.safeParse({ estimatedValue: '10.12' }).success).toBe(true);
  });
});
