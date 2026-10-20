import { AI_GENERATION_STATUSES, AI_USAGE_THRESHOLDS, localDateOf } from '@contrataflow/types';
import type {
  AiGenerationErrorCode,
  AiGenerationKind,
  AiGenerationStatus,
  AiSectionAction,
  AiTargetModule,
  AiUsageThreshold,
} from '@contrataflow/types';

/*
 * Consumo e limites da IA no órgão (US-116 · RN-AI-18..20 · DEC-079 · PEND-22). Funções puras:
 *
 * - O consumo é DERIVADO, sem contador: `usado` = soma de `totalTokens` das gerações que não estão
 *   `QUEUED`/`RUNNING`; `reservado ativo` = soma de `reservedTokens` das `QUEUED`/`RUNNING`. Não há
 *   deriva a corrigir.
 * - Mês e dia são CIVIS no fuso do tenant; a geração conta no mês/dia do seu `createdAt`.
 * - No pedido (AI-01): `usado + reservado ativo + estimativa > limite` → `AI_USAGE_LIMIT_REACHED`;
 *   pedidos contados do usuário no dia ≥ limite → `AI_USER_DAILY_LIMIT_REACHED`.
 * - Na execução (job): só o consumo REAL esgotado (≥ limite) e a contagem diária sem a própria.
 */

/** Recorte de `ai_generations` usado nas somas (sem conteúdo). */
export interface AiUsageRow {
  readonly id: string;
  readonly status: AiGenerationStatus;
  readonly errorCode: AiGenerationErrorCode | null;
  readonly startedAt: Date | null;
  readonly targetModule: AiTargetModule;
  readonly kind: AiGenerationKind;
  readonly action: AiSectionAction | null;
  readonly createdById: string;
  readonly createdAt: Date;
  readonly reservedTokens: number;
  readonly totalTokens: number | null;
  /** Decimal em string (numeric 12,6). */
  readonly costUsd: string | null;
}

/** Estimativas de reserva por alvo (DEC-079 · RN-AI-18): rascunho por documento e ajuste de seção. */
export const AI_RESERVATION_ESTIMATES: Readonly<Record<AiTargetModule, number>> = {
  DFD: 15_000,
  ETP: 40_000,
  RISK_MAP: 25_000,
  TERM_OF_REFERENCE: 40_000,
};
export const AI_SECTION_RESERVATION = 6_000;

export function reservationEstimate(targetModule: AiTargetModule, kind: AiGenerationKind): number {
  return kind === 'SECTION' ? AI_SECTION_RESERVATION : AI_RESERVATION_ESTIMATES[targetModule];
}

/** Menor reserva possível (AI-05 sem alvo: o ajuste de seção). */
export const AI_MIN_RESERVATION = Math.min(
  AI_SECTION_RESERVATION,
  ...Object.values(AI_RESERVATION_ESTIMATES),
);

const ACTIVE: ReadonlySet<AiGenerationStatus> = new Set(['QUEUED', 'RUNNING']);

export function isActiveUsage(row: Pick<AiUsageRow, 'status'>): boolean {
  return ACTIVE.has(row.status);
}

/** `YYYY-MM` do instante no fuso do tenant. */
export function usageMonthOf(instant: Date, timeZone: string): string {
  return localDateOf(instant, timeZone).slice(0, 7);
}

/** `YYYY-MM-DD` do instante no fuso do tenant. */
export function usageDayOf(instant: Date, timeZone: string): string {
  return localDateOf(instant, timeZone);
}

/**
 * Janela UTC que contém com folga o mês civil em QUALQUER fuso (±14 h): a consulta lê por
 * `createdAt` nessa janela (índice `(tenant_id, created_at)`) e o filtro exato é `usageMonthOf`.
 */
export function monthQueryWindow(month: string): { readonly from: Date; readonly to: Date } {
  const [year = 1970, monthNumber = 1] = month.split('-').map(Number);
  const day = 24 * 60 * 60 * 1000;
  return {
    from: new Date(Date.UTC(year, monthNumber - 1, 1) - day),
    to: new Date(Date.UTC(year, monthNumber, 1) + day),
  };
}

