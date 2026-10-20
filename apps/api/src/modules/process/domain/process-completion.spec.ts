import type { ProcessStatus } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  ProcessNotCompletableError,
  canCompleteFrom,
  completeProcess,
  planCompletionAtEnd,
} from './process-completion.js';
import type { Process } from './process.js';

/*
 * US-010 — rotina de domínio da conclusão (RN-PROC-111..117), compartilhada pela conclusão manual
 * (PRC-26) e pela automática (decisão `APPROVE` → etapa `END`, US-052).
 */

const id = (suffix: string) => `0192d010-0000-7000-8000-${suffix.padStart(12, '0')}`;
const NOW = new Date('2026-10-20T15:00:00.000Z');
const CARLA = id('b1');
const OBRAS = id('a1');

const process = {
  id: id('c1'),
  tenantId: id('c2'),
  code: '0012/2026',
  status: 'IN_PROGRESS',
  currentStageId: id('d1'),
  currentWorkflowStageId: id('e1'),
  currentDepartmentId: OBRAS,
  currentResponsibleId: CARLA,
  currentStageDueAt: null,
  updatedAt: new Date('2026-10-19T12:00:00.000Z'),
  updatedById: CARLA,
  version: 5,
} as Process;

const STATUSES: readonly ProcessStatus[] = [
  'DRAFT',
  'IN_PROGRESS',
  'AWAITING_APPROVAL',
  'RETURNED',
  'SUSPENDED',
  'CANCELED',
  'COMPLETED',
  'PUBLISHED',
];

describe('Process.complete (US-010 · RN-PROC-111..117)', () => {
  it.each(STATUSES)(
    'RN-PROC-114: manual só de IN_PROGRESS; automática só de AWAITING_APPROVAL (%s)',
    (status) => {
      expect(canCompleteFrom(status, 'MANUAL')).toBe(status === 'IN_PROGRESS');
      expect(canCompleteFrom(status, 'APPROVAL')).toBe(status === 'AWAITING_APPROVAL');
    },
  );

  it('RN-PROC-115: completedAt = now e completedById = quem confirmou, com o caminho', () => {
    expect(
      completeProcess({ status: 'IN_PROGRESS', cause: 'MANUAL', actorId: CARLA, now: NOW }),
    ).toEqual({ completedAt: NOW, completedById: CARLA, cause: 'MANUAL' });
    const approver = id('b2');
    expect(
      completeProcess({
        status: 'AWAITING_APPROVAL',
        cause: 'APPROVAL',
        actorId: approver,
        now: NOW,
      }),
    ).toEqual({ completedAt: NOW, completedById: approver, cause: 'APPROVAL' });
  });

  it.each<ProcessStatus>(['DRAFT', 'RETURNED', 'SUSPENDED', 'COMPLETED'])(
    'RN-PROC-114/117: %s nunca conclui diretamente (COMPLETED é final)',
    (status) => {
      expect(() => completeProcess({ status, cause: 'MANUAL', actorId: CARLA, now: NOW })).toThrow(
        ProcessNotCompletableError,
      );
    },
  );

  it('FA-03 · RN-PROC-116: na etapa END ativa, encerra a passagem com a tramitação COMPLETE e conclui', () => {
    const plan = planCompletionAtEnd({
      process,
      active: {
        id: id('d1'),
        workflowStageId: id('e1'),
        dueAt: null,
        slaType: null,
        pausedAt: null,
        overdueSince: null,
      },
      comment: 'Planejamento pronto para a seleção do fornecedor',
      lastMovementSequence: 7,
      metadata: { v: 1 },
      actor: { userId: CARLA, ip: '10.0.0.1', userAgent: 'Vitest', correlationId: 'corr-1' },
      now: NOW,
      movementId: id('f1'),
    });
    expect(plan.process).toMatchObject({
      status: 'COMPLETED',
      currentStageId: id('d1'),
      // RN-PROC-116: o responsável fica como referência histórica.
      currentResponsibleId: CARLA,
      updatedById: CARLA,
      version: 6,
    });
    expect(plan.expectedVersion).toBe(5);
    expect(plan.completion).toEqual({ completedAt: NOW, completedById: CARLA, cause: 'MANUAL' });
    expect(plan.stage).toEqual({ id: id('d1'), exitedAt: NOW, exitedViaMovementId: id('f1') });
    expect(plan.movement).toMatchObject({
      id: id('f1'),
      sequence: 8,
      action: 'COMPLETE',
      workflowTransitionId: null,
      fromProcessStageId: id('d1'),
      toProcessStageId: id('d1'),
      statusFrom: 'IN_PROGRESS',
      statusTo: 'COMPLETED',
      comment: 'Planejamento pronto para a seleção do fornecedor',
      actorId: CARLA,
    });
  });

  it('FA-03: processo suspenso na etapa END não conclui (FA-04)', () => {
    expect(() =>
      planCompletionAtEnd({
        process: { ...process, status: 'SUSPENDED' },
        active: {
          id: id('d1'),
          workflowStageId: id('e1'),
          dueAt: null,
          slaType: null,
          pausedAt: null,
          overdueSince: null,
        },
        comment: null,
        lastMovementSequence: 1,
        metadata: {},
        actor: { userId: CARLA, ip: null, userAgent: null, correlationId: 'corr-2' },
        now: NOW,
        movementId: id('f2'),
      }),
    ).toThrow(ProcessNotCompletableError);
  });
});
