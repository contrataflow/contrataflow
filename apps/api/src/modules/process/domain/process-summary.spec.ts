import type { ActionEntry, ChecklistViolation, ProcessStatus } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  allowedActionsOf,
  approverLabelOf,
  blockingPendingMessage,
  isDesignatedApprover,
  pendingOf,
  selectPrimaryAction,
  stageEntriesOf,
  targetOf,
} from './process-summary.js';
import type { ApproverFacts, StepperPass, StepperStage } from './process-summary.js';

const RULE = '0192d004-0000-7000-8000-00000000f001';
const APPROVAL = '0192d004-0000-7000-8000-00000000f002';
const ME = '0192d004-0000-7000-8000-00000000f003';
const UNIT = '0192d004-0000-7000-8000-00000000f004';
const ROLE = '0192d004-0000-7000-8000-00000000f005';

const entry = (overrides: Partial<ActionEntry> & Pick<ActionEntry, 'action'>): ActionEntry => ({
  label: overrides.action,
  enabled: true,
  reasons: [],
  ...overrides,
});
const blocked = { code: 'TRANSITION_BLOCKED', message: 'O ETP deve estar completo.', ruleId: RULE };
const notCustodian = {
  code: 'NOT_PROCESS_CUSTODIAN',
  message: 'Somente quem está com o processo pode encaminhá-lo.',
};
const forward = entry({
  action: 'FORWARD',
  transitionKey: 'para-pesquisa',
  label: 'Encaminhar para Pesquisa de preços',
  primary: true,
});

describe('selectPrimaryAction (RN-PROC-49 — ordem a–e)', () => {
  const primary = (
    status: ProcessStatus,
    actions: ActionEntry[],
    approvals: { id: string; processStageId: string | null; isMine: boolean }[] = [],
  ) => selectPrimaryAction({ status, actions, approvals });

  it('(a) aprovador designado: "Decidir aprovação" antes de qualquer outra ação', () => {
    expect(
      primary(
        'AWAITING_APPROVAL',
        [forward],
        [{ id: APPROVAL, processStageId: null, isMine: true }],
      ),
    ).toEqual({
      action: 'DECIDE_APPROVAL',
      approvalId: APPROVAL,
      label: 'Decidir aprovação',
      enabled: true,
      reasons: [],
    });
  });

  it('(a) não vale para processo em status final', () => {
    expect(
      primary('COMPLETED', [], [{ id: APPROVAL, processStageId: null, isMine: true }]),
    ).toBeNull();
  });

  it('(b) fila da unidade: "Assumir" habilitado vem antes da transição', () => {
    const claim = entry({ action: 'CLAIM', label: 'Assumir' });
    expect(primary('IN_PROGRESS', [forward, claim])).toMatchObject({ action: 'CLAIM' });
    // Assumir indisponível (já tem responsável) não é ação primária.
    expect(
      primary('IN_PROGRESS', [
        { ...claim, enabled: false, reasons: [{ code: 'PROCESS_ALREADY_ASSIGNED', message: 'x' }] },
        forward,
      ]),
    ).toMatchObject({ action: 'FORWARD' });
  });

  it('(c) custódia: a transição principal, bloqueada por regra, com UM motivo contando as pendências', () => {
    const twice = { ...forward, enabled: false, reasons: [blocked, { ...blocked, ruleId: ME }] };
    expect(primary('IN_PROGRESS', [twice])).toEqual({
      action: 'FORWARD',
      transitionKey: 'para-pesquisa',
      label: 'Encaminhar para Pesquisa de preços',
      enabled: false,
      reasons: [
        { code: 'TRANSITION_BLOCKED', message: 'Há 2 pendências obrigatórias nesta etapa.' },
      ],
    });
    expect(blockingPendingMessage(1)).toBe('Há 1 pendência obrigatória nesta etapa.');
  });

  it('(c) sem custódia ou status incompatível: a transição não é a ação primária', () => {
    expect(
      primary('IN_PROGRESS', [{ ...forward, enabled: false, reasons: [notCustodian, blocked] }]),
    ).toBeNull();
    // Transição não principal nunca é ação primária.
    expect(primary('IN_PROGRESS', [{ ...forward, primary: false }])).toBeNull();
    // COMPLETE principal também conta.
    expect(primary('IN_PROGRESS', [entry({ action: 'COMPLETE', primary: true })])).toMatchObject({
      action: 'COMPLETE',
    });
  });

  it('(d) suspenso: "Retomar" para quem pode; (e) nada além disso', () => {
    const resume = entry({ action: 'RESUME', label: 'Retomar' });
    const suspended = {
      ...forward,
      enabled: false,
      reasons: [{ code: 'INVALID_PROCESS_STATUS', message: 'Ação indisponível.' }],
    };
    expect(primary('SUSPENDED', [suspended, resume])).toMatchObject({ action: 'RESUME' });
    expect(primary('SUSPENDED', [suspended, { ...resume, enabled: false }])).toBeNull();
    expect(primary('IN_PROGRESS', [resume])).toBeNull();
  });
});

