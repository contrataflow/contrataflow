import { describe, expect, it } from 'vitest';

import { ProcessNotCompletableError } from './process-completion.js';
import type { Process } from './process.js';
import { planStageTransition, stageChangeAccess } from './stage-transition.js';
import type { StageTransitionInput } from './stage-transition.js';

/*
 * US-047 — plano puro da mudança de etapa (`StageTransitionService` · RN-TRAM-14..17): encerra a
 * passagem e a responsabilidade ativas, abre a nova, registra a tramitação e as desnormalizações.
 */

const id = (suffix: string) => `0192d047-0000-7000-8000-${suffix.padStart(12, '0')}`;
const NOW = new Date('2026-10-05T15:00:00.000Z');
const PLANEJAMENTO = id('a1');
const COMPRAS = id('a2');
const PAULA = id('b1');
const RUI = id('b2');

const process = {
  id: id('c1'),
  tenantId: id('c2'),
  organizationId: id('c3'),
  number: 12,
  year: 2026,
  code: '0012/2026',
  status: 'IN_PROGRESS',
  currentStageId: id('d1'),
  currentWorkflowStageId: id('e1'),
  currentDepartmentId: PLANEJAMENTO,
  currentResponsibleId: PAULA,
  currentStageDueAt: new Date('2026-10-10T02:59:59.999Z'),
  openedAt: new Date('2026-09-01T12:00:00.000Z'),
  updatedAt: new Date('2026-10-04T12:00:00.000Z'),
  updatedById: PAULA,
  version: 14,
} as Process;

function input(overrides: Partial<StageTransitionInput> = {}): StageTransitionInput {
  return {
    process,
    active: {
      id: id('d1'),
      workflowStageId: id('e1'),
      sequence: 3,
      departmentId: PLANEJAMENTO,
      assigneeId: PAULA,
    },
    lastStageSequence: 3,
    lastMovementSequence: 5,
    action: 'FORWARD',
    closeAs: 'COMPLETED',
    transitionId: id('f1'),
    toWorkflowStageId: id('e2'),
    toDepartmentId: COMPRAS,
    toUserId: null,
    assignedById: null,
    slaDays: 10,
    slaType: 'BUSINESS',
    dueAt: new Date('2026-10-21T02:59:59.999Z'),
    dueDateOverrideReason: null,
    statusTo: 'IN_PROGRESS',
    comment: 'ETP concluído; seguem ETP e mapa de riscos',
    documents: [],
    approvalId: null,
    metadata: { v: 1 },
    numbering: null,
    actor: { userId: PAULA, ip: '10.0.0.1', userAgent: 'Mozilla/5.0', correlationId: 'c-1' },
    now: NOW,
    ids: { stage: id('d2'), assignment: id('g1'), movement: id('h1') },
    ...overrides,
  };
}

