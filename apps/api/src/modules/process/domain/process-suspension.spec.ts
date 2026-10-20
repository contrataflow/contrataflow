import { PROCESS_STATUSES } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { isSuspendable, planResume, planSuspension } from './process-suspension.js';
import type { ResumeInput, SuspendedPass, SuspendInput } from './process-suspension.js';
import type { Process } from './process.js';

/*
 * US-008 — regras puras de suspender e retomar (RN-PROC-93..102): status de origem, o plano da
 * suspensão (status anterior, pausa, tramitação `SUSPEND` com o motivo) e o da retomada (status
 * restaurado, prazo estendido, pausa acumulada, atraso persistente × desfeito).
 */

const id = (suffix: string) => `0192d008-0000-7000-8000-${suffix.padStart(12, '0')}`;
const SUSPENDED_AT = new Date('2026-10-06T13:00:00.000Z'); // 06/10 10:00 em Brasília
const RESUMED_AT = new Date('2026-10-13T18:00:00.000Z'); // 13/10 15:00 em Brasília
const DUE = new Date('2026-10-10T02:59:59.999Z'); // fim de 09/10
const EXTENDED = new Date('2026-10-17T02:59:59.999Z'); // fim de 16/10
const PATRICIA = id('b1');
const JULIANA = id('b2');
const REASON = 'Aguardando definição da dotação pela Secretaria de Finanças';

const process = {
  id: id('c1'),
  tenantId: id('c2'),
  code: '0012/2026',
  status: 'IN_PROGRESS',
  currentStageId: id('d1'),
  currentWorkflowStageId: id('e1'),
  currentDepartmentId: id('a1'),
  currentResponsibleId: JULIANA,
  currentStageDueAt: DUE,
  targetDate: '2026-11-30',
  updatedAt: new Date('2026-10-05T12:00:00.000Z'),
  updatedById: JULIANA,
  version: 12,
} as Process;

const active: SuspendedPass = {
  id: id('d1'),
  workflowStageId: id('e1'),
  dueAt: DUE,
  slaType: 'BUSINESS',
  pausedAt: null,
  overdueSince: null,
};

const actor = { userId: PATRICIA, ip: '10.0.0.1', userAgent: 'Mozilla/5.0', correlationId: 'c-1' };

function suspendInput(overrides: Partial<SuspendInput> = {}): SuspendInput {
  return {
    process,
    active,
    reason: REASON,
    lastMovementSequence: 4,
    metadata: { v: 1 },
    actor,
    now: SUSPENDED_AT,
    movementId: id('f1'),
    ...overrides,
  };
}

function resumeInput(overrides: Partial<ResumeInput> = {}): ResumeInput {
  return {
    process: { ...process, status: 'SUSPENDED', version: 13 },
    active: { ...active, pausedAt: SUSPENDED_AT },
    restoreTo: 'IN_PROGRESS',
    extension: { days: 4, slaType: 'BUSINESS', newDueAt: EXTENDED },
    comment: null,
    lastMovementSequence: 5,
    metadata: { v: 1 },
    actor,
    now: RESUMED_AT,
    movementId: id('f2'),
    ...overrides,
  };
}

