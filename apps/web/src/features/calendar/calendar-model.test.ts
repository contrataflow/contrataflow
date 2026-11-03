import type { HolidayDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  buildCreateBody,
  buildPatch,
  countByScope,
  datesOfYear,
  dayKind,
  formatHolidayDate,
  groupByMonth,
  holidaysByDate,
  initialValues,
  longDate,
  matchesFilter,
  nonBusinessDates,
  scopeOptions,
  summarizeYear,
  validateForm,
  weekdayOf,
  weeksOfMonth,
  yearOptions,
} from './calendar-model';

const MESSAGES = {
  required: (field: 'date' | 'name' | 'scope') => `Informe ${field}.`,
  invalidDate: 'Data inválida.',
  tooLong: (max: number) => `Máximo ${String(max)}.`,
};

function holiday(overrides: Partial<HolidayDto> = {}): HolidayDto {
  return {
    id: '0192a000-0000-7000-8000-000000000001',
    date: '2026-10-12',
    name: 'Aniversário da cidade',
    scope: 'MUNICIPAL',
    isRecurring: false,
    isActive: true,
    isSystem: false,
    version: 2,
    ...overrides,
  };
}

describe('validateForm (V-01/V-02)', () => {
  it('cadastro: data, nome e escopo são obrigatórios', () => {
    expect(validateForm(initialValues(), 'create', MESSAGES)).toEqual({
      date: 'Informe date.',
      name: 'Informe name.',
      scope: 'Informe scope.',
    });
  });

  it('data inexistente é recusada; data real é aceita', () => {
    const base = { ...initialValues(), name: 'X', scope: 'STATE' as const };
    expect(validateForm({ ...base, date: '2026-02-30' }, 'create', MESSAGES)).toEqual({
      date: 'Data inválida.',
    });
    expect(validateForm({ ...base, date: '2028-02-29' }, 'create', MESSAGES)).toEqual({});
  });

  it('nome acima de 120 caracteres; na edição a data não é validada', () => {
    const values = { ...initialValues(holiday()), name: 'a'.repeat(121) };
    expect(validateForm(values, 'edit', MESSAGES)).toEqual({ name: 'Máximo 120.' });
    expect(validateForm({ ...values, name: 'ok', date: '' }, 'edit', MESSAGES)).toEqual({});
  });
});

describe('buildCreateBody / buildPatch', () => {
  it('cadastro envia data, nome sem espaços, escopo e recorrência', () => {
    const body = buildCreateBody({
      date: '2026-10-12',
      name: '  Aniversário  ',
      scope: 'MUNICIPAL',
      isRecurring: true,
      isActive: true,
    });
    expect(body).toEqual({
      date: '2026-10-12',
      name: 'Aniversário',
      scope: 'MUNICIPAL',
      isRecurring: true,
    });
  });

  it('edição envia só o que mudou; nada alterado = patch vazio', () => {
    const current = holiday();
    expect(buildPatch(initialValues(current), current)).toEqual({});
    expect(
      buildPatch(
        { ...initialValues(current), name: 'Novo nome', isRecurring: true, isActive: false },
        current,
      ),
    ).toEqual({ name: 'Novo nome', isRecurring: true, isActive: false });
  });

  it('feriado de sistema nunca envia o nome (RN-TEN-77)', () => {
    const natal = holiday({ name: 'Natal', scope: 'NATIONAL', isSystem: true });
    expect(
      buildPatch({ ...initialValues(natal), name: 'Natal do município', scope: 'OPTIONAL' }, natal),
    ).toEqual({ scope: 'OPTIONAL' });
  });
});

describe('scopeOptions', () => {
  it('cadastro oferece os 3 escopos do administrador; feriado de sistema, os 4', () => {
    expect(scopeOptions()).toEqual(['MUNICIPAL', 'STATE', 'OPTIONAL']);
    expect(scopeOptions(holiday())).toEqual(['MUNICIPAL', 'STATE', 'OPTIONAL']);
    expect(scopeOptions(holiday({ isSystem: true, scope: 'NATIONAL' }))).toEqual([
      'NATIONAL',
      'STATE',
      'MUNICIPAL',
      'OPTIONAL',
    ]);
  });
});

describe('datas e anos', () => {
  it('formata a data de calendário sem converter fuso e acha o dia da semana', () => {
    expect(formatHolidayDate('2026-10-12')).toBe('12/10/2026');
    expect(weekdayOf('2026-10-12')).toMatch(/seg/i);
    expect(weekdayOf('2026-10-10')).toMatch(/s[áa]b/i);
  });

  it('seletor de ano: 2 antes e 3 depois do corrente, e sempre o escolhido', () => {
    expect(yearOptions(2026)).toEqual([2024, 2025, 2026, 2027, 2028, 2029]);
    expect(yearOptions(2026, 2035)).toEqual([2024, 2025, 2026, 2027, 2028, 2029, 2035]);
  });
});

