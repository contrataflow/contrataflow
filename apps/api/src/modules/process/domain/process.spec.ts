import { createProcessSchema, PROCESS_MESSAGES } from '@contrataflow/validation';
import type { CreateProcessInput } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  ProcessValidationError,
  createProcess,
  draftProcess,
  moneyOf,
  pcaReference,
} from './process.js';
import type { CreateProcessContext, DraftContext } from './process.js';

const ID = {
  process: '0192f000-0000-7000-8000-000000000001',
  tenant: '0192f000-0000-7000-8000-00000000000a',
  organization: '0192f000-0000-7000-8000-0000000000b1',
  contractingType: '0192f000-0000-7000-8000-0000000000c1',
  origin: '0192f000-0000-7000-8000-0000000000c2',
  modality: '0192f000-0000-7000-8000-0000000000c3',
  secretariat: '0192f000-0000-7000-8000-0000000000d1',
  department: '0192f000-0000-7000-8000-0000000000d2',
  stage: '0192f000-0000-7000-8000-0000000000e1',
  workflowStage: '0192f000-0000-7000-8000-0000000000e2',
  version: '0192f000-0000-7000-8000-0000000000f1',
  ana: '0192f000-0000-7000-8000-0000000000a1',
};

const TODAY: DraftContext = { today: '2026-10-16', currentYear: 2026, requireInternalCode: false };

function body(overrides: Partial<CreateProcessInput> = {}) {
  return createProcessSchema.parse({
    title: '  Aquisição de cimento para manutenção de vias  ',
    object: 'Cimento CP-II para a manutenção das vias urbanas.',
    contractingTypeId: ID.contractingType,
    requestingSecretariatId: ID.secretariat,
    requestingDepartmentId: ID.department,
    originId: ID.origin,
    pcaStatus: 'NOT_APPLICABLE',
    ...overrides,
  });
}

function issuesOf(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (error instanceof ProcessValidationError) return error.issues;
    throw error;
  }
  return [];
}

const CREATE: CreateProcessContext = {
  id: ID.process,
  tenantId: ID.tenant,
  organizationId: ID.organization,
  now: new Date('2026-10-16T13:00:00.000Z'),
  createdById: ID.ana,
  currentYear: 2026,
  numbering: { number: 12, year: 2026, code: '0012/2026' },
  workflowVersionId: ID.version,
  initialStage: {
    processStageId: ID.stage,
    workflowStageId: ID.workflowStage,
    departmentId: ID.department,
    assigneeId: ID.ana,
    dueAt: new Date('2026-10-23T02:59:59.999Z'),
  },
};

