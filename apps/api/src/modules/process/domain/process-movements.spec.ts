import { describe, expect, it } from 'vitest';

import {
  compareMovements,
  matchesMovementSearch,
  movementCriteriaOf,
  movementFilterKeys,
  movementReferencesOf,
  toMovementItem,
  unresolvedReferences,
} from './process-movements.js';
import type { MovementFeedSearch, MovementNames, StoredMovement } from './process-movements.js';

/* US-054 — histórico de tramitações: critérios, cursor por `sequence`, referências e presenter. */

const id = (suffix: string) => `0192f054-0000-7000-8000-${suffix.padStart(12, '0')}`;
const PROCESS = id('p1');
const ORIGIN = id('d1');
const TARGET = id('d2');
const ACTOR_UNIT = id('d3');
const ANA = id('u1');
const CARLOS = id('u2');
const STAGE_A = id('s1');
const STAGE_B = id('s2');
const APPROVAL = id('a1');

function movement(sequence: number, patch: Partial<StoredMovement> = {}): StoredMovement {
  return {
    id: id(`m${sequence}`),
    tenantId: id('t1'),
    processId: PROCESS,
    sequence,
    action: 'FORWARD',
    workflowTransitionId: null,
    fromProcessStageId: id('ps1'),
    toProcessStageId: id('ps2'),
    fromWorkflowStageId: STAGE_A,
    toWorkflowStageId: STAGE_B,
    fromDepartmentId: ORIGIN,
    toDepartmentId: TARGET,
    fromUserId: ANA,
    toUserId: null,
    statusFrom: 'IN_PROGRESS',
    statusTo: 'IN_PROGRESS',
    actorType: 'USER',
    actorId: ANA,
    actorDepartmentId: ACTOR_UNIT,
    comment: 'Segue para cotação.',
    dueAt: new Date('2026-10-10T20:59:59.000Z'),
    documents: [],
    approvalId: null,
    ip: '200.10.20.30',
    userAgent: 'Mozilla/5.0',
    correlationId: 'corr-1',
    metadata: {},
    occurredAt: new Date(`2026-10-0${String(sequence)}T12:00:00.000Z`),
    ...patch,
  };
}

const search = (patch: Partial<MovementFeedSearch> = {}): MovementFeedSearch => ({
  processId: PROCESS,
  actions: null,
  fromDepartmentId: null,
  toDepartmentId: null,
  actorId: null,
  occurredFrom: null,
  occurredTo: null,
  beforeSequence: null,
  take: 51,
  ...patch,
});

const NAMES: MovementNames = {
  stages: new Map([
    [STAGE_A, 'Abertura'],
    [STAGE_B, 'Pesquisa de preços'],
  ]),
  departments: new Map([
    [ORIGIN, { name: 'Setor de Manutenção', isActive: true }],
    [TARGET, { name: 'Setor de Cotações', isActive: false }],
    [ACTOR_UNIT, { name: 'Secretaria de Obras', isActive: true }],
  ]),
  users: new Map([[ANA, { name: 'Ana Souza', isActive: true }]]),
  approvals: new Map([
    [APPROVAL, { title: 'Aprovação do TR', status: 'APPROVED', decision: 'APPROVE' }],
  ]),
};