describe('visão do ano (prd-6 §2.6)', () => {
  // 2026: começa e termina numa quinta-feira → 261 dias de segunda a sexta.
  const YEAR_HOLIDAYS = [
    holiday({
      id: 'a',
      date: '2026-01-01',
      name: 'Confraternização',
      scope: 'NATIONAL',
      isSystem: true,
    }),
    holiday({ id: 'b', date: '2026-02-17', name: 'Carnaval', scope: 'OPTIONAL', isSystem: true }),
    holiday({ id: 'c', date: '2026-04-21', name: 'Tiradentes', scope: 'NATIONAL', isSystem: true }),
    holiday({ id: 'd', date: '2026-10-12', name: 'Aniversário da cidade', scope: 'MUNICIPAL' }),
    holiday({
      id: 'e',
      date: '2026-11-02',
      name: 'Finados',
      scope: 'NATIONAL',
      isSystem: true,
      isActive: false,
    }),
    holiday({
      id: 'f',
      date: '2026-11-15',
      name: 'Proclamação',
      scope: 'NATIONAL',
      isSystem: true,
    }),
  ];

  it('datas do ano e semanas do mês de segunda a domingo', () => {
    expect(datesOfYear(2026)).toHaveLength(365);
    expect(datesOfYear(2028)).toHaveLength(366);
    const january = weeksOfMonth(2026, 0);
    expect(january).toHaveLength(5);
    expect(january[0]).toEqual([
      null,
      null,
      null,
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
    ]);
    const february = weeksOfMonth(2026, 1);
    expect(february[0]?.filter(Boolean)).toEqual(['2026-02-01']);
    expect(february.flat().filter(Boolean)).toHaveLength(28);
  });

  it('sem o CAL-05: feriados ativos de segunda a sexta são sem expediente; facultativo conta como útil (padrão)', () => {
    const nonBusiness = nonBusinessDates(2026, YEAR_HOLIDAYS);
    expect([...nonBusiness].sort()).toEqual(['2026-01-01', '2026-04-21', '2026-10-12']);
    expect(summarizeYear(2026, YEAR_HOLIDAYS, nonBusiness)).toEqual({
      businessDays: 258,
      noWorkDays: 3,
      institutionHolidays: 1,
      optionalHolidays: 1,
      optionalCountAsBusiness: true,
    });
    expect(dayKind('2026-02-17', nonBusiness)).toBe('business');
    expect(dayKind('2026-11-15', nonBusiness)).toBe('weekend');
    expect(dayKind('2026-04-21', nonBusiness)).toBe('nonBusiness');
  });

  it('com as datas úteis do CAL-05: o facultativo adotado vira sem expediente', () => {
    const adopted = new Set(['2026-01-01', '2026-02-17', '2026-04-21', '2026-10-12']);
    const business = datesOfYear(2026).filter(
      (date) => ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()) && !adopted.has(date),
    );
    const nonBusiness = nonBusinessDates(2026, YEAR_HOLIDAYS, business);
    expect(nonBusiness).toEqual(adopted);
    const summary = summarizeYear(2026, YEAR_HOLIDAYS, nonBusiness);
    expect(summary.businessDays).toBe(257);
    expect(summary.noWorkDays).toBe(4);
    expect(summary.optionalCountAsBusiness).toBe(false);
    expect(summarizeYear(2026, [], new Set()).optionalCountAsBusiness).toBeNull();
  });

  it('legenda, filtros, agrupamento por mês e feriados por data', () => {
    expect(countByScope(YEAR_HOLIDAYS)).toEqual({
      NATIONAL: 3,
      STATE: 0,
      MUNICIPAL: 1,
      OPTIONAL: 1,
    });
    expect(YEAR_HOLIDAYS.filter((h) => matchesFilter(h, 'public'))).toHaveLength(5);
    expect(YEAR_HOLIDAYS.filter((h) => matchesFilter(h, 'institution')).map((h) => h.id)).toEqual([
      'd',
    ]);
    expect(YEAR_HOLIDAYS.filter((h) => matchesFilter(h, 'optional')).map((h) => h.id)).toEqual([
      'b',
    ]);
    expect(YEAR_HOLIDAYS.filter((h) => matchesFilter(h, 'all'))).toHaveLength(6);

    const groups = groupByMonth([...YEAR_HOLIDAYS].reverse());
    expect(groups.map((group) => group.month)).toEqual([0, 1, 3, 9, 10]);
    expect(groups.at(-1)?.holidays.map((h) => h.id)).toEqual(['e', 'f']);

    const sameDay = holidaysByDate([
      holiday({ id: 'x', date: '2026-06-04', name: 'B', isActive: false }),
      holiday({ id: 'y', date: '2026-06-04', name: 'A' }),
    ]);
    expect(sameDay.get('2026-06-04')?.map((h) => h.id)).toEqual(['y', 'x']);
  });

  it('data por extenso para o rótulo do dia', () => {
    expect(longDate('2026-04-21')).toBe('terça-feira, 21 de abril de 2026');
  });
});
