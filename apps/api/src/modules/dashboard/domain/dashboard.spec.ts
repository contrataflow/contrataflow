import { describe, expect, it } from 'vitest';

import {
  averageStageDurations,
  canViewBudget,
  centsOf,
  compareActivity,
  countBy,
  countByStatus,
  dashboardWindowOf,
  decimalOf,
  dueSoonUntilDate,
  inScope,
  isActivityVisible,
  isDueSoon,
  isOpen,
  isOverdue,
  lastMonths,
  monthKeyOf,
  NO_SCOPE,
  openedByMonth,
  processCounts,
  startOfDayInstant,
  valueBySecretariat,
} from './dashboard.js';
import type { DashboardBudgetViewer, DashboardProcessRow, DashboardStageRow } from './dashboard.js';

/*
 * US-076 — regras puras do painel (RN-DASH-04..08 e POL-09 nos agregados), a referência do SQL de
 * `infrastructure/dashboard.sql.ts` e o motor do leitor em memória.
 */

const T = '0192e076-0000-7000-8000-000000000001';
const ORG = '0192e076-0000-7000-8000-0000000000a0';
const OBRAS = '0192e076-0000-7000-8000-0000000000a1';
const MANUT = '0192e076-0000-7000-8000-0000000000a2';
const SAUDE = '0192e076-0000-7000-8000-0000000000a3';
const ANA = '0192e076-0000-7000-8000-0000000000c1';
const TZ = 'America/Sao_Paulo';
// Terça, 20/10/2026, 12:00 em Brasília.
const NOW = new Date('2026-10-20T15:00:00.000Z');

const pid = (n: number) => `0192e076-0000-7000-8000-${String(n).padStart(12, '0')}`;

function row(n: number, patch: Partial<DashboardProcessRow> = {}): DashboardProcessRow {
  return {
    tenantId: T,
    id: pid(n),
    organizationId: ORG,
    code: `${String(n).padStart(4, '0')}/2026`,
    status: 'IN_PROGRESS',
    isBudgetConfidential: false,
    estimatedValue: null,
    requestingSecretariatId: OBRAS,
    requestingDepartmentId: MANUT,
    currentDepartmentId: MANUT,
    currentResponsibleId: null,
    currentWorkflowStageId: null,
    currentStageDueAt: null,
    overdueSince: null,
    openedAt: null,
    ...patch,
  };
}

// Próximos dias úteis depois de 20/10/2026 (sem feriados): qua 21, qui 22, sex 23, seg 26…
const BUSINESS_DAYS = ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27'];
const WINDOW = dashboardWindowOf({
  now: NOW,
  timezone: TZ,
  warnBeforeBusinessDays: 2,
  businessDaysAfterToday: BUSINESS_DAYS,
});

const NO_BUDGET: DashboardBudgetViewer = {
  userId: ANA,
  tenantWide: false,
  organizationIds: [],
  departmentIds: [],
  custodyDepartmentIds: [],
};

describe('janela da consulta (fuso do tenant)', () => {
  it('início do dia local, meses e "a vencer" até a véspera do (warn+1)-ésimo dia útil', () => {
    expect(startOfDayInstant('2026-10-20', TZ).toISOString()).toBe('2026-10-20T03:00:00.000Z');
    expect(WINDOW.dueSoonFrom.toISOString()).toBe('2026-10-20T03:00:00.000Z');
    // warn = 2 → até a véspera de sexta (23) = quinta (22), fim do dia.
    expect(WINDOW.dueSoonUntil.toISOString()).toBe('2026-10-23T02:59:59.999Z');
    expect(WINDOW.months).toHaveLength(12);
    expect(WINDOW.months[0]).toBe('2025-11');
    expect(WINDOW.months.at(-1)).toBe('2026-10');
    expect(WINDOW.openedFrom.toISOString()).toBe('2025-11-01T03:00:00.000Z');
    expect(WINDOW.stageWindowStart.toISOString()).toBe('2026-07-22T15:00:00.000Z');
  });

  it('fim de semana depois do último dia útil do aviso ainda conta (sexta + warn 0 → domingo)', () => {
    expect(dueSoonUntilDate(['2026-10-26'], 0)).toBe('2026-10-25');
    expect(() => dueSoonUntilDate([], 2)).toThrow(/insuficientes/);
  });

  it('lastMonths atravessa o ano; monthKeyOf usa o fuso', () => {
    expect(lastMonths('2026-02-10', 3)).toEqual(['2025-12', '2026-01', '2026-02']);
    // 01/11 00:30 UTC ainda é 31/10 em Brasília.
    expect(monthKeyOf(new Date('2026-11-01T00:30:00.000Z'), TZ)).toBe('2026-10');
  });
});