describe('Feature: Mudança de etapa — plano puro (US-047 · StageTransitionService)', () => {
  it('RN-TRAM-14/15/16: encerra a passagem, abre a seguinte e registra a tramitação completa', () => {
    const plan = planStageTransition(input());

    expect(plan.closed).toEqual({
      id: id('d1'),
      status: 'COMPLETED',
      exitedAt: NOW,
      exitedViaMovementId: id('h1'),
    });
    expect(plan.entered).toMatchObject({
      id: id('d2'),
      sequence: 4,
      status: 'ACTIVE',
      departmentId: COMPRAS,
      assigneeId: null,
      enteredAt: NOW,
      slaDays: 10,
      slaType: 'BUSINESS',
      enteredViaMovementId: id('h1'),
      dueDateOverridden: false,
      dueDateOverrideReason: null,
    });
    expect(plan.assignment).toMatchObject({
      type: 'STAGE_ENTRY',
      processStageId: id('d2'),
      departmentId: COMPRAS,
      assigneeId: null,
      assignedById: null,
      startedAt: NOW,
    });
    expect(plan.movement).toMatchObject({
      sequence: 6,
      action: 'FORWARD',
      workflowTransitionId: id('f1'),
      fromProcessStageId: id('d1'),
      toProcessStageId: id('d2'),
      fromDepartmentId: PLANEJAMENTO,
      toDepartmentId: COMPRAS,
      fromUserId: PAULA,
      toUserId: null,
      statusFrom: 'IN_PROGRESS',
      statusTo: 'IN_PROGRESS',
      actorType: 'USER',
      actorId: PAULA,
      actorDepartmentId: PLANEJAMENTO,
      comment: 'ETP concluído; seguem ETP e mapa de riscos',
      ip: '10.0.0.1',
      userAgent: 'Mozilla/5.0',
      correlationId: 'c-1',
      occurredAt: NOW,
    });
    expect(plan.process).toMatchObject({
      status: 'IN_PROGRESS',
      currentStageId: id('d2'),
      currentWorkflowStageId: id('e2'),
      currentDepartmentId: COMPRAS,
      currentResponsibleId: null,
      currentStageDueAt: new Date('2026-10-21T02:59:59.999Z'),
      code: '0012/2026',
      updatedById: PAULA,
      version: 15,
    });
    expect(plan.expectedVersion).toBe(14);
  });

  it('atribuição direta: a nova passagem nasce com responsável e o autor (RN-TRAM-14)', () => {
    const plan = planStageTransition(input({ toUserId: RUI, assignedById: PAULA }));
    expect(plan.entered.assigneeId).toBe(RUI);
    expect(plan.assignment).toMatchObject({ assigneeId: RUI, assignedById: PAULA });
    expect(plan.process.currentResponsibleId).toBe(RUI);
  });

  it('devolução (US-048): passagem RETURNED, responsabilidade RETURN e processo RETURNED', () => {
    const plan = planStageTransition(
      input({
        action: 'RETURN',
        closeAs: 'RETURNED',
        toUserId: RUI,
        assignmentType: 'RETURN',
        statusTo: 'RETURNED',
      }),
    );
    expect(plan.closed.status).toBe('RETURNED');
    expect(plan.assignment).toMatchObject({ type: 'RETURN', assigneeId: RUI, assignedById: null });
    expect(plan.movement).toMatchObject({ action: 'RETURN', statusTo: 'RETURNED', toUserId: RUI });
    expect(plan.process).toMatchObject({ status: 'RETURNED', currentResponsibleId: RUI });
  });

  it('decisão de aprovação (US-052): tramitação APPROVE com a aprovação; passagem ativa sem conclusão', () => {
    const approvalId = id('c1');
    const plan = planStageTransition(input({ action: 'APPROVE', approvalId }));
    expect(plan.movement).toMatchObject({ action: 'APPROVE', approvalId });
    expect(plan.entered.finishedAt).toBeNull();
    expect(plan.completion).toBeNull();
  });

  it('DOM-09 · RN-PROC-116 (US-052): destino END conclui — passagem encerrada na entrada e processo COMPLETED', () => {
    const plan = planStageTransition(
      input({
        process: { ...process, status: 'AWAITING_APPROVAL' },
        action: 'APPROVE',
        statusTo: 'COMPLETED',
        completion: 'APPROVAL',
        toUserId: null,
      }),
    );
    expect(plan.entered).toMatchObject({ enteredAt: NOW, finishedAt: NOW, assigneeId: null });
    expect(plan.completion).toEqual({ completedAt: NOW, completedById: PAULA, cause: 'APPROVAL' });
    expect(plan.process).toMatchObject({ status: 'COMPLETED', currentStageId: plan.entered.id });
  });

  it('US-010 (RN-PROC-111/116): transição COMPLETE manual conclui pela mesma rotina de domínio', () => {
    const plan = planStageTransition(
      input({ action: 'COMPLETE', statusTo: 'COMPLETED', completion: 'MANUAL', toUserId: null }),
    );
    expect(plan.movement).toMatchObject({ action: 'COMPLETE', statusTo: 'COMPLETED' });
    expect(plan.entered.finishedAt).toEqual(NOW);
    expect(plan.completion).toEqual({ completedAt: NOW, completedById: PAULA, cause: 'MANUAL' });
  });

  it('RN-PROC-114: a conclusão fora do status de origem do caminho é recusada antes de qualquer plano', () => {
    expect(() =>
      planStageTransition(
        input({
          process: { ...process, status: 'RETURNED' },
          action: 'COMPLETE',
          statusTo: 'COMPLETED',
          completion: 'MANUAL',
        }),
      ),
    ).toThrow(ProcessNotCompletableError);
  });

  it('prazo sobrescrito fica marcado com o motivo (RN-TRAM-10)', () => {
    const plan = planStageTransition(input({ dueDateOverrideReason: 'Volume alto de itens' }));
    expect(plan.entered).toMatchObject({
      dueDateOverridden: true,
      dueDateOverrideReason: 'Volume alto de itens',
    });
  });

  it('autuação: número, código e openedAt junto com a mudança (RN-TRAM-18)', () => {
    const plan = planStageTransition(
      input({
        process: { ...process, number: null, code: null, openedAt: null },
        numbering: { number: 12, year: 2026, code: '0012/2026' },
      }),
    );
    expect(plan.process).toMatchObject({
      number: 12,
      year: 2026,
      code: '0012/2026',
      openedAt: NOW,
    });
  });

  it('IP vazio vira nulo e o user-agent é truncado em 512', () => {
    const plan = planStageTransition(
      input({ actor: { userId: PAULA, ip: '', userAgent: 'x'.repeat(600), correlationId: 'c' } }),
    );
    expect(plan.movement.ip).toBeNull();
    expect(plan.movement.userAgent).toHaveLength(512);
  });

  it('RN-TRAM-17: a origem vira HISTORICAL só quando a unidade muda; destino CURRENT e RESPONSIBLE', () => {
    expect(
      stageChangeAccess({ fromDepartmentId: PLANEJAMENTO, toDepartmentId: COMPRAS, toUserId: RUI }),
    ).toEqual({
      historicalDepartmentId: PLANEJAMENTO,
      grants: [
        { principalType: 'DEPARTMENT', departmentId: COMPRAS, reason: 'CURRENT' },
        { principalType: 'USER', userId: RUI, reason: 'RESPONSIBLE' },
      ],
    });
    expect(
      stageChangeAccess({ fromDepartmentId: COMPRAS, toDepartmentId: COMPRAS, toUserId: null }),
    ).toEqual({
      historicalDepartmentId: null,
      grants: [{ principalType: 'DEPARTMENT', departmentId: COMPRAS, reason: 'CURRENT' }],
    });
  });
});
