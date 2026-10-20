import { PROCESS_STATUSES, STAGE_TYPES } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { claimRefusal, planClaim } from './process-claim.js';
import type { ClaimInput } from './process-claim.js';
import type { Process } from './process.js';

/*
 * US-049 — regras puras de assumir o processo (RN-TRAM-31..34): quando se pode assumir e o plano
 * (responsabilidade `CLAIM` sem autor distinto, tramitação `CLAIM` sem motivo, `version + 1`).
 */

const id = (suffix: string) => `0192d049-0000-7000-8000-${suffix.padStart(12, '0')}`;
const NOW = new Date('2026-10-05T15:00:00.000Z');
const COMPRAS = id('a1');
const FELIPE = id('b1');

const process = {
  id: id('c1'),
  tenantId: id('c2'),
  status: 'IN_PROGRESS',
  currentStageId: id('d1'),
  currentWorkflowStageId: id('e1'),
  currentDepartmentId: COMPRAS,
  currentResponsibleId: null,
  currentStageDueAt: new Date('2026-10-10T02:59:59.999Z'),
  updatedAt: new Date('2026-10-04T12:00:00.000Z'),
  updatedById: id('b2'),
  version: 14,
} as Process;

function input(overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    process,
    active: { id: id('d1'), workflowStageId: id('e1') },
    lastMovementSequence: 5,
    metadata: { v: 1 },
    actor: { userId: FELIPE, ip: '10.0.0.1', userAgent: 'Mozilla/5.0', correlationId: 'c-1' },
    now: NOW,
    ids: { assignment: id('g1'), movement: id('h1') },
    ...overrides,
  };
}

describe('Feature: Assumir processo (domínio)', () => {
  describe('RN-TRAM-31/32 — quando se pode assumir', () => {
    it('IN_PROGRESS e RETURNED sem responsável, em etapa TASK/START/END, podem ser assumidos', () => {
      for (const status of ['IN_PROGRESS', 'RETURNED'] as const) {
        for (const type of ['TASK', 'START'] as const) {
          expect(claimRefusal({ status, currentResponsibleId: null }, type)).toBeNull();
        }
      }
    });

    it('os demais status recusam com INVALID_STATUS', () => {
      const refused = PROCESS_STATUSES.filter(
        (status) => claimRefusal({ status, currentResponsibleId: null }, 'TASK') !== null,
      );
      expect(refused).toEqual([
        'DRAFT',
        'AWAITING_APPROVAL',
        'SUSPENDED',
        'CANCELED',
        'COMPLETED',
        'PUBLISHED',
      ]);
      for (const status of refused) {
        expect(claimRefusal({ status, currentResponsibleId: null }, 'TASK')).toBe('INVALID_STATUS');
      }
    });

    it('FA-02: etapa APPROVAL recusa com INVALID_STATUS, mesmo na fila', () => {
      expect(STAGE_TYPES).toContain('APPROVAL');
      expect(claimRefusal({ status: 'IN_PROGRESS', currentResponsibleId: null }, 'APPROVAL')).toBe(
        'INVALID_STATUS',
      );
    });

    it('com responsável individual: ALREADY_ASSIGNED (inclusive para quem já é o responsável)', () => {
      expect(claimRefusal({ status: 'IN_PROGRESS', currentResponsibleId: FELIPE }, 'TASK')).toBe(
        'ALREADY_ASSIGNED',
      );
    });

    it('o status incompatível vem antes de "já assumido"', () => {
      expect(claimRefusal({ status: 'SUSPENDED', currentResponsibleId: FELIPE }, 'TASK')).toBe(
        'INVALID_STATUS',
      );
    });

    it('etapa desconhecida não bloqueia por si só', () => {
      expect(claimRefusal({ status: 'IN_PROGRESS', currentResponsibleId: null }, null)).toBeNull();
    });
  });

  describe('RN-TRAM-33/34 — o plano', () => {
    it('responsabilidade CLAIM sem autor distinto e processo com o novo responsável (versão + 1)', () => {
      const plan = planClaim(input());

      expect(plan.expectedVersion).toBe(14);
      expect(plan.stageId).toBe(id('d1'));
      expect(plan.endedAt).toEqual(NOW);
      expect(plan.assignment).toEqual({
        id: id('g1'),
        tenantId: process.tenantId,
        processId: process.id,
        processStageId: id('d1'),
        departmentId: COMPRAS,
        assigneeId: FELIPE,
        type: 'CLAIM',
        assignedById: null,
        startedAt: NOW,
      });
      expect(plan.process).toMatchObject({
        currentResponsibleId: FELIPE,
        currentStageId: id('d1'),
        currentDepartmentId: COMPRAS,
        status: 'IN_PROGRESS',
        updatedAt: NOW,
        updatedById: FELIPE,
        version: 15,
      });
    });

    it('tramitação CLAIM na mesma passagem, sem motivo, com a origem na fila e o ator', () => {
      const { movement } = planClaim(input());

      expect(movement).toMatchObject({
        id: id('h1'),
        sequence: 6,
        action: 'CLAIM',
        workflowTransitionId: null,
        fromProcessStageId: id('d1'),
        toProcessStageId: id('d1'),
        fromDepartmentId: COMPRAS,
        toDepartmentId: COMPRAS,
        fromUserId: null,
        toUserId: FELIPE,
        statusFrom: 'IN_PROGRESS',
        statusTo: 'IN_PROGRESS',
        actorType: 'USER',
        actorId: FELIPE,
        actorDepartmentId: COMPRAS,
        comment: null,
        documents: [],
        approvalId: null,
        ip: '10.0.0.1',
        userAgent: 'Mozilla/5.0',
        correlationId: 'c-1',
        occurredAt: NOW,
      });
    });

    it('IP e user-agent vazios viram null; o user-agent é truncado', () => {
      const empty = planClaim(
        input({ actor: { userId: FELIPE, ip: '', userAgent: '', correlationId: 'c-1' } }),
      ).movement;
      expect(empty.ip).toBeNull();
      expect(empty.userAgent).toBeNull();
      const long = planClaim(
        input({
          actor: { userId: FELIPE, ip: null, userAgent: 'x'.repeat(900), correlationId: 'c-1' },
        }),
      ).movement;
      expect(long.userAgent).toHaveLength(512);
    });

    it('não altera o processo de entrada', () => {
      planClaim(input());
      expect(process.currentResponsibleId).toBeNull();
      expect(process.version).toBe(14);
    });
  });
});
