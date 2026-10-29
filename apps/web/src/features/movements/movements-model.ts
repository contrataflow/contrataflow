import { addCalendarDays, localDateOf } from '@contrataflow/types';
import type { MovementAction, MovementItemDto } from '@contrataflow/validation';

import { endOfLocalDay, isPeriodInverted, startOfLocalDay } from '../timeline/timeline-model';

/*
 * Modelo da aba "Tramitação" (SCR-006 · US-054): filtros da tela → query de PRC-11 (ação por OU,
 * os demais por E — RN-TRAM-75), período em datas locais do tenant convertidas para instantes UTC
 * inclusivos (DEC-003, mesma conversão da timeline) e as opções de unidade e ator a partir das
 * tramitações já carregadas (sem endpoint de busca). Sem React: testável isoladamente.
 */

export interface MovementFilters {
  readonly actions: readonly MovementAction[];
  /** Vazio = sem filtro. */
  readonly fromDepartmentId: string;
  readonly toDepartmentId: string;
  readonly actorId: string;
  /** Data local `YYYY-MM-DD` (fuso do tenant); vazio = sem limite. */
  readonly from: string;
  readonly to: string;
}

export const EMPTY_MOVEMENT_FILTERS: MovementFilters = {
  actions: [],
  fromDepartmentId: '',
  toDepartmentId: '',
  actorId: '',
  from: '',
  to: '',
};

export function activeFilterCount(filters: MovementFilters): number {
  return (
    filters.actions.length +
    [
      filters.fromDepartmentId,
      filters.toDepartmentId,
      filters.actorId,
      filters.from,
      filters.to,
    ].filter((value) => value !== '').length
  );
}

export function hasActiveFilters(filters: MovementFilters): boolean {
  return activeFilterCount(filters) > 0;
}

/** V-02 no front: período inicial posterior ao final (não é enviado). */
export function isMovementPeriodInverted(filters: Pick<MovementFilters, 'from' | 'to'>): boolean {
  return isPeriodInverted(filters);
}

/** Query de PRC-11 (sem cursor/limite): vírgula = OU dentro do filtro de ação. */
export function movementQueryOf(
  filters: MovementFilters,
  timeZone: string,
): Record<string, string | undefined> {
  const value = (text: string) => (text === '' ? undefined : text);
  return {
    action: filters.actions.length > 0 ? filters.actions.join(',') : undefined,
    fromDepartmentId: value(filters.fromDepartmentId),
    toDepartmentId: value(filters.toDepartmentId),
    actorId: value(filters.actorId),
    occurredFrom:
      filters.from === '' ? undefined : startOfLocalDay(filters.from, timeZone).toISOString(),
    occurredTo: filters.to === '' ? undefined : endOfLocalDay(filters.to, timeZone).toISOString(),
  };
}

export interface FilterOption {
  readonly id: string;
  readonly name: string;
}

export interface MovementFilterOptions {
  readonly departments: readonly FilterOption[];
  readonly actors: readonly FilterOption[];
}

export const EMPTY_FILTER_OPTIONS: MovementFilterOptions = { departments: [], actors: [] };

function merge(
  known: readonly FilterOption[],
  found: readonly (FilterOption | null)[],
): readonly FilterOption[] {
  const byId = new Map(known.map((option) => [option.id, option]));
  for (const option of found) {
    if (option !== null && !byId.has(option.id)) byId.set(option.id, option);
  }
  if (byId.size === known.length) return known;
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'));
}

/**
 * Unidades (origem ou destino) e atores conhecidos: os já vistos somados aos da página carregada,
 * sem repetir, em ordem alfabética. Referência sem nome e ator de sistema não entram.
 */
export function mergeFilterOptions(
  known: MovementFilterOptions,
  items: readonly MovementItemDto[],
): MovementFilterOptions {
  const named = (ref: { readonly id: string; readonly name: string | null } | null) =>
    ref?.name === undefined || ref.name === null ? null : { id: ref.id, name: ref.name };
  return {
    departments: merge(
      known.departments,
      items.flatMap((item) => [named(item.fromDepartment), named(item.toDepartment)]),
    ),
    actors: merge(
      known.actors,
      items.map((item) =>
        named(item.actor.id === null ? null : { id: item.actor.id, name: item.actor.name }),
      ),
    ),
  };
}

/** A tramitação mudou o status do processo (exibe "Situação: de → para"). */
export function statusChanged(item: Pick<MovementItemDto, 'statusFrom' | 'statusTo'>): boolean {
  return item.statusTo !== null && item.statusFrom !== item.statusTo;
}

export interface MovementDay {
  /** Data local `YYYY-MM-DD` no fuso do tenant. */
  readonly date: string;
  readonly relative: 'today' | 'yesterday' | null;
  readonly items: readonly MovementItemDto[];
}

/** Agrupa as tramitações (já na ordem da API) por dia local, mantendo a ordem. */
export function groupMovementsByDay(
  items: readonly MovementItemDto[],
  timeZone: string,
  now: Date,
): MovementDay[] {
  const today = localDateOf(now, timeZone);
  const yesterday = addCalendarDays(today, -1);
  const days: { date: string; items: MovementItemDto[] }[] = [];
  for (const item of items) {
    const date = localDateOf(new Date(item.occurredAt), timeZone);
    const last = days.at(-1);
    if (last?.date === date) last.items.push(item);
    else days.push({ date, items: [item] });
  }
  return days.map((day) => ({
    ...day,
    relative: day.date === today ? 'today' : day.date === yesterday ? 'yesterday' : null,
  }));
}
