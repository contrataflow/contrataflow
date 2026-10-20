import { describe, expect, it } from 'vitest';

import {
  USER_AGENT_MAX,
  creationGrants,
  enterStage,
  openingMovement,
  stageEntryAssignment,
} from './process-runtime-records.js';

const TENANT = '0192f000-0000-7000-8000-00000000000a';
const PROCESS = '0192f000-0000-7000-8000-000000000001';
const STAGE = '0192f000-0000-7000-8000-0000000000e1';
const WF_STAGE = '0192f000-0000-7000-8000-0000000000e2';
const MOVEMENT = '0192f000-0000-7000-8000-0000000000e3';
const OBRAS = '0192f000-0000-7000-8000-0000000000d1';
const MANUTENCAO = '0192f000-0000-7000-8000-0000000000d2';
const ANA = '0192f000-0000-7000-8000-0000000000a1';
const AT = new Date('2026-10-16T13:00:00.000Z');
const DUE = new Date('2026-10-23T02:59:59.999Z');

const stage = enterStage({
  id: STAGE,
  tenantId: TENANT,
  processId: PROCESS,
  workflowStageId: WF_STAGE,
  sequence: 1,
  departmentId: MANUTENCAO,
  assigneeId: ANA,
  enteredAt: AT,
  dueAt: DUE,
  slaDays: 5,
  slaType: 'BUSINESS',
  movementId: MOVEMENT,
});

describe('Runtime da tramitação na criação (US-001 · passos 7.7–7.10)', () => {
  it('ProcessStage nº 1 ATIVA com SLA congelado; sem SLA, sem tipo de contagem', () => {
    expect(stage).toMatchObject({
      sequence: 1,
      status: 'ACTIVE',
      departmentId: MANUTENCAO,
      assigneeId: ANA,
      dueAt: DUE,
      slaDays: 5,
      slaType: 'BUSINESS',
      enteredViaMovementId: MOVEMENT,
    });
    expect(
      enterStage({ ...stageInput(), slaDays: null, slaType: 'BUSINESS', dueAt: null }).slaType,
    ).toBeNull();
  });

  it('ProcessAssignment STAGE_ENTRY ativo e automático', () => {
    expect(stageEntryAssignment('0192f000-0000-7000-8000-0000000000e4', stage)).toEqual({
      id: '0192f000-0000-7000-8000-0000000000e4',
      tenantId: TENANT,
      processId: PROCESS,
      processStageId: STAGE,
      departmentId: MANUTENCAO,
      assigneeId: ANA,
      type: 'STAGE_ENTRY',
      assignedById: null,
      startedAt: AT,
    });
  });

  it('ProcessMovement nº 1 CREATE com IP, user-agent (≤ 512) e correlationId', () => {
    const movement = openingMovement({
      id: MOVEMENT,
      stage,
      actorId: ANA,
      ip: '203.0.113.7',
      userAgent: 'x'.repeat(600),
      correlationId: 'c-us001',
      channel: 'WEB',
    });
    expect(movement).toMatchObject({
      sequence: 1,
      action: 'CREATE',
      toProcessStageId: STAGE,
      toDepartmentId: MANUTENCAO,
      toUserId: ANA,
      statusFrom: null,
      statusTo: 'DRAFT',
      actorId: ANA,
      ip: '203.0.113.7',
      correlationId: 'c-us001',
      occurredAt: AT,
      metadata: { channel: 'WEB', calculatedDueAt: DUE.toISOString(), dueDateOverridden: false },
    });
    expect(movement.userAgent).toHaveLength(USER_AGENT_MAX);
    expect(openingMovement({ ...movementInput(), ip: '', userAgent: null })).toMatchObject({
      ip: null,
      userAgent: null,
    });
  });

  it('concessões da criação (permissions.md §5): REQUESTING, CURRENT, CREATOR e RESPONSIBLE, sem repetir', () => {
    expect(
      creationGrants({
        requestingSecretariatId: OBRAS,
        requestingDepartmentId: MANUTENCAO,
        currentDepartmentId: MANUTENCAO,
        creatorId: ANA,
        responsibleId: ANA,
      }),
    ).toEqual([
      { principalType: 'DEPARTMENT', departmentId: OBRAS, reason: 'REQUESTING' },
      { principalType: 'DEPARTMENT', departmentId: MANUTENCAO, reason: 'REQUESTING' },
      { principalType: 'DEPARTMENT', departmentId: MANUTENCAO, reason: 'CURRENT' },
      { principalType: 'USER', userId: ANA, reason: 'CREATOR' },
      { principalType: 'USER', userId: ANA, reason: 'RESPONSIBLE' },
    ]);
    expect(
      creationGrants({
        requestingSecretariatId: OBRAS,
        requestingDepartmentId: OBRAS,
        currentDepartmentId: OBRAS,
        creatorId: null,
        responsibleId: null,
      }),
    ).toEqual([
      { principalType: 'DEPARTMENT', departmentId: OBRAS, reason: 'REQUESTING' },
      { principalType: 'DEPARTMENT', departmentId: OBRAS, reason: 'CURRENT' },
    ]);
  });
});

function stageInput() {
  return {
    id: STAGE,
    tenantId: TENANT,
    processId: PROCESS,
    workflowStageId: WF_STAGE,
    sequence: 1,
    departmentId: MANUTENCAO,
    assigneeId: ANA,
    enteredAt: AT,
    dueAt: DUE,
    slaDays: 5,
    slaType: 'BUSINESS' as const,
    movementId: MOVEMENT,
  };
}

function movementInput() {
  return {
    id: MOVEMENT,
    stage,
    actorId: ANA,
    ip: '203.0.113.7',
    userAgent: 'vitest',
    correlationId: 'c-us001',
    channel: 'WEB',
  };
}
