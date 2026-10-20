import { addCalendarDays, localDateOf, timelineGroupOf } from '@contrataflow/types';
import type { TimelineGroup } from '@contrataflow/types';
import type { TimelineEntryDto } from '@contrataflow/validation';

/*
 * Modelo da aba "Timeline" (SCR-006 · US-060): filtros da tela → query de PRC-12, período em datas
 * locais do tenant convertidas para instantes UTC inclusivos (RN-TML-10 · DEC-003), agrupamento por
 * dia no fuso do tenant com "Hoje"/"Ontem" (RN-TML-15) e as opções de autor a partir das entradas
 * já carregadas (RN-TML-11 — sem endpoint de busca). Sem React: testável isoladamente.
 */

export interface TimelineFilters {
  readonly groups: readonly TimelineGroup[];
  readonly actorIds: readonly string[];
  /** Data local `YYYY-MM-DD` (fuso do tenant); vazio = sem limite. */
  readonly from: string;
  readonly to: string;
}

export const EMPTY_TIMELINE_FILTERS: TimelineFilters = {
  groups: [],
  actorIds: [],
  from: '',
  to: '',
};

export function hasActiveFilters(filters: TimelineFilters): boolean {
  return (
    filters.groups.length > 0 ||
    filters.actorIds.length > 0 ||
    filters.from !== '' ||
    filters.to !== ''
  );
}

/** V-01 no front: período final anterior ao inicial. */
export function isPeriodInverted(filters: Pick<TimelineFilters, 'from' | 'to'>): boolean {
  return filters.from !== '' && filters.to !== '' && filters.from > filters.to;
}

/** Diferença (ms) entre o relógio de parede do fuso e o UTC no instante. */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const wall = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  );
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Instante UTC da meia-noite local da data no fuso IANA (considera mudança de horário). */
export function startOfLocalDay(date: string, timeZone: string): Date {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const first = guess - zoneOffsetMs(new Date(guess), timeZone);
  const second = guess - zoneOffsetMs(new Date(first), timeZone);
  return new Date(second);
}

/** Fim inclusivo do dia local: o último milissegundo antes da meia-noite seguinte. */
export function endOfLocalDay(date: string, timeZone: string): Date {
  return new Date(startOfLocalDay(addCalendarDays(date, 1), timeZone).getTime() - 1);
}

/** Query de PRC-12 (sem cursor/limite): vírgula = OU dentro do filtro (RN-TML-11/12). */
export function timelineQueryOf(
  filters: TimelineFilters,
  timeZone: string,
): Record<string, string | undefined> {
  return {
    group: filters.groups.length > 0 ? filters.groups.join(',') : undefined,
    actorId: filters.actorIds.length > 0 ? filters.actorIds.join(',') : undefined,
    occurredFrom:
      filters.from === '' ? undefined : startOfLocalDay(filters.from, timeZone).toISOString(),
    occurredTo: filters.to === '' ? undefined : endOfLocalDay(filters.to, timeZone).toISOString(),
  };
}

export interface TimelineDay {
  /** Data local `YYYY-MM-DD`. */
  readonly date: string;
  /** "Hoje", "Ontem" ou `null` (o componente formata a data completa). */
  readonly relative: 'today' | 'yesterday' | null;
  readonly entries: readonly TimelineEntryDto[];
}

/** Agrupa as entradas (já na ordem da API) por dia local, mantendo a ordem (RN-TML-15). */
export function groupTimelineByDay(
  entries: readonly TimelineEntryDto[],
  timeZone: string,
  now: Date,
): TimelineDay[] {
  const today = localDateOf(now, timeZone);
  const yesterday = addCalendarDays(today, -1);
  const days: { date: string; entries: TimelineEntryDto[] }[] = [];
  for (const entry of entries) {
    const date = localDateOf(new Date(entry.occurredAt), timeZone);
    const last = days.at(-1);
    if (last?.date === date) last.entries.push(entry);
    else days.push({ date, entries: [entry] });
  }
  return days.map((day) => ({
    ...day,
    relative: day.date === today ? 'today' : day.date === yesterday ? 'yesterday' : null,
  }));
}

export interface ActorOption {
  readonly id: string;
  readonly name: string;
}

/**
 * Autores conhecidos (RN-TML-11): os já vistos somados aos da página carregada, sem repetir,
 * em ordem alfabética. Ator de sistema não é filtrável (sem `actorId`).
 */
export function mergeActorOptions(
  known: readonly ActorOption[],
  entries: readonly TimelineEntryDto[],
): ActorOption[] {
  const byId = new Map(known.map((option) => [option.id, option]));
  for (const entry of entries) {
    if (entry.actorId !== null && !byId.has(entry.actorId)) {
      byId.set(entry.actorId, { id: entry.actorId, name: entry.actorName ?? entry.actorId });
    }
  }
  if (byId.size === known.length) return [...known];
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'));
}

/** Grupo de apresentação da entrada (ícone — RN-TML-12). */
export function entryGroup(entry: Pick<TimelineEntryDto, 'type'>): TimelineGroup {
  return timelineGroupOf(entry.type);
}