/** Início UTC do mês (instante do `eventId` determinístico do aviso). */
export function monthStartUtc(month: string): Date {
  const [year = 1970, monthNumber = 1] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber - 1, 1));
}

/** As linhas do mês civil (no fuso do tenant). */
export function rowsOfMonth(
  rows: readonly AiUsageRow[],
  month: string,
  timeZone: string,
): AiUsageRow[] {
  return rows.filter((row) => usageMonthOf(row.createdAt, timeZone) === month);
}

export interface MonthlyUsage {
  /** Consumo real (gerações encerradas). */
  readonly usedTokens: number;
  /** Reserva das gerações `QUEUED`/`RUNNING`. */
  readonly reservedTokens: number;
}

export function monthlyUsage(rows: readonly AiUsageRow[]): MonthlyUsage {
  let usedTokens = 0;
  let reservedTokens = 0;
  for (const row of rows) {
    if (isActiveUsage(row)) reservedTokens += row.reservedTokens;
    else usedTokens += row.totalTokens ?? 0;
  }
  return { usedTokens, reservedTokens };
}

/**
 * RN-AI-19: gerações canceladas antes de rodar não contam — as canceladas na fila (`startedAt`
 * nulo) e as canceladas por política antes de chamar o provedor (`CANCELED_BY_POLICY`).
 */
export function countsTowardDailyLimit(row: AiUsageRow): boolean {
  if (row.status !== 'CANCELED') return true;
  return row.startedAt !== null && row.errorCode !== 'CANCELED_BY_POLICY';
}

/** Pedidos contados do usuário no dia civil `day` (sem a geração `excludeId`). */
export function userDailyCount(
  rows: readonly AiUsageRow[],
  userId: string,
  day: string,
  timeZone: string,
  excludeId: string | null = null,
): number {
  return rows.filter(
    (row) =>
      row.createdById === userId &&
      row.id !== excludeId &&
      usageDayOf(row.createdAt, timeZone) === day &&
      countsTowardDailyLimit(row),
  ).length;
}

export interface AiLimits {
  readonly monthlyTokenLimit: number;
  readonly userDailyRequestLimit: number;
}

export type AiLimitDenial = 'AI_USAGE_LIMIT_REACHED' | 'AI_USER_DAILY_LIMIT_REACHED';

/** RN-AI-18/19 no pedido: reserva da estimativa e contagem diária (antes de inserir). */
export function requestLimitDenial(
  usage: MonthlyUsage,
  estimate: number,
  userDaily: number,
  limits: AiLimits,
): AiLimitDenial | null {
  if (usage.usedTokens + usage.reservedTokens + estimate > limits.monthlyTokenLimit) {
    return 'AI_USAGE_LIMIT_REACHED';
  }
  if (userDaily >= limits.userDailyRequestLimit) return 'AI_USER_DAILY_LIMIT_REACHED';
  return null;
}

/**
 * Revalidação no job (Impacto técnico): consumo real já esgotado e contagem diária sem a própria
 * geração. A reserva da própria geração não pesa (já foi aceita no pedido).
 */
export function executionLimitDenial(
  usage: MonthlyUsage,
  othersToday: number,
  limits: AiLimits,
): AiLimitDenial | null {
  if (usage.usedTokens >= limits.monthlyTokenLimit) return 'AI_USAGE_LIMIT_REACHED';
  if (othersToday >= limits.userDailyRequestLimit) return 'AI_USER_DAILY_LIMIT_REACHED';
  return null;
}

/** Percentual usado do mês (consumo real), uma casa decimal. */
export function percentUsed(usedTokens: number, limitTokens: number): number {
  if (limitTokens <= 0) return 100;
  return Math.round((usedTokens / limitTokens) * 1_000) / 10;
}

/** RN-AI-20: faixas que o consumo cruzou de `before` para `after` (cada uma uma vez). */
export function crossedThresholds(
  before: number,
  after: number,
  limitTokens: number,
): AiUsageThreshold[] {
  return AI_USAGE_THRESHOLDS.filter((threshold) => {
    const mark = (limitTokens * threshold) / 100;
    return before < mark && after >= mark;
  });
}