describe('Process.create (US-001 · RN-PROC-01..12)', () => {
  it('[Sucesso] só obrigatórios: DRAFT, número 12, código 0012/2026, etapa inicial com Ana', () => {
    const process = createProcess(draftProcess(body(), TODAY), CREATE);
    expect(process).toMatchObject({
      status: 'DRAFT',
      number: 12,
      year: 2026,
      code: '0012/2026',
      title: 'Aquisição de cimento para manutenção de vias',
      priority: 'MEDIUM',
      isPriceRegistration: false,
      modalityId: null,
      currentStageId: ID.stage,
      currentWorkflowStageId: ID.workflowStage,
      currentDepartmentId: ID.department,
      currentResponsibleId: ID.ana,
      workflowVersionId: ID.version,
      openedAt: CREATE.now,
      creationChannel: 'WEB',
      estimatedValue: null,
      estimatedValueSource: null,
      version: 1,
    });
  });

  it('[Sucesso] autuação (FA-03): sem número/código, openedAt nulo e exercício corrente', () => {
    const process = createProcess(draftProcess(body(), TODAY), { ...CREATE, numbering: null });
    expect(process).toMatchObject({ number: null, code: null, openedAt: null, year: 2026 });
  });

  it('RN-PROC-10: valor estimado com 2 casas e fonte MANUAL; opcionais vazios viram null', () => {
    const draft = draftProcess(
      body({ estimatedValue: '1500', description: '   ', notes: '', internalCode: ' PROT-1 ' }),
      TODAY,
    );
    expect(draft).toMatchObject({
      estimatedValue: '1500.00',
      description: null,
      notes: null,
      internalCode: 'PROT-1',
    });
    expect(createProcess(draft, CREATE).estimatedValueSource).toBe('MANUAL');
    expect(moneyOf('0.5')).toBe('0.50');
    expect(moneyOf(undefined)).toBeNull();
  });

  it('[Validação] RN-PROC-11: prazo alvo anterior a hoje no fuso do tenant', () => {
    expect(issuesOf(() => draftProcess(body({ targetDate: '2026-10-15' }), TODAY))).toEqual([
      { field: 'targetDate', code: 'DATE_IN_PAST', message: PROCESS_MESSAGES.targetDatePast },
    ]);
    expect(draftProcess(body({ targetDate: '2026-10-16' }), TODAY).targetDate).toBe('2026-10-16');
  });

  it('[Validação] RN-PROC-12: PLANNED exige exercício corrente ou seguinte; NOT_PLANNED exige justificativa', () => {
    expect(
      issuesOf(() => draftProcess(body({ pcaStatus: 'PLANNED', pcaYear: 2025 }), TODAY)),
    ).toEqual([{ field: 'pcaYear', code: 'OUT_OF_RANGE', message: PROCESS_MESSAGES.pcaYearRange }]);
    expect(
      draftProcess(body({ pcaStatus: 'PLANNED', pcaYear: 2027, pcaItemCode: 'ITEM-9' }), TODAY),
    ).toMatchObject({ pcaYear: 2027, pcaItemCode: 'ITEM-9', pcaJustification: null });
    expect(
      createProcessSchema.safeParse({
        ...body(),
        pcaStatus: 'NOT_PLANNED',
        pcaJustification: 'curta',
      }).success,
    ).toBe(false);
  });

  it('RN-PROC-12: a situação descarta os campos que não se aplicam', () => {
    expect(
      pcaReference({
        pcaStatus: 'NOT_APPLICABLE',
        pcaYear: 2026,
        pcaItemCode: 'X',
        pcaJustification: 'qualquer',
      }),
    ).toEqual({
      pcaStatus: 'NOT_APPLICABLE',
      pcaYear: null,
      pcaItemCode: null,
      pcaJustification: null,
    });
    expect(
      pcaReference({
        pcaStatus: 'NOT_PLANNED',
        pcaYear: 2026,
        pcaItemCode: 'X',
        pcaJustification: 'Demanda emergencial fora do plano anual.',
      }),
    ).toEqual({
      pcaStatus: 'NOT_PLANNED',
      pcaYear: null,
      pcaItemCode: null,
      pcaJustification: 'Demanda emergencial fora do plano anual.',
    });
  });

  it('[Validação] RN-PROC-09 · FA-09: código interno obrigatório pela configuração', () => {
    const context = { ...TODAY, requireInternalCode: true };
    expect(issuesOf(() => draftProcess(body(), context))).toEqual([
      {
        field: 'internalCode',
        code: 'CONDITIONAL_REQUIRED',
        message: PROCESS_MESSAGES.internalCodeRequired,
      },
    ]);
    expect(draftProcess(body({ internalCode: 'PROT-2026-0457' }), context).internalCode).toBe(
      'PROT-2026-0457',
    );
  });

  it('[Validação] schema: título ausente → "Informe o título."; quebra de linha e limites', () => {
    const missing = createProcessSchema.safeParse({ ...body(), title: undefined });
    expect(missing.error?.issues[0]).toMatchObject({
      path: ['title'],
      message: 'Informe o título.',
    });
    const empty = createProcessSchema.safeParse({ ...body(), title: '   ' });
    expect(empty.error?.issues.map((issue) => issue.message)).toEqual(['Informe o título.']);
    const short = createProcessSchema.safeParse({ ...body(), title: 'Abc' });
    expect(short.error?.issues[0]?.message).toBe(PROCESS_MESSAGES.titleLength);
    const lineBreak = createProcessSchema.safeParse({ ...body(), title: 'Título\ncom quebra' });
    expect(lineBreak.error?.issues[0]?.message).toBe(PROCESS_MESSAGES.titleLineBreak);
    const value = createProcessSchema.safeParse({ ...body(), estimatedValue: '10.555' });
    expect(value.error?.issues[0]?.message).toBe(PROCESS_MESSAGES.estimatedValueInvalid);
    expect(createProcessSchema.safeParse({ ...body(), estimatedValue: '-1' }).success).toBe(false);
  });
});
