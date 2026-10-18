import type { DayCountType } from '@contrataflow/types';

/*
 * Prazo da passagem pela etapa (US-055 · DEC-031 · RN-TRAM-78..80). O cálculo de `dueAt` na
 * entrada é do `BusinessCalendarFacade.addBusinessDays` (CAL-06: fim do N-ésimo dia útil ou
 * corrido, no fuso do tenant) chamado por quem abre a passagem (US-001/047/048/052); a detecção de
 * vencimento próximo e de atraso é do job `deadlines` no worker. Aqui ficam as regras puras da
 * suspensão (pausa/retomada da contagem — consumidas pela US-008) e o log da entrada.
 */

/** Campos de prazo da passagem (`ProcessStage` — entities.md §4.4). */
export interface StageDeadlineState {
  readonly dueAt: Date | null;
  readonly pausedAt: Date | null;
  readonly pausedTotalSeconds: number;
  readonly overdueSince: Date | null;
}

/**
 * RN-TRAM-80 (`ProcessStage.pause`): a suspensão congela a contagem (`pausedAt = now`); o job
 * `deadlines` ignora a passagem enquanto pausada. Já pausada = sem efeito (idempotente).
 */
export function pauseStageDeadline<T extends StageDeadlineState>(stage: T, now: Date): T {
  if (stage.pausedAt !== null) return stage;
  return { ...stage, pausedAt: now };
}

/**
 * RN-TRAM-80 (`ProcessStage.resume`): soma o tempo pausado a `pausedTotalSeconds`, estende `dueAt`
 * pelo mesmo intervalo e limpa `pausedAt`. `overdueSince` NÃO muda (FA-04: reflete o instante real
 * em que o atraso começou). Não pausada = sem efeito.
 */
export function resumeStageDeadline<T extends StageDeadlineState>(stage: T, now: Date): T {
  if (stage.pausedAt === null) return stage;
  const pausedMs = Math.max(0, now.getTime() - stage.pausedAt.getTime());
  return {
    ...stage,
    pausedAt: null,
    pausedTotalSeconds: stage.pausedTotalSeconds + Math.floor(pausedMs / 1_000),
    dueAt: stage.dueAt === null ? null : new Date(stage.dueAt.getTime() + pausedMs),
  };
}

/** `info process.stage_due_computed` (story · Logs) — nunca o motivo da sobrescrita. */
export function stageDueComputedLog(stage: {
  readonly id: string;
  readonly enteredAt: Date;
  readonly slaDays: number | null;
  readonly slaType: DayCountType | null;
  readonly dueAt: Date | null;
  readonly dueDateOverridden?: boolean;
}): Readonly<Record<string, unknown>> {
  return {
    event: 'process.stage_due_computed',
    processStageId: stage.id,
    enteredAt: stage.enteredAt.toISOString(),
    slaDays: stage.slaDays,
    slaType: stage.slaType,
    dueAt: stage.dueAt?.toISOString() ?? null,
    overridden: stage.dueDateOverridden ?? false,
  };
}