describe('RN-DASH-04 — atrasados e a vencer', () => {
  it('atrasado = overdueSince com o prazo correndo (suspenso e encerrado não contam)', () => {
    const since = new Date('2026-10-10T12:00:00.000Z');
    expect(isOverdue(row(1, { overdueSince: since }))).toBe(true);
    expect(isOverdue(row(2, { overdueSince: since, status: 'SUSPENDED' }))).toBe(false);
    expect(isOverdue(row(3, { overdueSince: since, status: 'COMPLETED' }))).toBe(false);
    expect(isOverdue(row(4))).toBe(false);
  });

  it('a vencer = sem atraso e prazo de hoje até o limite do aviso', () => {
    const due = (iso: string, patch: Partial<DashboardProcessRow> = {}) =>
      isDueSoon(row(1, { currentStageDueAt: new Date(iso), ...patch }), WINDOW);
    expect(due('2026-10-20T10:00:00.000Z')).toBe(true); // hoje, ainda não marcado atrasado
    expect(due('2026-10-23T02:59:59.999Z')).toBe(true); // fim de quinta
    expect(due('2026-10-24T02:59:59.999Z')).toBe(false); // sexta: 3 dias úteis
    expect(due('2026-10-19T12:00:00.000Z')).toBe(false); // ontem
    expect(due('2026-10-21T12:00:00.000Z', { overdueSince: NOW })).toBe(false);
    expect(due('2026-10-21T12:00:00.000Z', { status: 'SUSPENDED' })).toBe(false);
    expect(isDueSoon(row(1), WINDOW)).toBe(false);
  });

  it('processCounts: atrasados, a vencer e abertos (DRAFT e encerrados fora de abertos)', () => {
    const rows = [
      row(1, { overdueSince: NOW }),
      row(2, { currentStageDueAt: new Date('2026-10-21T12:00:00.000Z') }),
      row(3, { status: 'SUSPENDED' }),
      row(4, { status: 'DRAFT' }),
      row(5, { status: 'CANCELED' }),
    ];
    expect(processCounts(rows, WINDOW)).toEqual({ overdue: 1, dueSoon: 1, open: 3 });
    expect(isOpen(row(6, { status: 'AWAITING_APPROVAL' }))).toBe(true);
  });
});

describe('RN-DASH-09 — recorte pela unidade solicitante', () => {
  it('secretaria e subárvore do setor combinadas por E', () => {
    expect(inScope(row(1), NO_SCOPE)).toBe(true);
    expect(inScope(row(1), { secretariatId: OBRAS, departmentIds: null })).toBe(true);
    expect(inScope(row(1), { secretariatId: SAUDE, departmentIds: null })).toBe(false);
    expect(inScope(row(1), { secretariatId: OBRAS, departmentIds: [MANUT] })).toBe(true);
    expect(inScope(row(1), { secretariatId: null, departmentIds: [] })).toBe(false);
  });
});

