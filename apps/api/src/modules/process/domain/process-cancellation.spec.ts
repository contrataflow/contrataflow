import { PROCESS_STATUSES } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  discardBlockOf,
  isCancelable,
  planCancellation,
  planDiscard,
} from './process-cancellation.js';
import type { CancelInput } from './process-cancellation.js';
import type { SuspendedPass } from './process-suspension.js';
import type { Process } from './process.js';

/*
 * US-009 — regras puras de cancelar e descartar (RN-PROC-103..109): status de origem, o plano do
 * cancelamento (status final, autor, justificativa, passagem `CANCELED` pela tramitação `CANCEL`) e
 * o do descarte (exclusão lógica do rascunho sem número, passagem encerrada sem tramitação).
 */

const id = (suffix: string) => `0192d009-0000-7000-8000-${suffix.padStart(12, '0')}`;
const NOW = new Date('2026-10-06T13:00:00.000Z');
const CARLA = id('b1');
const FABIO = id('b2');
const REASON = 'Demanda já atendida por contrato vigente';

const process = {
  id: id('c1'),
  tenantId: id('c2'),
  number: 12,
  code: '0012/2026',
  status: 'AWAITING_APPROVAL',
  currentStageId: id('d1'),
  currentWorkflowStageId: id('e1'),
  currentDepartmentId: id('a1'),
  currentResponsibleId: FABIO,
  currentStageDueAt: new Date('2026-10-10T02:59:59.999Z'),
  updatedAt: new Date('2026-10-05T12:00:00.000Z'),
  updatedById: FABIO,
  version: 3,
} as Process;

const active: SuspendedPass = {
  id: id('d1'),
  workflowStageId: id('e1'),
  dueAt: process.currentStageDueAt,
  slaType: 'BUSINESS',
  pausedAt: null,
  overdueSince: null,
};

const actor = { userId: CARLA, ip: '', userAgent: 'x'.repeat(600), correlationId: 'c-9' };

function cancelInput(overrides: Partial<CancelInput> = {}): CancelInput {
  return {
    process,
    active,
    reason: REASON,
    lastMovementSequence: 7,
    metadata: { v: 1 },
    actor,
    now: NOW,
    movementId: id('f1'),
    ...overrides,
  };
}

describe('Feature: Cancelar processo ou descartar rascunho (domínio)', () => {
  it.each(PROCESS_STATUSES)('RN-PROC-103: cancelável a partir de %s?', (status) => {
    expect(isCancelable(status)).toBe(!['CANCELED', 'COMPLETED', 'PUBLISHED'].includes(status));
  });

  it('RN-PROC-104/107: CANCELED com autor e justificativa, passagem encerrada pela tramitação CANCEL', () => {
    const plan = planCancellation(cancelInput());
    expect(plan.expectedVersion).toBe(3);
    expect(plan.process).toMatchObject({
      status: 'CANCELED',
      updatedAt: NOW,
      updatedById: CARLA,
      version: 4,
      // Etapa, unidade e responsável preservados para o histórico (e os destinatários do aviso).
      currentStageId: id('d1'),
      currentResponsibleId: FABIO,
    });
    expect(plan.cancellation).toEqual({
      canceledAt: NOW,
      canceledById: CARLA,
      cancellationReason: REASON,
    });
    expect(plan.stage).toEqual({ id: id('d1'), exitedAt: NOW, exitedViaMovementId: id('f1') });
    expect(plan.movement).toMatchObject({
      id: id('f1'),
      sequence: 8,
      action: 'CANCEL',
      statusFrom: 'AWAITING_APPROVAL',
      statusTo: 'CANCELED',
      comment: REASON,
      fromProcessStageId: id('d1'),
      toProcessStageId: id('d1'),
      fromUserId: FABIO,
      toUserId: FABIO,
      actorId: CARLA,
      dueAt: null,
      ip: null,
      correlationId: 'c-9',
    });
    expect(plan.movement.userAgent).toHaveLength(512);
  });

  it('FA-03: processo suspenso também cancela (o plano parte do status atual)', () => {
    const plan = planCancellation(
      cancelInput({
        process: { ...process, status: 'SUSPENDED' },
        active: { ...active, pausedAt: NOW },
      }),
    );
    expect(plan.movement).toMatchObject({ statusFrom: 'SUSPENDED', statusTo: 'CANCELED' });
  });

  it('RN-PROC-105: só rascunho sem number e code é descartável', () => {
    expect(discardBlockOf({ status: 'DRAFT', number: null, code: null })).toBeNull();
    expect(discardBlockOf({ status: 'DRAFT', number: 13, code: '0013/2026' })).toBe('NUMBERED');
    expect(discardBlockOf({ status: 'DRAFT', number: null, code: '0013/2026' })).toBe('NUMBERED');
    for (const status of PROCESS_STATUSES.filter((candidate) => candidate !== 'DRAFT')) {
      expect(discardBlockOf({ status, number: null, code: null })).toBe('NOT_DRAFT');
    }
  });

  it('RN-PROC-108/109: descarte é exclusão lógica e encerra a passagem ativa sem tramitação', () => {
    const draft = { ...process, status: 'DRAFT', number: null, code: null } as Process;
    expect(
      planDiscard({ process: draft, activeStageId: id('d1'), userId: CARLA, now: NOW }),
    ).toEqual({
      processId: draft.id,
      expectedVersion: 3,
      deletedAt: NOW,
      deletedById: CARLA,
      stage: { id: id('d1'), exitedAt: NOW, exitedViaMovementId: null },
    });
    expect(
      planDiscard({ process: draft, activeStageId: null, userId: CARLA, now: NOW }).stage,
    ).toBeNull();
  });
});
