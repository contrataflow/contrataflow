import {
  FINAL_PROCESS_STATUSES,
  OVERDUE_ELIGIBLE_STATUSES,
  PROCESS_STATUSES,
  PRIORITIES,
} from '@contrataflow/validation';
import type {
  DayCountType,
  Priority,
  ProcessDeadlineDto,
  ProcessListSortTerm,
  ProcessStatus,
} from '@contrataflow/validation';

import { trigramSimilarity } from './duplicate-detection.js';

/*
 * Lista de processos (US-002 · RN-PROC-20..31): os critérios JÁ RESOLVIDOS (valores reservados
 * `me`/`none`/`mine` trocados pelos ids do usuário, chaves de etapa pelos ids das etapas), a
 * ordenação efetiva e as regras puras de cada critério. No PostgreSQL os critérios viram SQL
 * parametrizado (`PrismaProcessRepository.listProcesses`); estas funções são a especificação
 * executável usada pelo repositório em memória e pelos testes de regra.
 */

/** Critérios da consulta (null = filtro ausente; lista vazia = nada casa). */
export interface ProcessListCriteria {
  readonly search: string | null;
  readonly statuses: readonly ProcessStatus[] | null;
  /** `stageKey` resolvido nas etapas de todas as versões (RN-PROC-22). */
  readonly stageIdsByKey: readonly string[] | null;
  readonly currentWorkflowStageIds: readonly string[] | null;
  /** `mine` = lotações ativas do vínculo, sem subárvore (RN-PROC-21). */
  readonly currentDepartmentIds: readonly string[] | null;
  readonly requestingSecretariatIds: readonly string[] | null;
  readonly requestingDepartmentIds: readonly string[] | null;
  readonly organizationIds: readonly string[] | null;
  /** `me` = o próprio usuário; `none` = sem responsável (fila da unidade). */
  readonly responsible: { readonly ids: readonly string[]; readonly none: boolean } | null;
  readonly priorities: readonly Priority[] | null;
  readonly contractingTypeIds: readonly string[] | null;
  /** `none` = modalidade "A definir". */
  readonly modality: { readonly ids: readonly string[]; readonly none: boolean } | null;
  readonly originIds: readonly string[] | null;
  readonly years: readonly number[] | null;
  readonly tagIds: readonly string[] | null;
  readonly overdue: boolean | null;
  readonly targetDateOverdue: boolean | null;
  /** Datas locais `YYYY-MM-DD` inclusivas no fuso do tenant (RN-PROC-31). */
  readonly createdFrom: string | null;
  readonly createdTo: string | null;
  readonly targetDateFrom: string | null;
  readonly targetDateTo: string | null;
  readonly estimatedValueMin: string | null;
  readonly estimatedValueMax: string | null;
}

/** Ordenação efetiva: termos explícitos, ou relevância da busca (RN-PROC-26/27). */
export type ProcessListOrder =
  | { readonly kind: 'FIELDS'; readonly terms: readonly ProcessListSortTerm[] }
  | { readonly kind: 'RELEVANCE' };

export const DEFAULT_PROCESS_LIST_ORDER: ProcessListOrder = {
  kind: 'FIELDS',
  terms: [{ field: 'updatedAt', direction: 'desc' }],
};

/** RN-PROC-27: padrão `-updatedAt`; com `q` e sem `sort` explícito, relevância. */
export function effectiveOrder(
  sort: readonly ProcessListSortTerm[] | undefined,
  hasSearch: boolean,
): ProcessListOrder {
  if (sort !== undefined) return { kind: 'FIELDS', terms: sort };
  return hasSearch ? { kind: 'RELEVANCE' } : DEFAULT_PROCESS_LIST_ORDER;
}

/** Similaridade trigram mínima da busca (RN-PROC-26 · `pg_trgm.similarity_threshold`). */
export const SEARCH_SIMILARITY_THRESHOLD = 0.3;