describe('contagens', () => {
  it('BY_STATUS traz todos os status, zero incluído; soma = total', () => {
    const counts = countByStatus([row(1), row(2, { status: 'DRAFT' }), row(3)]);
    expect(counts.IN_PROGRESS).toBe(2);
    expect(counts.DRAFT).toBe(1);
    expect(counts.PUBLISHED).toBe(0);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('countBy ignora chave nula', () => {
    const stage = pid(900);
    const counts = countBy([row(1, { currentWorkflowStageId: stage }), row(2)], (r) => {
      return r.currentWorkflowStageId;
    });
    expect([...counts]).toEqual([[stage, 1]]);
  });
});

describe('RN-DASH-05 — tempo médio por etapa (90 dias)', () => {
  const stage = (n: number, enteredAt: string, exitedAt: string, workflowStageId = pid(800)) =>
    ({
      tenantId: T,
      processId: pid(n),
      workflowStageId,
      enteredAt: new Date(enteredAt),
      exitedAt: new Date(exitedAt),
    }) satisfies DashboardStageRow;

  it('média de exitedAt − enteredAt só das saídas na janela, por etapa', () => {
    const result = averageStageDurations(
      [
        stage(1, '2026-10-01T00:00:00Z', '2026-10-03T00:00:00Z'), // 2 dias
        stage(2, '2026-10-01T00:00:00Z', '2026-10-05T00:00:00Z'), // 4 dias
        stage(3, '2026-01-01T00:00:00Z', '2026-05-01T00:00:00Z'), // fora da janela
        stage(4, '2026-10-10T00:00:00Z', '2026-10-10T01:00:00Z', pid(801)),
      ],
      WINDOW,
    );
    expect(result).toEqual([
      { workflowStageId: pid(800), averageSeconds: 3 * 86400, sampleSize: 2 },
      { workflowStageId: pid(801), averageSeconds: 3600, sampleSize: 1 },
    ]);
  });
});

describe('RN-DASH-06 — abertos por mês', () => {
  it('conta openedAt no fuso; sem autuação e fora da janela ficam de fora', () => {
    const counts = openedByMonth(
      [
        row(1, { openedAt: new Date('2026-10-05T12:00:00Z') }),
        row(2, { openedAt: new Date('2026-11-01T00:30:00Z') }), // 31/10 local
        row(3),
        row(4, { openedAt: new Date('2024-01-01T12:00:00Z') }),
      ],
      WINDOW,
    );
    expect(counts.get('2026-10')).toBe(2);
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(2);
    expect(counts.size).toBe(12);
  });
});

describe('POL-09 — desmascaramento e soma por secretaria (RN-DASH-07)', () => {
  const confidential = row(30, {
    isBudgetConfidential: true,
    estimatedValue: '500000.00',
    requestingSecretariatId: SAUDE,
    currentDepartmentId: SAUDE,
  });

  it('canViewBudget: não sigiloso, tenant, órgão, responsável, fila da lotação ou concessão', () => {
    expect(canViewBudget(row(1), NO_BUDGET, [])).toBe(true);
    expect(canViewBudget(row(1), NO_BUDGET, [], true)).toBe(false);
    expect(canViewBudget(confidential, NO_BUDGET, [])).toBe(false);
    expect(canViewBudget(confidential, { ...NO_BUDGET, tenantWide: true }, [])).toBe(true);
    expect(canViewBudget(confidential, { ...NO_BUDGET, organizationIds: [ORG] }, [])).toBe(true);
    expect(canViewBudget({ ...confidential, currentResponsibleId: ANA }, NO_BUDGET, [])).toBe(true);
    expect(canViewBudget(confidential, { ...NO_BUDGET, custodyDepartmentIds: [SAUDE] }, [])).toBe(
      true,
    );
    expect(canViewBudget(confidential, { ...NO_BUDGET, departmentIds: [SAUDE] }, [SAUDE])).toBe(
      true,
    );
  });

  it('o sigiloso não visível fica fora da soma e marca o grupo; só abertos com valor', () => {
    const rows = [
      row(1, { estimatedValue: '1000000.00' }),
      row(2, { estimatedValue: '250000.50' }),
      row(3, { estimatedValue: '99.99', status: 'COMPLETED' }),
      row(31, { estimatedValue: '320000.00', requestingSecretariatId: SAUDE }),
      confidential,
      row(32, { requestingSecretariatId: SAUDE }),
    ];
    const result = valueBySecretariat(rows, (r) => canViewBudget(r, NO_BUDGET, []));
    expect(result).toEqual([
      { secretariatId: OBRAS, value: '1250000.50', confidentialExcluded: false },
      { secretariatId: SAUDE, value: '320000.00', confidentialExcluded: true },
    ]);
    const all = valueBySecretariat(rows, () => true);
    expect(all.find((g) => g.secretariatId === SAUDE)).toMatchObject({
      value: '820000.00',
      confidentialExcluded: false,
    });
  });

  it('centavos exatos (sem ponto flutuante), inclusive negativos e sem casas', () => {
    expect(centsOf('0.1')).toBe(10n);
    expect(centsOf('12')).toBe(1200n);
    expect(centsOf('-1.05')).toBe(-105n);
    expect(decimalOf(centsOf('0.1') + centsOf('0.2'))).toBe('0.30');
    expect(decimalOf(-105n)).toBe('-1.05');
    expect(decimalOf(0n)).toBe('0.00');
  });
});

describe('RN-DASH-08 — atividade recente', () => {
  it('BUDGET_RESTRICTED só com POL-09; ordem mais recente primeiro, empate por id desc', () => {
    expect(isActivityVisible({ visibility: 'STANDARD' }, false)).toBe(true);
    expect(isActivityVisible({ visibility: 'BUDGET_RESTRICTED' }, false)).toBe(false);
    expect(isActivityVisible({ visibility: 'BUDGET_RESTRICTED' }, true)).toBe(true);
    const at = new Date('2026-10-20T10:00:00Z');
    const entries = [
      { id: 'a', occurredAt: at },
      { id: 'c', occurredAt: new Date('2026-10-19T10:00:00Z') },
      { id: 'b', occurredAt: at },
      { id: 'b', occurredAt: at },
    ];
    expect([...entries].sort(compareActivity).map((e) => e.id)).toEqual(['b', 'b', 'a', 'c']);
  });
});
