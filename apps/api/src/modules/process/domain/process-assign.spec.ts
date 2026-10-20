import { PROCESS_STATUSES, STAGE_TYPES, assignProcessSchema } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { assignReasonMissing, isAssignable, planAssign } from './process-assign.js';
import type { AssignInput } from './process-assign.js';
import type { Process } from './process.js';

/*
 * US-050 — regras puras de atribuir/reatribuir o responsável (RN-TRAM-37..42): quando se pode
 * atribuir, quando o motivo é exigido e o plano (responsabilidade `MANUAL` com o autor, tramitação
 * `ASSIGN` com o motivo, `version + 1`). O corpo do PRC-22 (`assignProcessSchema`) também.
 */

const id = (suffix: string) => `0192d050-0000-7000-8000-${suffix.padStart(12, '0')}`;
const NOW = new Date('2026-10-05T15:00:00.000Z');
const COMPRAS = id('a1');
const FELIPE = id('b1');
const JULIANA = id('b2');
const RENATA = id('b3');

const process = {
  id: id('c1'),
  tenantId: id('c2'),
  status: 'IN_PROGRESS',
  currentStageId: id('d1'),
  currentWorkflowStageId: id('e1'),
  currentDepartmentId: COMPRAS,
  currentResponsibleId: FELIPE,
  currentStageDueAt: new Date('2026-10-10T02:59:59.999Z'),
  updatedAt: new Date('2026-10-04T12:00:00.000Z'),
  updatedById: id('b9'),
  version: 4,
} as Process;

function input(overrides: Partial<AssignInput> = {}): AssignInput {
  return {
    process,
    active: { id: id('d1'), workflowStageId: id('e1') },
    assigneeId: JULIANA,
    reason: 'Felipe está de férias',
    lastMovementSequence: 7,
    metadata: { v: 1 },
    actor: { userId: RENATA, ip: '10.0.0.1', userAgent: 'Mozilla/5.0', correlationId: 'c-1' },
    now: NOW,
    ids: { assignment: id('g1'), movement: id('h1') },
    ...overrides,
  };
}