/** Fatos de um processo usados pelos critérios (as colunas desnormalizadas — RN-PROC-29). */
export interface ProcessListFacts {
  readonly id: string;
  readonly organizationId: string;
  readonly number: number | null;
  readonly year: number;
  readonly code: string | null;
  readonly internalCode: string | null;
  readonly title: string;
  readonly object: string;
  readonly description: string | null;
  readonly status: ProcessStatus;
  readonly priority: Priority;
  readonly requestingSecretariatId: string;
  readonly requestingDepartmentId: string;
  readonly currentDepartmentId: string;
  readonly currentResponsibleId: string | null;
  readonly currentWorkflowStageId: string | null;
  readonly currentStageDueAt: Date | null;
  readonly overdueSince: Date | null;
  readonly contractingTypeId: string;
  readonly modalityId: string | null;
  readonly originId: string;
  readonly isBudgetConfidential: boolean;
  readonly estimatedValue: string | null;
  readonly targetDate: string | null;
  readonly openedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly tagIds: readonly string[];
}

/** Contexto de avaliação dos critérios dependentes do relógio e do fuso. */
export interface ProcessListClock {
  readonly now: Date;
  /** Hoje no fuso do tenant (`YYYY-MM-DD`). */
  readonly today: string;
  /** Data local (`YYYY-MM-DD`) de um instante no fuso do tenant. */
  readonly localDate: (instant: Date) => string;
}

/** RN-PROC-23: atrasado = status elegível E (`overdueSince` OU prazo da etapa vencido). */
export function isProcessOverdue(
  facts: Pick<ProcessListFacts, 'status' | 'overdueSince' | 'currentStageDueAt'>,
  now: Date,
): boolean {
  if (!OVERDUE_ELIGIBLE_STATUSES.includes(facts.status)) return false;
  return (
    facts.overdueSince !== null ||
    (facts.currentStageDueAt !== null && facts.currentStageDueAt.getTime() < now.getTime())
  );
}

/** RN-PROC-23 (DEC-031): prazo alvo anterior a hoje no fuso do tenant e status não final. */
export function isTargetDateOverdue(
  facts: Pick<ProcessListFacts, 'status' | 'targetDate'>,
  today: string,
): boolean {
  return (
    facts.targetDate !== null &&
    facts.targetDate < today &&
    !FINAL_PROCESS_STATUSES.includes(facts.status)
  );
}

/** Centavos de um decimal com até 2 casas (comparação exata). */
export function decimalCents(value: string): bigint {
  const [integer = '0', fraction = ''] = value.split('.');
  return BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
}

/** Texto para a busca: minúsculas e sem acento (o `cf_unaccent` do `search_vector`). */
export function foldText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const WORD = /[\p{L}\p{N}]+/gu;

/**
 * RN-PROC-26 em memória: todas as palavras da busca no texto pesquisável (código, código interno,
 * título, objeto, descrição) — aproximação do `websearch_to_tsquery` — OU trigram ≥ 0,3 em código
 * ou título. Relevância: exata (código/código interno) > termos > similaridade.
 */
export function searchRank(facts: ProcessListFacts, search: string): number | null {
  const q = foldText(search.trim());
  const exact = [facts.code, facts.internalCode].some(
    (value) => value !== null && foldText(value) === q,
  );
  const haystack = foldText(
    [facts.code, facts.internalCode, facts.title, facts.object, facts.description]
      .filter((value): value is string => value !== null)
      .join(' '),
  );
  const words = q.match(WORD) ?? [];
  const fullText = words.length > 0 && words.every((word) => haystack.includes(word));
  const similarity = Math.max(
    facts.code === null ? 0 : trigramSimilarity(facts.code, search),
    trigramSimilarity(facts.title, search),
  );
  if (!exact && !fullText && similarity < SEARCH_SIMILARITY_THRESHOLD) return null;
  return (exact ? 100 : 0) + (fullText ? 10 : 0) + similarity;
}

const inList = <T>(list: readonly T[] | null, value: T) => list === null || list.includes(value);

