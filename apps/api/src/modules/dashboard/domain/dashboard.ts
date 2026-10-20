import { addCalendarDays, endOfDayInstant, localDateOf } from '@contrataflow/types';
import type { ActorType, TimelineVisibility } from '@contrataflow/types';
import {
  DASHBOARD_AVG_STAGE_WINDOW_DAYS,
  DASHBOARD_DEADLINE_STATUSES,
  DASHBOARD_OPEN_STATUSES,
  DASHBOARD_OPENED_MONTHS,
  PROCESS_STATUSES,
} from '@contrataflow/validation';
import type { ProcessStatus } from '@contrataflow/validation';

/*
 * Dashboard operacional (US-076): não é entidade — cada indicador é uma agregação sobre os
 * processos VISÍVEIS a quem consulta (DEC-024), recortados pelos filtros (RN-DASH-09). Estas funções
 * puras são a regra (RN-DASH-04..08 e POL-09 nos agregados) e a referência do SQL de
 * `infrastructure/dashboard.sql.ts`, que as repete predicado a predicado; o leitor em memória as
 * usa diretamente.
 */

/** O processo como o painel o lê (colunas de `processes`). */
export interface DashboardProcessRow {
  readonly tenantId: string;
  readonly id: string;
  readonly organizationId: string;
  readonly code: string | null;
  readonly status: ProcessStatus;
  readonly isBudgetConfidential: boolean;
  /** Decimal com 2 casas; `null` = sem estimativa. */
  readonly estimatedValue: string | null;
  readonly requestingSecretariatId: string;
  readonly requestingDepartmentId: string;
  readonly currentDepartmentId: string;
  readonly currentResponsibleId: string | null;
  readonly currentWorkflowStageId: string | null;
  readonly currentStageDueAt: Date | null;
  readonly overdueSince: Date | null;
  /** Autuação (número atribuído); `null` = ainda não autuado (RN-DASH-06). */
  readonly openedAt: Date | null;
}

/** Passagem concluída por uma etapa (`process_stages` com `exitedAt`). */
export interface DashboardStageRow {
  readonly tenantId: string;
  readonly processId: string;
  readonly workflowStageId: string;
  readonly enteredAt: Date;
  readonly exitedAt: Date;
}

/** Entrada da timeline (`process_timeline_entries`). */
export interface DashboardActivityRow {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly occurredAt: Date;
  readonly type: string;
  readonly actorType: ActorType;
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly actorDepartmentName: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly movementId: string | null;
  readonly params: Readonly<Record<string, unknown>>;
  readonly visibility: TimelineVisibility;
}

/** RN-DASH-09: recorte pela unidade solicitante; `null` = sem recorte naquele campo. */
export interface DashboardScope {
  readonly secretariatId: string | null;
  /** O setor filtrado e a sua subárvore (já resolvidos). */
  readonly departmentIds: readonly string[] | null;
}

export const NO_SCOPE: DashboardScope = { secretariatId: null, departmentIds: null };

/**
 * Quem desmascara o orçamento sigiloso (POL-09): escopos de `PROCESS_VIEW_CONFIDENTIAL_BUDGET`
 * (vazios sem o MFA exigido) e as lotações (custódia na fila da unidade).
 */
export interface DashboardBudgetViewer {
  readonly userId: string;
  readonly tenantWide: boolean;
  readonly organizationIds: readonly string[];
  readonly departmentIds: readonly string[];
  readonly custodyDepartmentIds: readonly string[];
}

/** Instantes de referência da consulta, no fuso do tenant. */
export interface DashboardWindow {
  readonly now: Date;
  readonly timezone: string;
  /** RN-DASH-04: início do dia local de hoje. */
  readonly dueSoonFrom: Date;
  /** RN-DASH-04: fim do último dia com até `warnBeforeBusinessDays` dias úteis restantes. */
  readonly dueSoonUntil: Date;
  readonly warnBeforeBusinessDays: number;
  /** RN-DASH-05: `now − 90 dias`. */
  readonly stageWindowStart: Date;
  /** RN-DASH-06: os 12 meses `YYYY-MM`, do mais antigo ao corrente. */
  readonly months: readonly string[];
  /** RN-DASH-06: início do mês mais antigo (instante). */
  readonly openedFrom: Date;
}

const DAY_MS = 24 * 3600 * 1000;

/** Início do dia local `date` (`00:00` no fuso), como instante. */
export function startOfDayInstant(date: string, timezone: string): Date {
  return new Date(endOfDayInstant(addCalendarDays(date, -1), timezone).getTime() + 1);
}

/** `YYYY-MM` do instante no fuso do tenant. */
export function monthKeyOf(instant: Date, timezone: string): string {
  return localDateOf(instant, timezone).slice(0, 7);
}