describe('Feature: Atribuir e reatribuir responsável (domínio)', () => {
  describe('RN-TRAM-37 — quando se pode atribuir', () => {
    it('só IN_PROGRESS e RETURNED, em etapa que não seja APPROVAL', () => {
      const allowed = PROCESS_STATUSES.filter((status) => isAssignable({ status }, 'TASK'));
      expect(allowed).toEqual(['IN_PROGRESS', 'RETURNED']);
      const types = STAGE_TYPES.filter((type) => isAssignable({ status: 'IN_PROGRESS' }, type));
      expect(types).not.toContain('APPROVAL');
      expect(types).toEqual(expect.arrayContaining(['START', 'TASK']));
    });

    it('a etapa desconhecida não bloqueia', () => {
      expect(isAssignable({ status: 'RETURNED' }, null)).toBe(true);
    });
  });

  describe('RN-TRAM-39 — motivo condicional', () => {
    it('reatribuição (já há responsável) exige motivo, inclusive para a fila', () => {
      expect(assignReasonMissing({ currentResponsibleId: FELIPE }, null)).toBe(true);
      expect(assignReasonMissing({ currentResponsibleId: FELIPE }, '')).toBe(true);
      expect(assignReasonMissing({ currentResponsibleId: FELIPE }, 'Felipe está de férias')).toBe(
        false,
      );
    });

    it('FA-01: primeira atribuição a partir da fila dispensa o motivo', () => {
      expect(assignReasonMissing({ currentResponsibleId: null }, null)).toBe(false);
    });
  });

  describe('RN-TRAM-40/42 — o plano', () => {
    it('reatribuição: responsabilidade MANUAL com o autor, tramitação ASSIGN com o motivo, version + 1', () => {
      const plan = planAssign(input());
      expect(plan.expectedVersion).toBe(4);
      expect(plan.stageId).toBe(id('d1'));
      expect(plan.endedAt).toBe(NOW);
      expect(plan.process).toMatchObject({
        currentResponsibleId: JULIANA,
        updatedById: RENATA,
        updatedAt: NOW,
        version: 5,
      });
      expect(plan.assignment).toEqual({
        id: id('g1'),
        tenantId: process.tenantId,
        processId: process.id,
        processStageId: id('d1'),
        departmentId: COMPRAS,
        assigneeId: JULIANA,
        type: 'MANUAL',
        assignedById: RENATA,
        startedAt: NOW,
      });
      expect(plan.movement).toMatchObject({
        id: id('h1'),
        sequence: 8,
        action: 'ASSIGN',
        workflowTransitionId: null,
        fromProcessStageId: id('d1'),
        toProcessStageId: id('d1'),
        fromDepartmentId: COMPRAS,
        toDepartmentId: COMPRAS,
        fromUserId: FELIPE,
        toUserId: JULIANA,
        statusFrom: 'IN_PROGRESS',
        statusTo: 'IN_PROGRESS',
        actorType: 'USER',
        actorId: RENATA,
        comment: 'Felipe está de férias',
        dueAt: process.currentStageDueAt,
        documents: [],
        ip: '10.0.0.1',
        userAgent: 'Mozilla/5.0',
      });
    });

    it('FA-02: remover o responsável deixa o processo na fila (assigneeId null) na mesma unidade', () => {
      const plan = planAssign(input({ assigneeId: null, reason: 'Redistribuir na equipe' }));
      expect(plan.process.currentResponsibleId).toBeNull();
      expect(plan.process.currentDepartmentId).toBe(COMPRAS);
      expect(plan.assignment).toMatchObject({ assigneeId: null, type: 'MANUAL' });
      expect(plan.movement).toMatchObject({ fromUserId: FELIPE, toUserId: null });
    });

    it('RN-TRAM-41: autoatribuição a partir da fila, sem motivo; IP vazio e user-agent longo normalizados', () => {
      const plan = planAssign(
        input({
          process: { ...process, currentResponsibleId: null },
          assigneeId: RENATA,
          reason: null,
          actor: { userId: RENATA, ip: '', userAgent: 'x'.repeat(2000), correlationId: 'c-2' },
        }),
      );
      expect(plan.movement).toMatchObject({ fromUserId: null, toUserId: RENATA, comment: null });
      expect(plan.movement.ip).toBeNull();
      expect(plan.movement.userAgent?.length).toBeLessThan(2000);
      expect(
        planAssign(input({ actor: { ...input().actor, userAgent: null } })).movement.userAgent,
      ).toBeNull();
    });
  });

  describe('assignProcessSchema (V-01..V-03)', () => {
    it('assigneeId sempre presente (pode ser null)', () => {
      expect(assignProcessSchema.safeParse({}).success).toBe(false);
      expect(assignProcessSchema.parse({ assigneeId: null })).toEqual({ assigneeId: null });
      expect(assignProcessSchema.parse({ assigneeId: JULIANA })).toEqual({ assigneeId: JULIANA });
    });

    it('reason com 10–2.000 caracteres (aparado); campo extra é recusado', () => {
      const short = assignProcessSchema.safeParse({ assigneeId: JULIANA, reason: '  curto  ' });
      expect(short.success).toBe(false);
      expect(short.error?.issues[0]?.message).toBe('O motivo deve ter ao menos 10 caracteres.');
      expect(
        assignProcessSchema.safeParse({ assigneeId: JULIANA, reason: 'x'.repeat(2001) }).success,
      ).toBe(false);
      expect(
        assignProcessSchema.parse({ assigneeId: JULIANA, reason: '  Felipe de férias  ' }),
      ).toEqual({ assigneeId: JULIANA, reason: 'Felipe de férias' });
      expect(assignProcessSchema.safeParse({ assigneeId: null, extra: 1 }).success).toBe(false);
    });
  });
});
