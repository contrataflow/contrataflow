import { describe, expect, it } from 'vitest';

import {
  AI_MIN_RESERVATION,
  countsTowardDailyLimit,
  crossedThresholds,
  executionLimitDenial,
  monthQueryWindow,
  monthStartUtc,
  monthlyUsage,
  percentUsed,
  requestLimitDenial,
  reservationEstimate,
  rowsOfMonth,
  sumCost,
  usageBreakdown,
  usageDayOf,
  usageMonthOf,
  userDailyCount,
} from './ai-usage.js';
import type { AiUsageRow } from './ai-usage.js';

const CARLA = '0192a116-0000-7000-8000-0000000000c1';
const ANA = '0192a116-0000-7000-8000-0000000000a1';
const SP = 'America/Sao_Paulo';
const MANAUS = 'America/Manaus';
let seq = 0;

function row(overrides: Partial<AiUsageRow> = {}): AiUsageRow {
  seq += 1;
  return {
    id: `0192a116-0000-7000-8000-${seq.toString(16).padStart(12, '0')}`,
    status: 'SUCCEEDED',
    errorCode: null,
    startedAt: new Date('2026-10-16T12:00:00Z'),
    targetModule: 'DFD',
    kind: 'DRAFT',
    action: null,
    createdById: CARLA,
    createdAt: new Date('2026-10-16T12:00:00Z'),
    reservedTokens: 15_000,
    totalTokens: 10_000,
    costUsd: '0.050000',
    ...overrides,
  };
}

describe('estimativas de reserva (DEC-079 · RN-AI-18)', () => {
  it('DFD 15 mil, ETP 40 mil, mapa de riscos 25 mil, TR 40 mil, ajuste de seção 6 mil', () => {
    expect(reservationEstimate('DFD', 'DRAFT')).toBe(15_000);
    expect(reservationEstimate('ETP', 'DRAFT')).toBe(40_000);
    expect(reservationEstimate('RISK_MAP', 'DRAFT')).toBe(25_000);
    expect(reservationEstimate('TERM_OF_REFERENCE', 'DRAFT')).toBe(40_000);
    expect(reservationEstimate('ETP', 'SECTION')).toBe(6_000);
    expect(AI_MIN_RESERVATION).toBe(6_000);
  });
});

describe('mês e dia civis no fuso do tenant', () => {
  it('a virada do mês e do dia segue o fuso, não o UTC', () => {
    // 01/11 02:30 UTC = 31/10 23:30 em São Paulo (UTC-3).
    const instant = new Date('2026-11-01T02:30:00Z');
    expect(usageMonthOf(instant, SP)).toBe('2026-10');
    expect(usageMonthOf(instant, 'UTC')).toBe('2026-11');
    expect(usageDayOf(new Date('2026-10-17T03:30:00Z'), SP)).toBe('2026-10-17');
    expect(usageDayOf(new Date('2026-10-17T03:30:00Z'), MANAUS)).toBe('2026-10-16');
  });

  it('a janela de consulta cobre o mês em qualquer fuso e o filtro exato separa os meses', () => {
    const window = monthQueryWindow('2026-12');
    expect(window.from.toISOString()).toBe('2026-11-30T00:00:00.000Z');
    expect(window.to.toISOString()).toBe('2027-01-02T00:00:00.000Z');
    expect(monthStartUtc('2026-12').toISOString()).toBe('2026-12-01T00:00:00.000Z');
    const rows = [
      row({ createdAt: new Date('2026-12-01T02:00:00Z') }), // 30/11 em SP
      row({ createdAt: new Date('2026-12-01T03:30:00Z') }), // 01/12 em SP
      row({ createdAt: new Date('2027-01-01T02:59:00Z') }), // 31/12 em SP
    ];
    expect(rowsOfMonth(rows, '2026-12', SP)).toHaveLength(2);
  });
});

describe('consumo derivado (sem contador)', () => {
  it('usado = encerradas; reservado = QUEUED/RUNNING', () => {
    expect(
      monthlyUsage([
        row({ totalTokens: 20_000 }),
        row({ status: 'FAILED', totalTokens: 1_000 }),
        row({ status: 'CANCELED', totalTokens: null }),
        row({ status: 'QUEUED', totalTokens: null, reservedTokens: 15_000 }),
        row({ status: 'RUNNING', totalTokens: null, reservedTokens: 6_000 }),
      ]),
    ).toEqual({ usedTokens: 21_000, reservedTokens: 21_000 });
  });

  it('percentual com uma casa (consumo real sobre o limite)', () => {
    expect(percentUsed(41_000, 50_000)).toBe(82);
    expect(percentUsed(1, 3)).toBe(33.3);
    expect(percentUsed(10, 0)).toBe(100);
  });
});