/** Os `count` meses `YYYY-MM` que terminam no mês de `today` (inclusive), do mais antigo. */
export function lastMonths(today: string, count: number): string[] {
  let year = Number(today.slice(0, 4));
  let month = Number(today.slice(5, 7));
  const months: string[] = [];
  for (let index = 0; index < count; index += 1) {
    months.unshift(`${String(year)}-${String(month).padStart(2, '0')}`);
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return months;
}

/**
 * RN-DASH-04 (o mesmo `isDueSoon` do DTO `deadline` — US-055): "a vencer" = vence de hoje em diante
 * com no máximo `warn` dias úteis restantes. Dados os próximos dias úteis depois de hoje (em ordem),
 * o último dia local que ainda se enquadra é a véspera do `(warn + 1)`-ésimo dia útil.
 */
export function dueSoonUntilDate(businessDaysAfterToday: readonly string[], warn: number): string {
  const limit = businessDaysAfterToday[warn];
  if (limit === undefined) throw new Error('Dias úteis insuficientes para o aviso de prazo.');
  return addCalendarDays(limit, -1);
}

export interface DashboardWindowInput {
  readonly now: Date;
  readonly timezone: string;
  readonly warnBeforeBusinessDays: number;
  /** Dias úteis locais estritamente depois de hoje, em ordem (ao menos `warn + 1`). */
  readonly businessDaysAfterToday: readonly string[];
}

export function dashboardWindowOf(input: DashboardWindowInput): DashboardWindow {
  const today = localDateOf(input.now, input.timezone);
  const months = lastMonths(today, DASHBOARD_OPENED_MONTHS);
  return {
    now: input.now,
    timezone: input.timezone,
    dueSoonFrom: startOfDayInstant(today, input.timezone),
    dueSoonUntil: endOfDayInstant(
      dueSoonUntilDate(input.businessDaysAfterToday, input.warnBeforeBusinessDays),
      input.timezone,
    ),
    warnBeforeBusinessDays: input.warnBeforeBusinessDays,
    stageWindowStart: new Date(input.now.getTime() - DASHBOARD_AVG_STAGE_WINDOW_DAYS * DAY_MS),
    months,
    openedFrom: startOfDayInstant(`${months[0] ?? today.slice(0, 7)}-01`, input.timezone),
  };
}

/** RN-DASH-09. */
export function inScope(
  row: Pick<DashboardProcessRow, 'requestingSecretariatId' | 'requestingDepartmentId'>,
  scope: DashboardScope,
): boolean {
  if (scope.secretariatId !== null && row.requestingSecretariatId !== scope.secretariatId) {
    return false;
  }
  return scope.departmentIds === null || scope.departmentIds.includes(row.requestingDepartmentId);
}

/** Autuado e não encerrado (`openCount`, `BY_STAGE`, `VALUE_BY_SECRETARIAT`). */
export function isOpen(row: Pick<DashboardProcessRow, 'status'>): boolean {
  return DASHBOARD_OPEN_STATUSES.includes(row.status);
}

/** RN-DASH-04: `overdueSince IS NOT NULL`, com o prazo correndo (não suspenso nem encerrado). */
export function isOverdue(row: Pick<DashboardProcessRow, 'status' | 'overdueSince'>): boolean {
  return DASHBOARD_DEADLINE_STATUSES.includes(row.status) && row.overdueSince !== null;
}

/** RN-DASH-04: `overdueSince IS NULL` e `currentStageDueAt` na janela de aviso. */
export function isDueSoon(
  row: Pick<DashboardProcessRow, 'status' | 'overdueSince' | 'currentStageDueAt'>,
  window: Pick<DashboardWindow, 'dueSoonFrom' | 'dueSoonUntil'>,
): boolean {
  if (!DASHBOARD_DEADLINE_STATUSES.includes(row.status) || row.overdueSince !== null) return false;
  const due = row.currentStageDueAt?.getTime();
  return (
    due !== undefined && due >= window.dueSoonFrom.getTime() && due <= window.dueSoonUntil.getTime()
  );
}

export interface DashboardProcessCounts {
  readonly overdue: number;
  readonly dueSoon: number;
  readonly open: number;
}

/** Contadores do resumo (DSH-01) sobre os processos visíveis e recortados. */
export function processCounts(
  rows: readonly DashboardProcessRow[],
  window: DashboardWindow,
): DashboardProcessCounts {
  return {
    overdue: rows.filter(isOverdue).length,
    dueSoon: rows.filter((row) => isDueSoon(row, window)).length,
    open: rows.filter(isOpen).length,
  };
}

/** `BY_STATUS`: todos os status (zero incluído), na ordem do enum — soma = total visível. */
export function countByStatus(
  rows: readonly Pick<DashboardProcessRow, 'status'>[],
): Record<ProcessStatus, number> {
  const counts = Object.fromEntries(PROCESS_STATUSES.map((status) => [status, 0])) as Record<
    ProcessStatus,
    number
  >;
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/** Contagem por chave (ordem de primeira aparição; quem apresenta ordena). */
export function countBy<T>(
  rows: readonly T[],
  keyOf: (row: T) => string | null,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export interface StageDuration {
  readonly workflowStageId: string;
  /** Média em segundos, arredondada. */
  readonly averageSeconds: number;
  readonly sampleSize: number;
}

/** RN-DASH-05: média de `exitedAt − enteredAt` das passagens que saíram nos últimos 90 dias. */
export function averageStageDurations(
  stages: readonly DashboardStageRow[],
  window: Pick<DashboardWindow, 'stageWindowStart' | 'now'>,
): StageDuration[] {
  const sums = new Map<string, { total: number; count: number }>();
  for (const stage of stages) {
    const exited = stage.exitedAt.getTime();
    if (exited < window.stageWindowStart.getTime() || exited > window.now.getTime()) continue;
    const entry = sums.get(stage.workflowStageId) ?? { total: 0, count: 0 };
    entry.total += Math.max(0, exited - stage.enteredAt.getTime()) / 1000;
    entry.count += 1;
    sums.set(stage.workflowStageId, entry);
  }
  return [...sums].map(([workflowStageId, { total, count }]) => ({
    workflowStageId,
    averageSeconds: Math.round(total / count),
    sampleSize: count,
  }));
}

/** RN-DASH-06: autuados por mês (fuso do tenant) nos 12 meses da janela, zero incluído. */
export function openedByMonth(
  rows: readonly Pick<DashboardProcessRow, 'openedAt'>[],
  window: Pick<DashboardWindow, 'months' | 'timezone'>,
): Map<string, number> {
  const counts = new Map(window.months.map((month) => [month, 0]));
  for (const row of rows) {
    if (row.openedAt === null) continue;
    const month = monthKeyOf(row.openedAt, window.timezone);
    const current = counts.get(month);
    if (current !== undefined) counts.set(month, current + 1);
  }
  return counts;
}

/**
 * POL-09 por linha (mesmo predicado de `buildConfidentialBudgetPredicate`): não sigiloso (salvo
 * `assumeConfidential`), permissão cobrindo o processo (tenant, órgão, concessão de unidade em
 * `departmentGrantIds`) ou custódia atual.
 */
export function canViewBudget(
  row: Pick<
    DashboardProcessRow,
    'isBudgetConfidential' | 'organizationId' | 'currentResponsibleId' | 'currentDepartmentId'
  >,
  viewer: DashboardBudgetViewer,
  departmentGrantIds: readonly string[],
  assumeConfidential = false,
): boolean {
  if (!assumeConfidential && !row.isBudgetConfidential) return true;
  if (viewer.tenantWide || viewer.organizationIds.includes(row.organizationId)) return true;
  if (row.currentResponsibleId === viewer.userId) return true;
  if (
    row.currentResponsibleId === null &&
    viewer.custodyDepartmentIds.includes(row.currentDepartmentId)
  ) {
    return true;
  }
  return departmentGrantIds.some((id) => viewer.departmentIds.includes(id));
}

/** Centavos de um decimal com até 2 casas (soma exata, sem ponto flutuante). */
export function centsOf(value: string): bigint {
  const negative = value.startsWith('-');
  const [integer = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const cents = BigInt(integer || '0') * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  return negative ? -cents : cents;
}

/** Centavos → decimal com 2 casas. */
export function decimalOf(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const fraction = String(absolute % 100n).padStart(2, '0');
  return `${negative ? '-' : ''}${String(absolute / 100n)}.${fraction}`;
}

export interface SecretariatValue {
  readonly secretariatId: string;
  /** Decimal com 2 casas. */
  readonly value: string;
  readonly confidentialExcluded: boolean;
}

/**
 * RN-DASH-07 (POL-09, agregados): soma de `estimatedValue` dos processos abertos por secretaria
 * solicitante; o sigiloso que quem consulta não pode ver fica fora da soma e marca o grupo com
 * `confidentialExcluded` — nunca um total silenciosamente incompleto.
 */
export function valueBySecretariat(
  rows: readonly DashboardProcessRow[],
  canSum: (row: DashboardProcessRow) => boolean,
): SecretariatValue[] {
  const groups = new Map<string, { cents: bigint; excluded: boolean }>();
  for (const row of rows) {
    if (!isOpen(row) || row.estimatedValue === null) continue;
    const group = groups.get(row.requestingSecretariatId) ?? { cents: 0n, excluded: false };
    if (canSum(row)) group.cents += centsOf(row.estimatedValue);
    else group.excluded = true;
    groups.set(row.requestingSecretariatId, group);
  }
  return [...groups].map(([secretariatId, group]) => ({
    secretariatId,
    value: decimalOf(group.cents),
    confidentialExcluded: group.excluded,
  }));
}

/** RN-DASH-08 / RN-TML-13: entrada `BUDGET_RESTRICTED` só com POL-09 sobre o processo. */
export function isActivityVisible(
  entry: Pick<DashboardActivityRow, 'visibility'>,
  canViewRestricted: boolean,
): boolean {
  return entry.visibility === 'STANDARD' || canViewRestricted;
}

/** Ordem da timeline: mais recente primeiro; empate pelo `id` decrescente. */
export function compareActivity(
  left: Pick<DashboardActivityRow, 'occurredAt' | 'id'>,
  right: Pick<DashboardActivityRow, 'occurredAt' | 'id'>,
): number {
  const byTime = right.occurredAt.getTime() - left.occurredAt.getTime();
  if (byTime !== 0) return byTime;
  return left.id === right.id ? 0 : left.id < right.id ? 1 : -1;
}