/**
 * A linha casa os critérios (E entre filtros, OU dentro de cada um — RN-PROC-20)? `canViewBudget`
 * = POL-09 para a linha: sem ele, o filtro de valor EXCLUI o processo sigiloso (RN-PROC-25).
 */
export function matchesCriteria(
  facts: ProcessListFacts,
  criteria: ProcessListCriteria,
  clock: ProcessListClock,
  canViewBudget: boolean,
): boolean {
  if (criteria.search !== null && searchRank(facts, criteria.search) === null) return false;
  if (!inList(criteria.statuses, facts.status)) return false;
  if (
    criteria.stageIdsByKey !== null &&
    !criteria.stageIdsByKey.includes(facts.currentWorkflowStageId ?? '')
  ) {
    return false;
  }
  if (
    criteria.currentWorkflowStageIds !== null &&
    !criteria.currentWorkflowStageIds.includes(facts.currentWorkflowStageId ?? '')
  ) {
    return false;
  }
  if (!inList(criteria.currentDepartmentIds, facts.currentDepartmentId)) return false;
  if (!inList(criteria.requestingSecretariatIds, facts.requestingSecretariatId)) return false;
  if (!inList(criteria.requestingDepartmentIds, facts.requestingDepartmentId)) return false;
  if (!inList(criteria.organizationIds, facts.organizationId)) return false;
  if (criteria.responsible !== null) {
    const { ids, none } = criteria.responsible;
    const responsible = facts.currentResponsibleId;
    if (!(responsible === null ? none : ids.includes(responsible))) return false;
  }
  if (!inList(criteria.priorities, facts.priority)) return false;
  if (!inList(criteria.contractingTypeIds, facts.contractingTypeId)) return false;
  if (criteria.modality !== null) {
    const { ids, none } = criteria.modality;
    if (!(facts.modalityId === null ? none : ids.includes(facts.modalityId))) return false;
  }
  if (!inList(criteria.originIds, facts.originId)) return false;
  if (!inList(criteria.years, facts.year)) return false;
  if (criteria.tagIds !== null && !facts.tagIds.some((id) => criteria.tagIds?.includes(id))) {
    return false;
  }
  if (criteria.overdue !== null && isProcessOverdue(facts, clock.now) !== criteria.overdue) {
    return false;
  }
  if (
    criteria.targetDateOverdue !== null &&
    isTargetDateOverdue(facts, clock.today) !== criteria.targetDateOverdue
  ) {
    return false;
  }
  const created = clock.localDate(facts.createdAt);
  if (criteria.createdFrom !== null && created < criteria.createdFrom) return false;
  if (criteria.createdTo !== null && created > criteria.createdTo) return false;
  if (criteria.targetDateFrom !== null || criteria.targetDateTo !== null) {
    if (facts.targetDate === null) return false;
    if (criteria.targetDateFrom !== null && facts.targetDate < criteria.targetDateFrom)
      return false;
    if (criteria.targetDateTo !== null && facts.targetDate > criteria.targetDateTo) return false;
  }
  if (criteria.estimatedValueMin !== null || criteria.estimatedValueMax !== null) {
    // RN-PROC-25(b): sem POL-09 o sigiloso sai do resultado, qualquer que seja o valor real.
    if (!canViewBudget || facts.estimatedValue === null) return false;
    const value = decimalCents(facts.estimatedValue);
    if (criteria.estimatedValueMin !== null && value < decimalCents(criteria.estimatedValueMin)) {
      return false;
    }
    if (criteria.estimatedValueMax !== null && value > decimalCents(criteria.estimatedValueMax)) {
      return false;
    }
  }
  return true;
}

/** Quem desmascara o valor sigiloso (mesma forma de `BudgetVisibility` das portas). */
export interface BudgetViewer {
  readonly userId: string;
  readonly tenantWide: boolean;
  readonly organizationIds: readonly string[];
  readonly departmentIds: readonly string[];
  readonly custodyDepartmentIds: readonly string[];
}