/*
 * AI-06 — agregados do mês.
 */

/** Micro-dólares (6 casas — numeric 12,6) para somar sem erro de ponto flutuante. */
function toMicros(cost: string): bigint {
  const [whole = '0', fraction = ''] = cost.split('.');
  const negative = whole.startsWith('-');
  const micros =
    BigInt(whole.replace('-', '')) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
  return negative ? -micros : micros;
}

function fromMicros(micros: bigint): string {
  const negative = micros < 0n;
  const absolute = negative ? -micros : micros;
  const whole = absolute / 1_000_000n;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/** Soma de custos; `null` se alguma geração que consumiu tokens não tem preço (RN-AI-09). */
export function sumCost(rows: readonly AiUsageRow[]): string | null {
  let total = 0n;
  for (const row of rows) {
    if (isActiveUsage(row)) continue;
    if (row.costUsd === null) {
      if ((row.totalTokens ?? 0) > 0) return null;
      continue;
    }
    total += toMicros(row.costUsd);
  }
  return fromMicros(total);
}

export interface AiUsageBreakdown {
  readonly usedTokens: number;
  readonly reservedTokens: number;
  readonly costUsd: string | null;
  readonly generations: {
    readonly total: number;
    readonly byStatus: Record<AiGenerationStatus, number>;
  };
  readonly byDocumentType: {
    readonly targetModule: AiTargetModule;
    readonly generations: number;
    readonly totalTokens: number;
    readonly costUsd: string | null;
  }[];
  readonly byKind: {
    readonly kind: AiGenerationKind;
    readonly action: AiSectionAction | null;
    readonly generations: number;
    readonly totalTokens: number;
  }[];
  readonly byUser: {
    readonly userId: string;
    readonly generations: number;
    readonly totalTokens: number;
  }[];
}

function groupBy<K>(
  rows: readonly AiUsageRow[],
  keyOf: (row: AiUsageRow) => K,
): Map<K, AiUsageRow[]> {
  const groups = new Map<K, AiUsageRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
}

const tokensOf = (rows: readonly AiUsageRow[]) =>
  rows.reduce((total, row) => total + (isActiveUsage(row) ? 0 : (row.totalTokens ?? 0)), 0);

/** AI-06: totais, custo e divisão por tipo de documento, tipo de geração e usuário (do mês). */
export function usageBreakdown(rows: readonly AiUsageRow[]): AiUsageBreakdown {
  const byStatus = Object.fromEntries(
    AI_GENERATION_STATUSES.map((status) => [status, 0]),
  ) as Record<AiGenerationStatus, number>;
  for (const row of rows) byStatus[row.status] += 1;
  const usage = monthlyUsage(rows);

  const byDocumentType = [...groupBy(rows, (row) => row.targetModule)].map(
    ([targetModule, group]) => ({
      targetModule,
      generations: group.length,
      totalTokens: tokensOf(group),
      costUsd: sumCost(group),
    }),
  );
  const byKind = [...groupBy(rows, (row) => `${row.kind}|${row.action ?? ''}`)].map(([, group]) => {
    const [first] = group;
    return {
      kind: first?.kind ?? 'DRAFT',
      action: first?.action ?? null,
      generations: group.length,
      totalTokens: tokensOf(group),
    };
  });
  const byUser = [...groupBy(rows, (row) => row.createdById)]
    .map(([userId, group]) => ({
      userId,
      generations: group.length,
      totalTokens: tokensOf(group),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || a.userId.localeCompare(b.userId));

  return {
    usedTokens: usage.usedTokens,
    reservedTokens: usage.reservedTokens,
    costUsd: sumCost(rows),
    generations: { total: rows.length, byStatus },
    byDocumentType: byDocumentType.sort((a, b) => b.totalTokens - a.totalTokens),
    byKind: byKind.sort((a, b) => b.totalTokens - a.totalTokens),
    byUser,
  };
}