describe('allowedActionsOf (PRC-04 · meta.allowedActions)', () => {
  it('só as habilitadas, sem repetição, mais a decisão do aprovador designado', () => {
    expect(
      allowedActionsOf(
        [
          forward,
          { ...forward, transitionKey: 'outra' },
          entry({ action: 'CANCEL', enabled: false }),
        ],
        [{ id: APPROVAL, processStageId: null, isMine: true }],
      ),
    ).toEqual(['FORWARD', 'DECIDE_APPROVAL']);
    expect(allowedActionsOf([], [])).toEqual([]);
  });
});

describe('pendingOf (RN-PROC-51 · FA-10)', () => {
  const violation = (overrides: Partial<ChecklistViolation>): ChecklistViolation => ({
    code: 'WORKFLOW_RULE',
    ruleId: RULE,
    severity: 'BLOCKING',
    message: 'O ETP deve estar completo.',
    sectionKey: null,
    field: null,
    itemId: null,
    params: { documentTypeCode: 'ETP', minStatus: 'COMPLETE' },
    name: 'ETP completo',
    type: 'REQUIRED_DOCUMENT',
    satisfied: false,
    scope: 'STAGE_EXIT',
    ...overrides,
  });

  it('conta bloqueantes e avisos e liga a pendência ao documento existente ou à criação', () => {
    const pending = pendingOf(
      [
        violation({}),
        violation({
          ruleId: ME,
          severity: 'WARNING',
          message: 'Recomenda-se elaborar o mapa de riscos.',
          params: { documentTypeCode: 'RISK_MAP', minStatus: 'EXISTS' },
        }),
        violation({ ruleId: UNIT, type: 'CONDITION', params: {}, evaluationFailed: true }),
      ],
      [{ id: APPROVAL, typeCode: 'ETP', restricted: true }],
    );
    expect(pending.blockingCount).toBe(2);
    expect(pending.warningCount).toBe(1);
    expect(pending.items.map((item) => item.link)).toEqual([
      { documentId: APPROVAL, restricted: true },
      { createDocumentTypeCode: 'RISK_MAP' },
      null,
    ]);
    expect(pending.items.map((item) => item.evaluationFailed)).toEqual([false, false, true]);
  });
});

describe('targetOf (RN-PROC-53 · DEC-031)', () => {
  it('sem prazo alvo, no prazo, vencido em dias corridos e status final sem atraso', () => {
    expect(targetOf(null, 'IN_PROGRESS', '2026-10-05')).toBeNull();
    expect(targetOf('2026-10-05', 'IN_PROGRESS', '2026-10-05')).toEqual({
      targetDate: '2026-10-05',
      isOverdue: false,
      overdueDays: null,
    });
    expect(targetOf('2026-09-28', 'SUSPENDED', '2026-10-05')).toEqual({
      targetDate: '2026-09-28',
      isOverdue: true,
      overdueDays: 7,
    });
    expect(targetOf('2026-09-28', 'CANCELED', '2026-10-05')?.isOverdue).toBe(false);
  });
});

