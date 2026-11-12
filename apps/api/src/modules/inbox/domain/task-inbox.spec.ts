import { describe, expect, it } from 'vitest';

import {
  canClaim,
  compareItems,
  dueAtOf,
  inboxViewerOf,
  isDesignatedApprover,
  isFollowing,
  isInUnitQueue,
  isMine,
  isOverdueTask,
  isReturned,
  itemsOfView,
  matchesRestriction,
  rowFocusOf,
  unitQueueApplies,
} from './task-inbox.js';
import type {
  InboxApprovalRow,
  InboxItemRow,
  InboxProcessRow,
  InboxViewerFacts,
} from './task-inbox.js';

const T = '0192e056-0000-7000-8000-000000000001';
const ORG = '0192e056-0000-7000-8000-0000000000a0';
const OTHER_ORG = '0192e056-0000-7000-8000-0000000000b0';
const OBRAS = '0192e056-0000-7000-8000-0000000000a1';
const MANUT = '0192e056-0000-7000-8000-0000000000a2';
const COMPRAS = '0192e056-0000-7000-8000-0000000000a3';
const ANA = '0192e056-0000-7000-8000-0000000000c1';
const CARLOS = '0192e056-0000-7000-8000-0000000000c2';
const ROLE = '0192e056-0000-7000-8000-0000000000d1';
const NOW = new Date('2026-10-19T12:00:00.000Z');

const pid = (n: number) => `0192e056-0000-7000-8000-${String(n).padStart(12, '0')}`;

function row(n: number, patch: Partial<InboxProcessRow> = {}): InboxProcessRow {
  return {
    tenantId: T,
    id: pid(n),
    organizationId: ORG,
    code: `${String(n).padStart(4, '0')}/2026`,
    number: n,
    year: 2026,
    title: `Processo ${String(n)}`,
    status: 'IN_PROGRESS',
    version: 3,
    isBudgetConfidential: false,
    requestingSecretariatId: OBRAS,
    requestingDepartmentId: MANUT,
    currentDepartmentId: COMPRAS,
    currentResponsibleId: null,
    currentWorkflowStageId: null,
    stageId: pid(1000 + n),
    enteredAt: new Date('2026-10-01T12:00:00.000Z'),
    dueAt: null,
    overdueSince: null,
    slaType: 'BUSINESS',
    pausedAt: null,
    assignmentDepartmentId: COMPRAS,
    assigneeId: null,
    assignmentType: 'STAGE_ENTRY',
    branchKey: null,
    stageWorkflowStageId: null,
    stageDepartmentId: null,
    activeStagesCount: 1,
    ...patch,
  };
}

function approval(n: number, patch: Partial<InboxApprovalRow> = {}): InboxApprovalRow {
  return {
    tenantId: T,
    id: pid(2000 + n),
    approvalId: pid(2000 + n),
    sequence: 1,
    decisionPolicy: 'ANY',
    lineDueAt: null,
    lineCounts: { totalLines: 1, approvedLines: 0, pendingLines: 1, waitingLines: 0 },
    processId: pid(n),
    subjectType: 'PROCESS_STAGE',
    title: 'Aprovação do DFD',
    requestedById: CARLOS,
    requestedAt: new Date('2026-10-10T12:00:00.000Z'),
    dueAt: null,
    approverType: 'USER',
    approverUserId: ANA,
    approverRoleId: null,
    approverDepartmentId: null,
    allowDeputy: false,
    processStageId: null,
    branchKey: null,
    ...patch,
  };
}

const base: InboxViewerFacts = {
  userId: ANA,
  ownDepartmentIds: [COMPRAS],
  headOfDepartmentIds: [],
  claim: { tenantWide: false, organizationIds: [], departmentIds: [COMPRAS] },
  leadership: { headOf: [], deputyOf: [] },
  roles: [],
  visibility: { userId: ANA, tenantWide: false, organizationIds: [], departmentIds: [] },
  historicalDepartmentsCanView: true,
};
const viewer = (patch: Partial<InboxViewerFacts> = {}) => inboxViewerOf({ ...base, ...patch });