describe('limites no pedido e na execução (RN-AI-18/19)', () => {
  const limits = { monthlyTokenLimit: 50_000, userDailyRequestLimit: 40 };

  it('pedido: usado + reservado + estimativa acima do limite → AI_USAGE_LIMIT_REACHED', () => {
    const usage = { usedTokens: 20_000, reservedTokens: 15_000 };
    expect(requestLimitDenial(usage, 15_000, 0, limits)).toBeNull();
    expect(requestLimitDenial(usage, 40_000, 0, limits)).toBe('AI_USAGE_LIMIT_REACHED');
    const empty = { usedTokens: 0, reservedTokens: 0 };
    expect(requestLimitDenial(empty, 15_000, 40, limits)).toBe('AI_USER_DAILY_LIMIT_REACHED');
    expect(requestLimitDenial(empty, 15_000, 39, limits)).toBeNull();
  });

  it('execução: só o consumo real esgotado e o dia sem a própria geração', () => {
    expect(executionLimitDenial({ usedTokens: 49_999, reservedTokens: 90_000 }, 39, limits)).toBe(
      null,
    );
    expect(executionLimitDenial({ usedTokens: 50_000, reservedTokens: 0 }, 0, limits)).toBe(
      'AI_USAGE_LIMIT_REACHED',
    );
    expect(executionLimitDenial({ usedTokens: 0, reservedTokens: 0 }, 40, limits)).toBe(
      'AI_USER_DAILY_LIMIT_REACHED',
    );
  });

  it('contagem diária: canceladas antes de rodar não contam; outros usuários e dias, também não', () => {
    const today = new Date('2026-10-16T15:00:00Z');
    const counted = row({ createdAt: today });
    const queuedCancel = row({ createdAt: today, status: 'CANCELED', startedAt: null });
    const rows = [
      counted,
      queuedCancel,
      row({ createdAt: today, status: 'CANCELED', errorCode: 'CANCELED_BY_POLICY' }),
      row({ createdAt: today, status: 'CANCELED', errorCode: null }),
      row({ createdAt: today, createdById: ANA }),
      row({ createdAt: new Date('2026-10-16T02:00:00Z') }), // 15/10 em SP
    ];
    expect(countsTowardDailyLimit(queuedCancel)).toBe(false);
    expect(userDailyCount(rows, CARLA, '2026-10-16', SP)).toBe(2);
    expect(userDailyCount(rows, CARLA, '2026-10-16', SP, counted.id)).toBe(1);
  });
});

describe('faixas de aviso (RN-AI-20)', () => {
  it('cada faixa uma vez, quando o consumo a cruza', () => {
    expect(crossedThresholds(39_000, 41_000, 50_000)).toEqual([80]);
    expect(crossedThresholds(41_000, 42_000, 50_000)).toEqual([]);
    expect(crossedThresholds(41_000, 50_500, 50_000)).toEqual([100]);
    expect(crossedThresholds(10_000, 60_000, 50_000)).toEqual([80, 100]);
    expect(crossedThresholds(40_000, 40_000, 50_000)).toEqual([]);
  });
});

describe('AI-06: custo e divisões', () => {
  it('soma o custo em decimal exato; null se alguma geração com tokens não tem preço', () => {
    expect(sumCost([row({ costUsd: '0.100000' }), row({ costUsd: '0.200000' })])).toBe('0.300000');
    expect(sumCost([row({ costUsd: '1.5' }), row({ status: 'QUEUED', costUsd: null })])).toBe(
      '1.500000',
    );
    expect(sumCost([row({ costUsd: null, totalTokens: 0 })])).toBe('0.000000');
    expect(sumCost([row({ costUsd: '0.1' }), row({ costUsd: null })])).toBeNull();
  });

  it('agrupa por tipo de documento, tipo de geração e usuário', () => {
    const breakdown = usageBreakdown([
      row({ totalTokens: 12_000, costUsd: '0.060000' }),
      row({ targetModule: 'ETP', totalTokens: 30_000, costUsd: '0.150000', createdById: ANA }),
      row({
        targetModule: 'ETP',
        kind: 'SECTION',
        action: 'REWRITE',
        totalTokens: 2_000,
        costUsd: '0.010000',
      }),
      row({ status: 'QUEUED', totalTokens: null, costUsd: null, reservedTokens: 15_000 }),
    ]);
    expect(breakdown).toMatchObject({
      usedTokens: 44_000,
      reservedTokens: 15_000,
      costUsd: '0.220000',
      generations: { total: 4 },
    });
    expect(breakdown.generations.byStatus).toMatchObject({ SUCCEEDED: 3, QUEUED: 1, FAILED: 0 });
    expect(breakdown.byDocumentType).toEqual([
      { targetModule: 'ETP', generations: 2, totalTokens: 32_000, costUsd: '0.160000' },
      { targetModule: 'DFD', generations: 2, totalTokens: 12_000, costUsd: '0.060000' },
    ]);
    expect(breakdown.byKind).toEqual([
      { kind: 'DRAFT', action: null, generations: 3, totalTokens: 42_000 },
      { kind: 'SECTION', action: 'REWRITE', generations: 1, totalTokens: 2_000 },
    ]);
    expect(breakdown.byUser).toEqual([
      { userId: ANA, generations: 1, totalTokens: 30_000 },
      { userId: CARLA, generations: 3, totalTokens: 14_000 },
    ]);
  });
});