describe('aprovador designado (RN-PROC-48(2)/(7) · POL-03)', () => {
  const names = {
    users: new Map([[ME, 'Roberto Siqueira']]),
    roles: new Map([[ROLE, { key: 'AUTORIDADE_COMPETENTE', name: 'Autoridade competente' }]]),
    departments: new Map([[UNIT, 'Secretaria de Obras']]),
  };
  const approval = (overrides: Partial<ApproverFacts>): ApproverFacts => ({
    approverType: 'USER',
    approverUserId: null,
    approverRoleId: null,
    approverDepartmentId: null,
    allowDeputy: false,
    ...overrides,
  });
  const viewer = { userId: ME, headOfDepartmentIds: [UNIT], roleKeys: ['AUTORIDADE_COMPETENTE'] };

  it('usuário, perfil e titular da unidade (com substituto)', () => {
    const user = approval({ approverUserId: ME });
    const role = approval({ approverType: 'ROLE', approverRoleId: ROLE });
    const head = approval({ approverType: 'DEPARTMENT_HEAD', approverDepartmentId: UNIT });
    expect(approverLabelOf(user, names)).toBe('Roberto Siqueira');
    expect(approverLabelOf(role, names)).toBe('Perfil Autoridade competente');
    expect(approverLabelOf(head, names)).toBe('Titular de Secretaria de Obras');
    expect(approverLabelOf({ ...head, allowDeputy: true }, names)).toBe(
      'Titular de Secretaria de Obras ou substituto',
    );
    // Referência ausente: o id, nunca quebra.
    expect(approverLabelOf(approval({ approverUserId: UNIT }), names)).toBe(UNIT);
    expect(isDesignatedApprover(user, viewer, names)).toBe(true);
    expect(isDesignatedApprover(role, viewer, names)).toBe(true);
    expect(isDesignatedApprover(head, viewer, names)).toBe(true);
    const outsider = { userId: UNIT, headOfDepartmentIds: [], roleKeys: ['REQUISITANTE'] };
    expect(isDesignatedApprover(user, outsider, names)).toBe(false);
    expect(isDesignatedApprover(role, outsider, names)).toBe(false);
    expect(isDesignatedApprover(head, outsider, names)).toBe(false);
    expect(
      isDesignatedApprover(approval({ approverType: 'ROLE', approverRoleId: ME }), viewer, names),
    ).toBe(false);
  });
});

describe('stageEntriesOf (RN-PROC-52)', () => {
  const stage = (key: string, displayOrder: number, type: StepperStage['type'] = 'TASK') => ({
    id: `${key}-id`,
    key,
    name: key,
    type,
    groupLabel: displayOrder < 2 ? 'Demanda' : 'Planejamento',
    displayOrder,
    slaDays: 5,
    slaType: 'BUSINESS' as const,
  });
  const stages = [
    stage('FIM', 3, 'END'),
    stage('ABERTURA', 0, 'START'),
    stage('APROVACAO', 1, 'APPROVAL'),
    stage('ESTUDOS', 2),
  ];
  const pass = (key: string, sequence: number, status: StepperPass['status']): StepperPass => ({
    processStageId: `${key}-${String(sequence)}`,
    workflowStageId: `${key}-id`,
    sequence,
    status,
    department: { id: UNIT, name: 'Setor' },
    assignee: null,
    enteredAt: new Date('2026-10-01T12:00:00.000Z'),
    exitedAt: status === 'ACTIVE' ? null : new Date('2026-10-02T12:00:00.000Z'),
    dueAt: null,
    dueDateOverridden: false,
    overdueSince: null,
  });

  it('ordem do workflow, passagens por etapa, atual destacada e não percorridas', () => {
    const entries = stageEntriesOf(
      stages,
      [
        pass('ABERTURA', 3, 'COMPLETED'),
        pass('ABERTURA', 1, 'RETURNED'),
        pass('APROVACAO', 2, 'COMPLETED'),
        pass('ESTUDOS', 4, 'ACTIVE'),
      ],
      'IN_PROGRESS',
    );
    expect(entries.map((item) => item.key)).toEqual(['ABERTURA', 'APROVACAO', 'ESTUDOS', 'FIM']);
    expect(entries[0]?.passes.map((item) => [item.sequence, item.status])).toEqual([
      [1, 'RETURNED'],
      [3, 'COMPLETED'],
    ]);
    expect(entries[0]?.lastPassStatus).toBe('COMPLETED');
    expect(entries[2]).toMatchObject({ isCurrent: true, lastPassStatus: 'ACTIVE' });
    expect(entries[3]).toMatchObject({ lastPassStatus: null, passes: [], slaDays: 5 });
  });

  it('a etapa END só aparece concluída com o processo COMPLETED', () => {
    const atEnd = [pass('FIM', 1, 'COMPLETED')];
    expect(stageEntriesOf(stages, atEnd, 'IN_PROGRESS')[3]?.lastPassStatus).toBe('ACTIVE');
    expect(stageEntriesOf(stages, [], 'COMPLETED')[3]?.lastPassStatus).toBe('COMPLETED');
    expect(stageEntriesOf(stages, [pass('FIM', 1, 'ACTIVE')], 'COMPLETED')[3]).toMatchObject({
      lastPassStatus: 'COMPLETED',
      isCurrent: false,
    });
  });
});