/**
 * POL-09 por linha (RN-PROC-25) em memória — o mesmo de `budgetVisibilitySql`: não sigiloso, ou
 * permissão cobrindo o processo (tenant, órgão, unidade com `ProcessAccess` visível), ou custódia.
 */
export function canViewConfidentialBudget(
  facts: Pick<
    ProcessListFacts,
    'isBudgetConfidential' | 'organizationId' | 'currentResponsibleId' | 'currentDepartmentId'
  >,
  viewer: BudgetViewer,
  departmentGrantIds: readonly string[],
): boolean {
  if (!facts.isBudgetConfidential || viewer.tenantWide) return true;
  if (viewer.organizationIds.includes(facts.organizationId)) return true;
  if (facts.currentResponsibleId === viewer.userId) return true;
  if (
    facts.currentResponsibleId === null &&
    viewer.custodyDepartmentIds.includes(facts.currentDepartmentId)
  ) {
    return true;
  }
  return departmentGrantIds.some((id) => viewer.departmentIds.includes(id));
}

const PRIORITY_RANK: Readonly<Record<Priority, number>> = Object.fromEntries(
  PRIORITIES.map((priority, index) => [priority, index]),
) as Record<Priority, number>;
const STATUS_RANK: Readonly<Record<ProcessStatus, number>> = Object.fromEntries(
  PROCESS_STATUSES.map((status, index) => [status, index]),
) as Record<ProcessStatus, number>;

type SortValue = number | string | bigint | null;

/**
 * Valor de ordenação da linha (RN-PROC-27): `code` por ano e número (sem número ao final),
 * prioridade URGENT > HIGH > MEDIUM > LOW, status na ordem do enum e `estimatedValue` mascarado
 * como nulo (RN-PROC-25(c)).
 */
export function sortValue(
  facts: ProcessListFacts,
  field: ProcessListSortTerm['field'],
  canViewBudget: boolean,
): SortValue[] {
  switch (field) {
    case 'updatedAt':
      return [facts.updatedAt.getTime()];
    case 'createdAt':
      return [facts.createdAt.getTime()];
    case 'openedAt':
      return [facts.openedAt?.getTime() ?? null];
    case 'code':
      return facts.number === null ? [null, null] : [facts.year, facts.number];
    case 'title':
      return [facts.title];
    case 'priority':
      return [PRIORITY_RANK[facts.priority]];
    case 'status':
      return [STATUS_RANK[facts.status]];
    case 'currentStageDueAt':
      return [facts.currentStageDueAt?.getTime() ?? null];
    case 'targetDate':
      return [facts.targetDate];
    case 'estimatedValue':
      return [
        canViewBudget || !facts.isBudgetConfidential
          ? facts.estimatedValue === null
            ? null
            : decimalCents(facts.estimatedValue)
          : null,
      ];
  }
}

function compareValues(a: SortValue, b: SortValue, direction: 'asc' | 'desc'): number {
  // Nulos sempre ao final, nas duas direções.
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  let order: number;
  if (typeof a === 'string' || typeof b === 'string') {
    order = String(a).localeCompare(String(b), 'pt-BR');
  } else {
    order = a < b ? -1 : a > b ? 1 : 0;
  }
  return direction === 'asc' ? order : -order;
}

/** Comparador da ordenação; desempate final por `id` decrescente (paginação determinística). */
export function compareForOrder(
  order: ProcessListOrder,
  search: string | null,
  canViewBudget: (facts: ProcessListFacts) => boolean,
): (a: ProcessListFacts, b: ProcessListFacts) => number {
  return (a, b) => {
    if (order.kind === 'RELEVANCE' && search !== null) {
      const diff = (searchRank(b, search) ?? 0) - (searchRank(a, search) ?? 0);
      if (diff !== 0) return diff;
    }
    if (order.kind === 'FIELDS') {
      for (const term of order.terms) {
        const left = sortValue(a, term.field, canViewBudget(a));
        const right = sortValue(b, term.field, canViewBudget(b));
        for (let index = 0; index < left.length; index += 1) {
          const diff = compareValues(left[index] ?? null, right[index] ?? null, term.direction);
          if (diff !== 0) return diff;
        }
      }
    }
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  };
}