describe('visões da caixa de tarefas (US-056 · RN-INBOX-03..08)', () => {
  it('RN-INBOX-04: fila = lotações com PROCESS_CLAIM ∪ titular/substituto; FA-01 sem nenhum', () => {
    expect(viewer().queueDepartmentIds).toEqual([COMPRAS]);
    expect(viewer({ claim: null }).queueDepartmentIds).toEqual([]);
    expect(unitQueueApplies(viewer({ claim: null }))).toBe(false);
    expect(viewer({ claim: null, headOfDepartmentIds: [MANUT] }).queueDepartmentIds).toEqual([
      MANUT,
    ]);
    expect(unitQueueApplies(viewer({ claim: null, headOfDepartmentIds: [MANUT] }))).toBe(true);
  });

  it('RN-INBOX-03/04: comigo = responsável ativo; fila = sem responsável numa unidade da fila', () => {
    const mine = row(1, { assigneeId: ANA, currentResponsibleId: ANA });
    const queued = row(2);
    const elsewhere = row(3, { assignmentDepartmentId: MANUT, currentDepartmentId: MANUT });
    const others = row(4, { assigneeId: CARLOS });
    const v = viewer();
    expect([mine, queued, elsewhere, others].map((r) => isMine(r, v))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect([mine, queued, elsewhere, others].map((r) => isInUnitQueue(r, v))).toEqual([
      false,
      true,
      false,
      false,
    ]);
    // Sem custódia ativa (ex.: concluído) não entra em nenhuma das duas.
    const done = row(5, { assignmentDepartmentId: null, stageId: null });
    expect(isMine(done, v) || isInUnitQueue(done, v)).toBe(false);
  });

  it('RN-INBOX-05: devolvidos = RETURN comigo ou na fila de uma unidade minha', () => {
    const v = viewer();
    expect(isReturned(row(1, { assignmentType: 'RETURN', assigneeId: ANA }), v)).toBe(true);
    expect(isReturned(row(2, { assignmentType: 'RETURN' }), v)).toBe(true);
    expect(isReturned(row(3, { assignmentType: 'RETURN', assigneeId: CARLOS }), v)).toBe(false);
    expect(isReturned(row(4, { assigneeId: ANA }), v)).toBe(false);
    expect(isReturned(row(5, { assignmentType: 'RETURN' }), viewer({ claim: null }))).toBe(false);
  });

  it('RN-INBOX-06 · FA-03: atrasado só entre "Comigo" e a fila, uma vez por processo', () => {
    const late = new Date('2026-10-15T03:00:00.000Z');
    const mineLate = row(1, { assigneeId: ANA, overdueSince: late });
    const queueLate = row(2, { overdueSince: late });
    const otherLate = row(3, { assigneeId: CARLOS, overdueSince: late });
    const v = viewer();
    expect([mineLate, queueLate, otherLate].map((r) => isOverdueTask(r, v))).toEqual([
      true,
      true,
      false,
    ]);
    expect(isOverdueTask(row(4, { assigneeId: ANA, overdueSince: late, stageId: null }), v)).toBe(
      false,
    );
    const items = itemsOfView(
      'OVERDUE',
      { processes: [mineLate, queueLate, otherLate], approvals: [], participations: [] },
      v,
      NOW,
    );
    expect(items.map((item) => item.key)).toEqual([pid(1), pid(2)]);
    // O mesmo processo está em "Comigo" e em "Atrasados" (FA-03).
    expect(
      itemsOfView('MINE', { processes: [mineLate], approvals: [], participations: [] }, v, NOW),
    ).toHaveLength(1);
  });

  it('RN-INBOX-08: acompanhando = participação individual não revogada e não vencida', () => {
    const v = viewer();
    const process = row(1);
    const participation = (userId: string, expiresAt: Date | null) => ({
      tenantId: T,
      processId: process.id,
      userId,
      expiresAt,
    });
    expect(isFollowing(process, [participation(ANA, null)], v, NOW)).toBe(true);
    expect(isFollowing(process, [participation(ANA, new Date('2026-12-01'))], v, NOW)).toBe(true);
    expect(isFollowing(process, [participation(ANA, new Date('2026-10-01'))], v, NOW)).toBe(false);
    expect(isFollowing(process, [participation(CARLOS, null)], v, NOW)).toBe(false);
  });
});

describe('RN-INBOX-07 · POL-03: aprovações pendentes do usuário', () => {
  const process = row(1);

  it('USER: só o aprovador direto', () => {
    expect(isDesignatedApprover(approval(1), process, viewer())).toBe(true);
    expect(isDesignatedApprover(approval(1, { approverUserId: CARLOS }), process, viewer())).toBe(
      false,
    );
  });

  it('DEPARTMENT_HEAD: titular; substituto só com allowDeputy', () => {
    const head = approval(1, {
      approverType: 'DEPARTMENT_HEAD',
      approverUserId: null,
      approverDepartmentId: MANUT,
    });
    expect(
      isDesignatedApprover(
        head,
        process,
        viewer({ leadership: { headOf: [MANUT], deputyOf: [] } }),
      ),
    ).toBe(true);
    const deputy = viewer({ leadership: { headOf: [], deputyOf: [MANUT] } });
    expect(isDesignatedApprover(head, process, deputy)).toBe(false);
    expect(isDesignatedApprover({ ...head, allowDeputy: true }, process, deputy)).toBe(true);
    expect(isDesignatedApprover({ ...head, approverDepartmentId: null }, process, deputy)).toBe(
      false,
    );
  });

  it('ROLE: perfil com escopo que cobre o órgão ou a unidade solicitante', () => {
    const byRole = approval(1, {
      approverType: 'ROLE',
      approverUserId: null,
      approverRoleId: ROLE,
    });
    const competence = (patch: Partial<InboxViewerFacts['roles'][number]>) =>
      viewer({
        roles: [
          { roleId: ROLE, tenantWide: false, organizationId: null, departmentIds: [], ...patch },
        ],
      });
    expect(isDesignatedApprover(byRole, process, competence({ tenantWide: true }))).toBe(true);
    expect(isDesignatedApprover(byRole, process, competence({ organizationId: ORG }))).toBe(true);
    expect(isDesignatedApprover(byRole, process, competence({ organizationId: OTHER_ORG }))).toBe(
      false,
    );
    expect(isDesignatedApprover(byRole, process, competence({ departmentIds: [OBRAS] }))).toBe(
      true,
    );
    expect(isDesignatedApprover(byRole, process, competence({ departmentIds: [MANUT] }))).toBe(
      true,
    );
    expect(isDesignatedApprover(byRole, process, competence({ departmentIds: [COMPRAS] }))).toBe(
      false,
    );
    expect(
      isDesignatedApprover(
        { ...byRole, approverRoleId: pid(9) },
        process,
        competence({ tenantWide: true }),
      ),
    ).toBe(false);
  });

  it('uma linha por aprovação pendente, só de processos do conjunto (visíveis)', () => {
    const items = itemsOfView(
      'PENDING_APPROVALS',
      {
        processes: [process],
        approvals: [approval(1), approval(1, { id: pid(2999) }), approval(7)],
        participations: [],
      },
      viewer(),
      NOW,
    );
    expect(items.map((item) => item.key)).toEqual([pid(2001), pid(2999)]);
  });

  it('US-136 (RN-APV-62): uma linha por ApprovalApprover; a mesma linha lida duas vezes conta uma', () => {
    const lineOf = (sequence: number) =>
      approval(1, { id: pid(3000 + sequence), approvalId: pid(2001), sequence });
    const items = itemsOfView(
      'PENDING_APPROVALS',
      { processes: [process], approvals: [lineOf(1), lineOf(2), lineOf(2)], participations: [] },
      viewer(),
      NOW,
    );
    expect(items.map((item) => item.key)).toEqual([pid(3001), pid(3002)]);
    expect(new Set(items.map((item) => item.approval?.approvalId))).toEqual(new Set([pid(2001)]));
  });

  it('US-136 (RN-APV-63): prazo da linha, senão da aprovação, senão da etapa', () => {
    const stageDue = new Date('2026-10-30T02:59:59.999Z');
    const approvalDue = new Date('2026-10-25T02:59:59.999Z');
    const lineDue = new Date('2026-10-20T02:59:59.999Z');
    const item = (patch: Partial<InboxApprovalRow>) => ({
      key: pid(3001),
      process: { ...process, dueAt: stageDue },
      approval: approval(1, patch),
      stageId: null,
    });
    expect(dueAtOf(item({ dueAt: approvalDue, lineDueAt: lineDue }))).toBe(lineDue);
    expect(dueAtOf(item({ dueAt: approvalDue }))).toBe(approvalDue);
    expect(dueAtOf(item({ dueAt: null }))).toBe(stageDue);
  });
});

describe('RN-INBOX-11: ação rápida "Assumir"', () => {
  it('sem responsável, lotado na unidade atual, com PROCESS_CLAIM cobrindo e status elegível', () => {
    const v = viewer();
    expect(canClaim(row(1), v)).toBe(true);
    expect(canClaim(row(1, { status: 'RETURNED' }), v)).toBe(true);
    expect(canClaim(row(1, { status: 'SUSPENDED' }), v)).toBe(false);
    expect(canClaim(row(1, { assigneeId: CARLOS }), v)).toBe(false);
    expect(canClaim(row(1, { assignmentDepartmentId: null }), v)).toBe(false);
    expect(canClaim(row(1), viewer({ claim: null }))).toBe(false);
    // Titular sem lotação na unidade atual vê a fila, mas não assume (POL-04).
    expect(
      canClaim(row(1), viewer({ ownDepartmentIds: [MANUT], headOfDepartmentIds: [COMPRAS] })),
    ).toBe(false);
    // Escopo de PROCESS_CLAIM: órgão, tenant ou unidade do processo.
    const scoped = (claim: InboxViewerFacts['claim']) => canClaim(row(1), viewer({ claim }));
    expect(scoped({ tenantWide: true, organizationIds: [], departmentIds: [] })).toBe(true);
    expect(scoped({ tenantWide: false, organizationIds: [ORG], departmentIds: [] })).toBe(true);
    expect(scoped({ tenantWide: false, organizationIds: [], departmentIds: [OBRAS] })).toBe(true);
    expect(scoped({ tenantWide: false, organizationIds: [OTHER_ORG], departmentIds: [] })).toBe(
      false,
    );
  });
});

describe('RN-INBOX-10: ordenação', () => {
  const item = (
    n: number,
    patch: Partial<InboxProcessRow> = {},
    extra: Partial<InboxItemRow> = {},
  ): InboxItemRow => ({
    key: pid(n),
    process: row(n, patch),
    approval: null,
    stageId: null,
    ...extra,
  });
  const keys = (items: InboxItemRow[]) => items.map((entry) => entry.key);

  it('prazo: nulos por último nas duas direções; desempate pela chave (desc)', () => {
    const items = [
      item(1, { dueAt: new Date('2026-10-20') }),
      item(2),
      item(3, { dueAt: new Date('2026-10-25') }),
      item(4),
    ];
    expect(keys([...items].sort(compareItems({ field: 'dueAt', direction: 'desc' })))).toEqual([
      pid(3),
      pid(1),
      pid(4),
      pid(2),
    ]);
    expect(keys([...items].sort(compareItems({ field: 'dueAt', direction: 'asc' })))).toEqual([
      pid(1),
      pid(3),
      pid(4),
      pid(2),
    ]);
  });

  it('código por ano e número (sem número ao final), entrada e solicitação', () => {
    const items = [item(5, { year: 2025 }), item(2), item(9, { number: null, code: null })];
    expect(keys([...items].sort(compareItems({ field: 'code', direction: 'asc' })))).toEqual([
      pid(5),
      pid(2),
      pid(9),
    ]);
    const entered = [
      item(1, { enteredAt: new Date('2026-10-02') }),
      item(2, { enteredAt: new Date('2026-10-05') }),
    ];
    expect(keys(entered.sort(compareItems({ field: 'enteredAt', direction: 'desc' })))).toEqual([
      pid(2),
      pid(1),
    ]);
    const requested = [
      item(1, {}, { approval: approval(1, { requestedAt: new Date('2026-10-12') }) }),
      item(2, {}, { approval: approval(2, { requestedAt: new Date('2026-10-11') }) }),
      item(3),
    ];
    expect(keys(requested.sort(compareItems({ field: 'requestedAt', direction: 'asc' })))).toEqual([
      pid(2),
      pid(1),
      pid(3),
    ]);
  });

  it('o prazo da linha de aprovação é o da aprovação, senão o da etapa', () => {
    const stageDue = new Date('2026-10-30');
    const withDue = item(
      1,
      { dueAt: stageDue },
      { approval: approval(1, { dueAt: new Date('2026-10-21') }) },
    );
    expect(dueAtOf(withDue)?.toISOString()).toBe('2026-10-21T00:00:00.000Z');
    expect(dueAtOf(item(2, { dueAt: stageDue }, { approval: approval(2) }))).toBe(stageDue);
  });
});

describe('matchesRestriction (US-076 · RN-DASH-09)', () => {
  const row = { requestingSecretariatId: OBRAS, requestingDepartmentId: MANUT };

  it('sem recorte, qualquer processo', () => {
    expect(matchesRestriction(row, null)).toBe(true);
    expect(matchesRestriction(row, { secretariatId: null, departmentIds: null })).toBe(true);
  });

  it('secretaria e subárvore do setor, combinadas por E', () => {
    expect(matchesRestriction(row, { secretariatId: OBRAS, departmentIds: null })).toBe(true);
    expect(matchesRestriction(row, { secretariatId: COMPRAS, departmentIds: null })).toBe(false);
    expect(matchesRestriction(row, { secretariatId: OBRAS, departmentIds: [MANUT] })).toBe(true);
    expect(matchesRestriction(row, { secretariatId: null, departmentIds: [COMPRAS] })).toBe(false);
  });
});

describe('US-125 — uma linha por etapa ativa (RN-WF2-29/30/32)', () => {
  const PROCURADORIA = '0192e056-0000-7000-8000-0000000000a4';
  const SPLIT_WS = pid(9000);
  const JUR_WS = pid(9001);
  const CI_WS = pid(9002);
  /** O processo 45 em ramificação: uma linha por ramo, com a etapa, a unidade e a custódia dela. */
  const branchRow = (key: 'JURIDICO' | 'CONTROLE_INTERNO', patch: Partial<InboxProcessRow> = {}) =>
    row(45, {
      currentWorkflowStageId: SPLIT_WS,
      currentDepartmentId: PROCURADORIA,
      currentResponsibleId: null,
      activeStagesCount: 2,
      branchKey: key,
      stageId: key === 'JURIDICO' ? pid(4501) : pid(4502),
      stageWorkflowStageId: key === 'JURIDICO' ? JUR_WS : CI_WS,
      stageDepartmentId: key === 'JURIDICO' ? PROCURADORIA : COMPRAS,
      assignmentDepartmentId: key === 'JURIDICO' ? PROCURADORIA : COMPRAS,
      dueAt:
        key === 'JURIDICO'
          ? new Date('2026-11-18T02:59:59.999Z')
          : new Date('2026-11-20T02:59:59.999Z'),
      ...patch,
    });
  const sources = (processes: InboxProcessRow[], approvals: InboxApprovalRow[] = []) => ({
    processes,
    approvals,
    participations: [{ tenantId: T, processId: pid(45), userId: ANA, expiresAt: null }],
  });

  it('tabela de verdade: cada ramo é avaliado na sua visão; FA-01 com os dois ramos = duas linhas', () => {
    const v = viewer();
    const juridico = branchRow('JURIDICO', { assigneeId: ANA });
    const controle = branchRow('CONTROLE_INTERNO');
    const both = sources([juridico, controle]);
    expect(itemsOfView('MINE', both, v, NOW).map((item) => item.stageId)).toEqual([pid(4501)]);
    expect(itemsOfView('UNIT_QUEUE', both, v, NOW).map((item) => item.stageId)).toEqual([
      pid(4502),
    ]);
    const returned = sources([juridico, { ...controle, assignmentType: 'RETURN' }]);
    expect(itemsOfView('RETURNED', returned, v, NOW).map((item) => item.stageId)).toEqual([
      pid(4502),
    ]);
    const overdue = sources([
      { ...juridico, overdueSince: new Date('2026-11-18T03:15:00.000Z') },
      controle,
    ]);
    expect(itemsOfView('OVERDUE', overdue, v, NOW).map((item) => item.stageId)).toEqual([
      pid(4501),
    ]);
    // FA-01: com a custódia dos dois ramos, duas linhas do mesmo processo.
    const twice = sources([juridico, { ...controle, assigneeId: ANA }]);
    const mine = itemsOfView('MINE', twice, v, NOW);
    expect(mine.map((item) => [item.key, item.stageId])).toEqual([
      [pid(45), pid(4501)],
      [pid(45), pid(4502)],
    ]);
    // `branchKey` restringe às linhas do ramo.
    expect(
      itemsOfView('MINE', twice, v, NOW, 'CONTROLE_INTERNO').map((item) => item.stageId),
    ).toEqual([pid(4502)]);
  });

  it('FOLLOWING: uma linha por processo, a da etapa crítica, sem ramo (linha do processo)', () => {
    const items = itemsOfView(
      'FOLLOWING',
      sources([branchRow('CONTROLE_INTERNO'), branchRow('JURIDICO')]),
      viewer(),
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.stageId).toBeNull();
    expect(items[0]?.process.branchKey).toBeNull();
    expect(items[0]?.process.dueAt).toEqual(new Date('2026-11-18T02:59:59.999Z'));
  });

  it('PENDING_APPROVALS: a linha de aprovação casa com a linha da etapa da aprovação', () => {
    const v = viewer({ leadership: { headOf: [OBRAS], deputyOf: [] } });
    const inBranch = approval(1, {
      processId: pid(45),
      processStageId: pid(4502),
      branchKey: 'CONTROLE_INTERNO',
      approverType: 'DEPARTMENT_HEAD',
      approverDepartmentId: OBRAS,
    });
    const items = itemsOfView(
      'PENDING_APPROVALS',
      sources([branchRow('JURIDICO'), branchRow('CONTROLE_INTERNO')], [inBranch]),
      v,
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.stageId).toBe(pid(4502));
    expect(items[0]?.process.branchKey).toBe('CONTROLE_INTERNO');
    // Aprovação fora de ramo num processo em ramificação: uma linha, a do processo.
    const outside = { ...inBranch, processStageId: null, branchKey: null };
    const [single] = itemsOfView(
      'PENDING_APPROVALS',
      sources([branchRow('JURIDICO'), branchRow('CONTROLE_INTERNO')], [outside]),
      v,
      NOW,
    );
    expect(single?.stageId).toBeNull();
    expect(single?.process.branchKey).toBeNull();
  });

  it('a linha de ramo descreve a etapa: unidade e responsável DELA; "Assumir" pela unidade da etapa', () => {
    const controle = branchRow('CONTROLE_INTERNO');
    expect(rowFocusOf(controle)).toEqual({
      workflowStageId: CI_WS,
      departmentId: COMPRAS,
      responsibleId: null,
    });
    // Lotada em Compras (a unidade do ramo CONTROLE_INTERNO), não na do processo (Procuradoria).
    expect(canClaim(controle, viewer())).toBe(true);
    expect(canClaim(branchRow('JURIDICO'), viewer())).toBe(false);
    // Tronco: os campos do processo, como no MVP 1.
    expect(rowFocusOf(row(1)).departmentId).toBe(COMPRAS);
  });

  it('ordenação: linhas do mesmo processo desempatam pela etapa (paginação determinística)', () => {
    const due = new Date('2026-11-18T02:59:59.999Z');
    const a: InboxItemRow = {
      key: pid(45),
      process: row(45, { dueAt: due }),
      approval: null,
      stageId: pid(1),
    };
    const b: InboxItemRow = { ...a, stageId: pid(2) };
    const c: InboxItemRow = { ...a, stageId: null };
    const sorted = [c, a, b].sort(compareItems({ field: 'dueAt', direction: 'asc' }));
    expect(sorted.map((item) => item.stageId)).toEqual([pid(2), pid(1), null]);
  });
});