describe('Histórico de tramitações — domínio (US-054)', () => {
  it('movementCriteriaOf: filtros da query viram critérios; ausentes = null', () => {
    expect(movementCriteriaOf({ limit: 50 })).toEqual({
      actions: null,
      fromDepartmentId: null,
      toDepartmentId: null,
      actorId: null,
      occurredFrom: null,
      occurredTo: null,
    });
    expect(
      movementCriteriaOf({
        limit: 50,
        action: ['FORWARD', 'RETURN'],
        fromDepartmentId: ORIGIN,
        toDepartmentId: TARGET,
        actorId: ANA,
        occurredFrom: '2026-10-01T00:00:00.000Z',
        occurredTo: '2026-10-02T00:00:00.000Z',
      }),
    ).toEqual({
      actions: ['FORWARD', 'RETURN'],
      fromDepartmentId: ORIGIN,
      toDepartmentId: TARGET,
      actorId: ANA,
      occurredFrom: new Date('2026-10-01T00:00:00.000Z'),
      occurredTo: new Date('2026-10-02T00:00:00.000Z'),
    });
  });

  it('movementFilterKeys: só as chaves usadas, nunca os valores', () => {
    expect(movementFilterKeys({ limit: 50 })).toEqual([]);
    expect(movementFilterKeys({ limit: 50, action: ['CREATE'], actorId: ANA })).toEqual([
      'action',
      'actorId',
    ]);
  });

  it('matchesMovementSearch: ações por OU, demais por E, período inclusivo e cursor estrito', () => {
    const forward = movement(2);
    expect(matchesMovementSearch(forward, search())).toBe(true);
    expect(matchesMovementSearch(forward, search({ processId: id('p2') }))).toBe(false);
    expect(matchesMovementSearch(forward, search({ actions: ['RETURN', 'FORWARD'] }))).toBe(true);
    expect(matchesMovementSearch(forward, search({ actions: ['RETURN'] }))).toBe(false);
    expect(matchesMovementSearch(forward, search({ fromDepartmentId: ORIGIN }))).toBe(true);
    expect(matchesMovementSearch(forward, search({ fromDepartmentId: TARGET }))).toBe(false);
    expect(matchesMovementSearch(forward, search({ toDepartmentId: TARGET }))).toBe(true);
    expect(matchesMovementSearch(forward, search({ toDepartmentId: ORIGIN }))).toBe(false);
    expect(matchesMovementSearch(forward, search({ actorId: CARLOS }))).toBe(false);
    expect(
      matchesMovementSearch(
        forward,
        search({ actorId: ANA, actions: ['RETURN'] }), // E entre filtros distintos
      ),
    ).toBe(false);
    const at = forward.occurredAt;
    expect(matchesMovementSearch(forward, search({ occurredFrom: at, occurredTo: at }))).toBe(true);
    expect(
      matchesMovementSearch(forward, search({ occurredFrom: new Date(at.getTime() + 1) })),
    ).toBe(false);
    expect(matchesMovementSearch(forward, search({ occurredTo: new Date(at.getTime() - 1) }))).toBe(
      false,
    );
    expect(matchesMovementSearch(forward, search({ beforeSequence: 3 }))).toBe(true);
    expect(matchesMovementSearch(forward, search({ beforeSequence: 2 }))).toBe(false);
  });

  it('compareMovements: sequence decrescente (mais recente primeiro)', () => {
    const sorted = [movement(1), movement(3), movement(2)].sort(compareMovements);
    expect(sorted.map((item) => item.sequence)).toEqual([3, 2, 1]);
  });

  it('movementReferencesOf: ids distintos por tipo, sem nulos (uma leitura por tipo)', () => {
    const references = movementReferencesOf([
      movement(1, { action: 'CREATE', fromDepartmentId: null, fromUserId: null }),
      movement(2, { approvalId: APPROVAL }),
      movement(3, { approvalId: APPROVAL, toUserId: CARLOS }),
    ]);
    expect([...references.departmentIds].sort()).toEqual([ORIGIN, TARGET, ACTOR_UNIT].sort());
    expect([...references.userIds].sort()).toEqual([ANA, CARLOS].sort());
    expect(references.approvalIds).toEqual([APPROVAL]);
    expect([...references.processStageIds].sort()).toEqual([id('ps1'), id('ps2')].sort());
  });

  it('toMovementItem: nomes hidratados, inativo marcado e ip só com AUDIT_VIEW (RN-TRAM-74)', () => {
    const record = movement(2, { approvalId: APPROVAL });
    const withoutAudit = toMovementItem(record, NAMES, false);
    expect(withoutAudit).toEqual({
      id: record.id,
      sequence: 2,
      action: 'FORWARD',
      fromStage: { id: STAGE_A, name: 'Abertura' },
      toStage: { id: STAGE_B, name: 'Pesquisa de preços' },
      fromDepartment: { id: ORIGIN, name: 'Setor de Manutenção', isActive: true },
      toDepartment: { id: TARGET, name: 'Setor de Cotações', isActive: false },
      fromUser: { id: ANA, name: 'Ana Souza', isActive: true },
      toUser: null,
      statusFrom: 'IN_PROGRESS',
      statusTo: 'IN_PROGRESS',
      actor: {
        type: 'USER',
        id: ANA,
        name: 'Ana Souza',
        departmentName: 'Secretaria de Obras',
      },
      comment: 'Segue para cotação.',
      dueAt: '2026-10-10T20:59:59.000Z',
      documents: [],
      approvalId: APPROVAL,
      approvalSummary: { title: 'Aprovação do TR', status: 'APPROVED', decision: 'APPROVE' },
      occurredAt: '2026-10-02T12:00:00.000Z',
      ip: null,
      userAgent: 'Mozilla/5.0',
      correlationId: 'corr-1',
    });
    expect(toMovementItem(record, NAMES, true).ip).toBe('200.10.20.30');
  });

  it('toMovementItem: referência não hidratada sai com nome null; ator de sistema sem nome', () => {
    const item = toMovementItem(
      movement(1, {
        actorType: 'SYSTEM',
        actorId: null,
        actorDepartmentId: null,
        toUserId: CARLOS,
        toWorkflowStageId: id('s9'),
        dueAt: null,
        approvalId: APPROVAL,
      }),
      { ...NAMES, approvals: new Map() },
      true,
    );
    expect(item.actor).toEqual({ type: 'SYSTEM', id: null, name: null, departmentName: null });
    expect(item.toUser).toEqual({ id: CARLOS, name: null, isActive: true });
    expect(item.toStage).toEqual({ id: id('s9'), name: null });
    expect(item.dueAt).toBeNull();
    expect(item.approvalSummary).toBeNull();
  });

  it('unresolvedReferences: conta etapas, unidades e usuários sem nome', () => {
    expect(unresolvedReferences([movement(1)], NAMES)).toEqual({
      stages: 0,
      departments: 0,
      users: 0,
    });
    expect(
      unresolvedReferences(
        [movement(1, { toUserId: CARLOS, toWorkflowStageId: id('s9'), toDepartmentId: id('d9') })],
        NAMES,
      ),
    ).toEqual({ stages: 1, departments: 1, users: 1 });
  });
});