// --- DTO calculado `deadline` (StageDeadlineCalculator) ------------------------------------

export interface StageDeadlineInput {
  readonly dueAt: Date | null;
  readonly slaType: DayCountType | null;
  /** Etapa ativa com `pausedAt` (processo suspenso). */
  readonly isPaused: boolean;
  /** RN-PROC-23 já avaliado para a linha. */
  readonly isOverdue: boolean;
  readonly overdueSince: Date | null;
}

export interface StageDeadlineCalendar {
  readonly today: string;
  readonly localDate: (instant: Date) => string;
  /** Dia útil no calendário do tenant (fins de semana e feriados — US-106). */
  readonly isBusinessDay: (date: string) => boolean;
  /** `deadlines.warnBeforeBusinessDays`. */
  readonly warnBeforeBusinessDays: number;
}

function addDay(date: string, days: number): string {
  const instant = new Date(`${date}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

/** Dias de `from` (exclusive) a `to` (inclusive) na unidade; 0 quando `to ≤ from`. */
function daysAfter(
  from: string,
  to: string,
  type: DayCountType,
  isBusinessDay: (date: string) => boolean,
): number {
  let count = 0;
  for (let date = addDay(from, 1); date <= to; date = addDay(date, 1)) {
    if (type === 'CALENDAR' || isBusinessDay(date)) count += 1;
  }
  return count;
}

/** Datas locais que o cálculo precisa examinar (para ler os feriados uma única vez). */
export function deadlineDateRange(
  inputs: readonly StageDeadlineInput[],
  calendar: Pick<StageDeadlineCalendar, 'today' | 'localDate'>,
): { readonly from: string; readonly to: string } {
  let from = calendar.today;
  let to = calendar.today;
  for (const input of inputs) {
    const reference = input.dueAt ?? input.overdueSince;
    if (reference === null) continue;
    const date = calendar.localDate(reference);
    if (date < from) from = date;
    if (date > to) to = date;
  }
  return { from, to };
}

/**
 * `StageDeadlineCalculator` (US-002 · "DTO calculado `deadline`" · reutilizado na US-004):
 * `daysLeft` até o dia local de `dueAt` (0 = vence hoje), `overdueDays` após ele contando hoje se
 * for dia útil, `isDueSoon` por dias úteis restantes ≤ `warnBeforeBusinessDays`. Pausado = sem
 * contagem.
 */
export function stageDeadline(
  input: StageDeadlineInput,
  calendar: StageDeadlineCalendar,
): ProcessDeadlineDto {
  const type: DayCountType = input.slaType ?? 'BUSINESS';
  const base: ProcessDeadlineDto = {
    dueAt: input.dueAt?.toISOString() ?? null,
    slaType: input.slaType,
    daysLeft: null,
    overdueDays: null,
    isDueSoon: false,
    isOverdue: input.isOverdue && !input.isPaused,
    isPaused: input.isPaused,
  };
  if (input.isPaused) return base;
  if (input.isOverdue) {
    const reference = input.dueAt ?? input.overdueSince;
    const overdueDays =
      reference === null
        ? 0
        : daysAfter(calendar.localDate(reference), calendar.today, type, calendar.isBusinessDay);
    return { ...base, overdueDays };
  }
  if (input.dueAt === null) return base;
  const due = calendar.localDate(input.dueAt);
  const daysLeft = daysAfter(calendar.today, due, type, calendar.isBusinessDay);
  const businessDaysLeft =
    type === 'BUSINESS'
      ? daysLeft
      : daysAfter(calendar.today, due, 'BUSINESS', calendar.isBusinessDay);
  return {
    ...base,
    daysLeft,
    isDueSoon: due >= calendar.today && businessDaysLeft <= calendar.warnBeforeBusinessDays,
  };
}
