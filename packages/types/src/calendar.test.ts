import { describe, expect, it } from 'vitest';

import {
  addCalendarDays,
  dayOfWeek,
  easterSunday,
  localDateOf,
  MOVABLE_HOLIDAY_NAMES,
  planRecurringHolidays,
  seedHolidaysOf,
} from './calendar.js';

describe('easterSunday (Meeus/Jones/Butcher — RN-TEN-76)', () => {
  it.each([
    [2000, '2000-04-23'],
    [2019, '2019-04-21'],
    [2020, '2020-04-12'],
    [2021, '2021-04-04'],
    [2022, '2022-04-17'],
    [2023, '2023-04-09'],
    [2024, '2024-03-31'],
    [2025, '2025-04-20'],
    [2026, '2026-04-05'],
    [2027, '2027-03-28'],
    [2028, '2028-04-16'],
    [2038, '2038-04-25'],
  ])('Páscoa de %i é %s', (year, expected) => {
    expect(easterSunday(year)).toBe(expected);
  });

  it('é sempre domingo', () => {
    for (let year = 1950; year <= 2150; year += 1) expect(dayOfWeek(easterSunday(year))).toBe(0);
  });
});

describe('addCalendarDays', () => {
  it('atravessa mês, ano e bissexto', () => {
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addCalendarDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addCalendarDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('seedHolidaysOf (entities.md §7)', () => {
  const holidays = seedHolidaysOf(2026);
  const byName = (name: string) => holidays.find((holiday) => holiday.name === name);

  it('traz os 9 nacionais fixos, recorrentes e ordenados por data', () => {
    const national = holidays.filter((holiday) => holiday.scope === 'NATIONAL');
    expect(national.map((holiday) => holiday.date)).toEqual([
      '2026-01-01',
      '2026-04-21',
      '2026-05-01',
      '2026-09-07',
      '2026-10-12',
      '2026-11-02',
      '2026-11-15',
      '2026-11-20',
      '2026-12-25',
    ]);
    expect(new Set(holidays.map((holiday) => holiday.isRecurring))).toEqual(new Set([true]));
    const dates = holidays.map((holiday) => holiday.date);
    expect(dates).toEqual([...dates].sort());
  });

  it('calcula os móveis a partir da Páscoa de 2026 (05/04)', () => {
    expect(byName('Carnaval (segunda-feira)')).toMatchObject({
      date: '2026-02-16',
      scope: 'OPTIONAL',
    });
    expect(byName('Carnaval (terça-feira)')).toMatchObject({
      date: '2026-02-17',
      scope: 'OPTIONAL',
    });
    expect(byName('Quarta-feira de Cinzas')).toMatchObject({
      date: '2026-02-18',
      scope: 'OPTIONAL',
    });
    expect(byName('Sexta-feira Santa')).toMatchObject({ date: '2026-04-03', scope: 'MUNICIPAL' });
    expect(byName('Corpus Christi')).toMatchObject({ date: '2026-06-04', scope: 'OPTIONAL' });
  });

  it('os móveis mudam de data a cada ano e os nomes estão em MOVABLE_HOLIDAY_NAMES', () => {
    const next = seedHolidaysOf(2027);
    for (const name of MOVABLE_HOLIDAY_NAMES) {
      expect(next.find((holiday) => holiday.name === name)?.date).not.toBe(byName(name)?.date);
    }
    expect(next.find((holiday) => holiday.name === 'Sexta-feira Santa')?.date).toBe('2027-03-26');
  });
});

describe('localDateOf (DEC-003)', () => {
  it('usa o fuso informado, não o do servidor', () => {
    expect(localDateOf(new Date('2026-10-13T02:30:00Z'), 'America/Sao_Paulo')).toBe('2026-10-12');
    expect(localDateOf(new Date('2026-10-13T02:30:00Z'), 'Europe/Lisbon')).toBe('2026-10-13');
  });
});

describe('planRecurringHolidays (RN-TEN-76)', () => {
  const sourcesOf2026 = seedHolidaysOf(2026).map((holiday) => ({
    ...holiday,
    isActive: true,
    isSystem: true,
  }));

  it('repete os fixos e recalcula os móveis pela Páscoa de 2027 (28/03)', () => {
    const planned = planRecurringHolidays(sourcesOf2026, 2027);
    expect(planned).toHaveLength(sourcesOf2026.length);
    const byName = (name: string) => planned.find((holiday) => holiday.name === name)?.date;
    expect(byName('Natal')).toBe('2027-12-25');
    expect(byName('Tiradentes')).toBe('2027-04-21');
    expect(byName('Carnaval (terça-feira)')).toBe('2027-02-09');
    expect(byName('Sexta-feira Santa')).toBe('2027-03-26');
    expect(byName('Corpus Christi')).toBe('2027-05-27');
    expect(planned.map((holiday) => holiday.date)).toEqual(
      planned.map((holiday) => holiday.date).sort(),
    );
  });

  it('coincide com o seed do ano quando o tenant não alterou nada', () => {
    const planned = planRecurringHolidays(sourcesOf2026, 2027).map(({ date, name, scope }) => ({
      date,
      name,
      scope,
    }));
    const seeded = seedHolidaysOf(2027).map(({ date, name, scope }) => ({ date, name, scope }));
    expect(planned).toEqual(seeded);
  });

  it('herda escopo e situação do que o administrador ajustou e usa a ocorrência mais recente', () => {
    const planned = planRecurringHolidays(
      [
        {
          date: '2025-06-19',
          name: 'Corpus Christi',
          scope: 'OPTIONAL',
          isActive: true,
          isSystem: true,
        },
        {
          date: '2026-06-04',
          name: 'Corpus Christi',
          scope: 'MUNICIPAL',
          isActive: false,
          isSystem: true,
        },
        {
          date: '2026-03-19',
          name: 'São José',
          scope: 'MUNICIPAL',
          isActive: true,
          isSystem: false,
        },
      ],
      2027,
    );
    expect(planned).toEqual([
      { date: '2027-03-19', name: 'São José', scope: 'MUNICIPAL', isActive: true, isSystem: false },
      {
        date: '2027-05-27',
        name: 'Corpus Christi',
        scope: 'MUNICIPAL',
        isActive: false,
        isSystem: true,
      },
    ]);
  });

  it('ignora ocorrências do próprio ano (idempotente) e converte 29/02 em 28/02', () => {
    expect(
      planRecurringHolidays(
        [
          {
            date: '2027-01-01',
            name: 'Ano Novo',
            scope: 'NATIONAL',
            isActive: true,
            isSystem: true,
          },
        ],
        2027,
      ),
    ).toEqual([]);
    const leap = planRecurringHolidays(
      [
        {
          date: '2028-02-29',
          name: 'Dia bissexto',
          scope: 'MUNICIPAL',
          isActive: true,
          isSystem: false,
        },
      ],
      2029,
    );
    expect(leap[0]?.date).toBe('2029-02-28');
  });
});