describe('Feature: Suspender e retomar processo (domínio)', () => {
  it('RN-PROC-93: suspende-se só a partir de IN_PROGRESS, AWAITING_APPROVAL e RETURNED', () => {
    expect(PROCESS_STATUSES.filter(isSuspendable)).toEqual([
      'IN_PROGRESS',
      'AWAITING_APPROVAL',
      'RETURNED',
    ]);
  });

  describe('planSuspension (RN-PROC-94/95/102)', () => {
    it('guarda o status anterior, pausa a passagem e registra a tramitação SUSPEND com o motivo', () => {
      const plan = planSuspension(suspendInput());
      expect(plan.process).toMatchObject({
        status: 'SUSPENDED',
        version: 13,
        updatedById: PATRICIA,
        updatedAt: SUSPENDED_AT,
        // Etapa, unidade, responsável e prazo não mudam.
        currentStageId: process.currentStageId,
        currentDepartmentId: process.currentDepartmentId,
        currentResponsibleId: JULIANA,
        currentStageDueAt: DUE,
      });
      expect(plan.expectedVersion).toBe(12);
      expect(plan.suspension).toEqual({
        statusBeforeSuspension: 'IN_PROGRESS',
        suspendedAt: SUSPENDED_AT,
        suspendedById: PATRICIA,
        suspensionReason: REASON,
      });
      expect(plan).toMatchObject({ stageId: active.id, pausedAt: SUSPENDED_AT });
      expect(plan.movement).toMatchObject({
        id: id('f1'),
        sequence: 5,
        action: 'SUSPEND',
        statusFrom: 'IN_PROGRESS',
        statusTo: 'SUSPENDED',
        comment: REASON,
        fromProcessStageId: active.id,
        toProcessStageId: active.id,
        fromDepartmentId: process.currentDepartmentId,
        toDepartmentId: process.currentDepartmentId,
        fromUserId: JULIANA,
        toUserId: JULIANA,
        actorId: PATRICIA,
        dueAt: DUE,
        documents: [],
        ip: '10.0.0.1',
        correlationId: 'c-1',
      });
    });

    it('em AWAITING_APPROVAL guarda o status de aprovação; user-agent vazio vira null', () => {
      const plan = planSuspension(
        suspendInput({
          process: { ...process, status: 'AWAITING_APPROVAL' },
          actor: { ...actor, ip: '', userAgent: '' },
        }),
      );
      expect(plan.suspension.statusBeforeSuspension).toBe('AWAITING_APPROVAL');
      expect(plan.movement).toMatchObject({
        statusFrom: 'AWAITING_APPROVAL',
        ip: null,
        userAgent: null,
      });
    });

    it('passagem já pausada mantém o instante original da pausa', () => {
      const earlier = new Date('2026-10-01T12:00:00.000Z');
      expect(
        planSuspension(suspendInput({ active: { ...active, pausedAt: earlier } })).pausedAt,
      ).toBe(earlier);
    });
  });

  describe('planResume (RN-PROC-97..99)', () => {
    it('restaura o status, estende o prazo pelos dias suspensos e acumula 622800 s de pausa', () => {
      const plan = planResume(resumeInput({ comment: 'Dotação definida' }));
      expect(plan.process).toMatchObject({
        status: 'IN_PROGRESS',
        currentStageDueAt: EXTENDED,
        version: 14,
        updatedById: PATRICIA,
        targetDate: '2026-11-30',
      });
      expect(plan.expectedVersion).toBe(13);
      expect(plan.stage).toEqual({
        id: active.id,
        dueAt: EXTENDED,
        pausedSeconds: 622_800,
        clearOverdue: true,
      });
      expect(plan.movement).toMatchObject({
        action: 'RESUME',
        sequence: 6,
        statusFrom: 'SUSPENDED',
        statusTo: 'IN_PROGRESS',
        comment: 'Dotação definida',
        dueAt: EXTENDED,
      });
    });

    it('restaura AWAITING_APPROVAL quando suspenso em aprovação', () => {
      const plan = planResume(resumeInput({ restoreTo: 'AWAITING_APPROVAL' }));
      expect(plan.process.status).toBe('AWAITING_APPROVAL');
      expect(plan.movement.statusTo).toBe('AWAITING_APPROVAL');
    });

    it('FA-04: mesmo dia (0 dia útil) não muda o prazo nem reabre avisos', () => {
      const plan = planResume(
        resumeInput({
          now: new Date('2026-10-06T19:00:00.000Z'),
          extension: { days: 0, slaType: 'BUSINESS', newDueAt: DUE },
        }),
      );
      expect(plan.stage).toEqual({
        id: active.id,
        dueAt: DUE,
        pausedSeconds: 21_600,
        clearOverdue: false,
      });
      expect(plan.process.currentStageDueAt).toBe(DUE);
    });

    it('FA-02: etapa sem prazo só acumula a pausa', () => {
      const plan = planResume(
        resumeInput({
          process: { ...process, status: 'SUSPENDED', currentStageDueAt: null },
          active: { ...active, dueAt: null, pausedAt: SUSPENDED_AT },
          extension: { days: 4, slaType: 'BUSINESS', newDueAt: null },
        }),
      );
      expect(plan.stage).toMatchObject({
        dueAt: null,
        clearOverdue: false,
        pausedSeconds: 622_800,
      });
      expect(plan.process.currentStageDueAt).toBeNull();
    });

    it('FA-03: atrasado e ainda vencido depois da extensão — o atraso permanece', () => {
      const lateDue = new Date('2026-09-30T02:59:59.999Z');
      const plan = planResume(
        resumeInput({
          active: {
            ...active,
            dueAt: lateDue,
            pausedAt: SUSPENDED_AT,
            overdueSince: new Date('2026-09-30T03:00:00.000Z'),
          },
          extension: {
            days: 4,
            slaType: 'BUSINESS',
            newDueAt: new Date('2026-10-06T02:59:59.999Z'),
          },
        }),
      );
      expect(plan.stage.clearOverdue).toBe(false);
    });

    it('FA-03: atrasado mas no prazo depois da extensão — atraso e avisos são limpos', () => {
      const plan = planResume(
        resumeInput({
          active: {
            ...active,
            pausedAt: SUSPENDED_AT,
            overdueSince: new Date('2026-10-10T03:00:00Z'),
          },
        }),
      );
      expect(plan.stage.clearOverdue).toBe(true);
    });

    it('sem pausa gravada, conta a partir de agora (0 s)', () => {
      const plan = planResume(resumeInput({ active: { ...active, pausedAt: null } }));
      expect(plan.stage.pausedSeconds).toBe(0);
    });
  });
});
