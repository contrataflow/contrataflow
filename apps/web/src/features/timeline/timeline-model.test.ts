import type { TimelineEntryDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_TIMELINE_FILTERS,
  endOfLocalDay,
  entryGroup,
  groupTimelineByDay,
  hasActiveFilters,
  isPeriodInverted,
  mergeActorOptions,
  startOfLocalDay,
  timelineQueryOf,
} from './timeline-model';

const SP = 'America/Sao_Paulo';
const CARLOS = '0192d060-0000-7000-8000-00000000c001';
const ANA = '0192d060-0000-7000-8000-00000000c002';

function entry(occurredAt: string, overrides: Partial<TimelineEntryDto> = {}): TimelineEntryDto {
  return {
    id: `0192d060-0000-7000-8000-${occurredAt.replace(/\D/g, '').slice(0, 12)}`,
    occurredAt,
    type: 'PROCESS_FORWARDED',
    actorType: 'USER',
    actorId: CARLOS,
    actorName: 'Carlos Lima',
    actorDepartmentName: null,
    entityType: 'Process',
    entityId: null,
    movementId: null,
    params: {},
    visibility: 'STANDARD',
    ...overrides,
  };
}

describe('período no fuso do tenant (RN-TML-10 · DEC-003)', () => {
  it('início e fim inclusivos do dia local em UTC', () => {
    expect(startOfLocalDay('2026-10-05', SP).toISOString()).toBe('2026-10-05T03:00:00.000Z');
    expect(endOfLocalDay('2026-10-05', SP).toISOString()).toBe('2026-10-06T02:59:59.999Z');
    expect(startOfLocalDay('2026-10-05', 'UTC').toISOString()).toBe('2026-10-05T00:00:00.000Z');
  });

  it('respeita a mudança de horário do fuso (Nova York, 08/03/2026)', () => {
    expect(startOfLocalDay('2026-03-08', 'America/New_York').toISOString()).toBe(
      '2026-03-08T05:00:00.000Z',
    );
    expect(endOfLocalDay('2026-03-08', 'America/New_York').toISOString()).toBe(
      '2026-03-09T03:59:59.999Z',
    );
  });

  it('V-01 no front: período invertido', () => {
    expect(isPeriodInverted({ from: '2026-10-05', to: '2026-10-01' })).toBe(true);
    expect(isPeriodInverted({ from: '2026-10-01', to: '2026-10-01' })).toBe(false);
    expect(isPeriodInverted({ from: '', to: '2026-10-01' })).toBe(false);
  });
});

describe('filtros → query de PRC-12', () => {
  it('sem filtros: nada enviado', () => {
    expect(timelineQueryOf(EMPTY_TIMELINE_FILTERS, SP)).toEqual({
      group: undefined,
      actorId: undefined,
      occurredFrom: undefined,
      occurredTo: undefined,
    });
    expect(hasActiveFilters(EMPTY_TIMELINE_FILTERS)).toBe(false);
  });

  it('grupos e autores por vírgula (OU) e período em UTC', () => {
    const filters = {
      groups: ['APROVACOES', 'TRAMITACAO'] as const,
      actorIds: [CARLOS, ANA],
      from: '2026-09-28',
      to: '2026-10-05',
    };
    expect(timelineQueryOf(filters, SP)).toEqual({
      group: 'APROVACOES,TRAMITACAO',
      actorId: `${CARLOS},${ANA}`,
      occurredFrom: '2026-09-28T03:00:00.000Z',
      occurredTo: '2026-10-06T02:59:59.999Z',
    });
    expect(hasActiveFilters(filters)).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_TIMELINE_FILTERS, to: '2026-10-05' })).toBe(true);
  });
});

describe('agrupamento por dia (RN-TML-15)', () => {
  const now = new Date('2026-10-05T15:00:00.000Z');

  it('"Hoje", "Ontem" e demais dias no fuso do tenant, na ordem da API', () => {
    const days = groupTimelineByDay(
      [
        entry('2026-10-05T14:00:00.000Z'),
        entry('2026-10-05T03:30:00.000Z'),
        // 00:30 de 05/10 em UTC = 21:30 de 04/10 em São Paulo.
        entry('2026-10-05T00:30:00.000Z'),
        entry('2026-10-01T12:00:00.000Z'),
      ],
      SP,
      now,
    );
    expect(days.map((day) => [day.date, day.relative, day.entries.length])).toEqual([
      ['2026-10-05', 'today', 2],
      ['2026-10-04', 'yesterday', 1],
      ['2026-10-01', null, 1],
    ]);
  });

  it('o mesmo instante cai em dias diferentes conforme o fuso', () => {
    const late = [entry('2026-10-05T02:00:00.000Z')];
    expect(groupTimelineByDay(late, SP, now)[0]?.date).toBe('2026-10-04');
    expect(groupTimelineByDay(late, 'UTC', now)[0]?.date).toBe('2026-10-05');
  });

  it('vazio → nenhum dia', () => {
    expect(groupTimelineByDay([], SP, now)).toEqual([]);
  });
});

describe('autores conhecidos (RN-TML-11)', () => {
  it('soma os atores das páginas, sem repetir, em ordem alfabética; sistema fica de fora', () => {
    const first = mergeActorOptions([], [entry('2026-10-05T14:00:00.000Z')]);
    expect(first).toEqual([{ id: CARLOS, name: 'Carlos Lima' }]);
    const second = mergeActorOptions(first, [
      entry('2026-10-04T14:00:00.000Z', { actorId: ANA, actorName: 'Ana Souza' }),
      entry('2026-10-03T14:00:00.000Z', { actorType: 'SYSTEM', actorId: null, actorName: null }),
      entry('2026-10-02T14:00:00.000Z'),
    ]);
    expect(second).toEqual([
      { id: ANA, name: 'Ana Souza' },
      { id: CARLOS, name: 'Carlos Lima' },
    ]);
    expect(mergeActorOptions(second, [entry('2026-10-01T14:00:00.000Z')])).toEqual(second);
  });

  it('ator sem nome congelado usa o id', () => {
    expect(mergeActorOptions([], [entry('2026-10-05T14:00:00.000Z', { actorName: null })])).toEqual(
      [{ id: CARLOS, name: CARLOS }],
    );
  });
});

describe('grupo da entrada (ícone)', () => {
  it('segue o mapeamento RN-TML-12', () => {
    expect(entryGroup({ type: 'APPROVAL_DECIDED' })).toBe('APROVACOES');
    expect(entryGroup({ type: 'COMMENT_ADDED' })).toBe('COMENTARIOS');
  });
});
