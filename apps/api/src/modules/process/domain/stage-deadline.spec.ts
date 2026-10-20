import { describe, expect, it } from 'vitest';

import { enterStage } from './process-runtime-records.js';
import { pauseStageDeadline, resumeStageDeadline, stageDueComputedLog } from './stage-deadline.js';
import type { StageDeadlineState } from './stage-deadline.js';

const DUE = new Date('2026-10-27T02:59:59.999Z');
const PAUSED_AT = new Date('2026-10-20T13:00:00.000Z');

function state(overrides: Partial<StageDeadlineState> = {}): StageDeadlineState {
  return { dueAt: DUE, pausedAt: null, pausedTotalSeconds: 0, overdueSince: null, ...overrides };
}

describe('prazo da passagem — pausa e retomada (US-055 · RN-TRAM-80)', () => {
  it('suspender congela a contagem (pausedAt = now); pausar de novo não muda nada', () => {
    const paused = pauseStageDeadline(state(), PAUSED_AT);
    expect(paused).toEqual(state({ pausedAt: PAUSED_AT }));
    expect(pauseStageDeadline(paused, new Date('2026-10-21T00:00:00Z'))).toBe(paused);
  });

  it('retomar soma o tempo pausado e estende dueAt pelo mesmo intervalo', () => {
    const resumedAt = new Date(PAUSED_AT.getTime() + 2 * 86_400_000 + 1_500);
    const resumed = resumeStageDeadline(
      state({ pausedAt: PAUSED_AT, pausedTotalSeconds: 60 }),
      resumedAt,
    );
    expect(resumed).toEqual({
      dueAt: new Date(DUE.getTime() + 2 * 86_400_000 + 1_500),
      pausedAt: null,
      pausedTotalSeconds: 60 + 2 * 86_400 + 1,
      overdueSince: null,
    });
  });

  it('FA-04: overdueSince já marcado não é recalculado pela pausa/retomada', () => {
    const overdueSince = new Date('2026-10-19T15:00:00Z');
    const resumed = resumeStageDeadline(
      pauseStageDeadline(state({ overdueSince }), PAUSED_AT),
      new Date('2026-10-22T13:00:00Z'),
    );
    expect(resumed.overdueSince).toBe(overdueSince);
  });

  it('etapa sem prazo continua sem prazo; retomar sem pausa não muda nada', () => {
    const noDeadline = state({ dueAt: null, pausedAt: PAUSED_AT });
    expect(resumeStageDeadline(noDeadline, new Date('2026-10-21T13:00:00Z')).dueAt).toBeNull();
    const running = state();
    expect(resumeStageDeadline(running, new Date())).toBe(running);
  });

  it('log process.stage_due_computed: snapshot do SLA e se houve sobrescrita, sem o motivo', () => {
    const stage = enterStage({
      id: '0192f055-0000-7000-8000-000000000001',
      tenantId: '0192f055-0000-7000-8000-00000000000a',
      processId: '0192f055-0000-7000-8000-0000000000b1',
      workflowStageId: '0192f055-0000-7000-8000-0000000000d1',
      sequence: 1,
      departmentId: '0192f055-0000-7000-8000-0000000000c1',
      assigneeId: null,
      enteredAt: new Date('2026-10-19T15:00:00Z'),
      dueAt: DUE,
      slaDays: 5,
      slaType: 'BUSINESS',
      movementId: '0192f055-0000-7000-8000-0000000000e1',
    });
    expect(stageDueComputedLog(stage)).toEqual({
      event: 'process.stage_due_computed',
      processStageId: stage.id,
      enteredAt: '2026-10-19T15:00:00.000Z',
      slaDays: 5,
      slaType: 'BUSINESS',
      dueAt: DUE.toISOString(),
      overridden: false,
    });
    const overridden = { ...stage, dueDateOverridden: true, dueDateOverrideReason: 'x' };
    expect(stageDueComputedLog(overridden)).toMatchObject({ overridden: true });
    expect(stageDueComputedLog(overridden)).not.toHaveProperty('dueDateOverrideReason');
  });
});
