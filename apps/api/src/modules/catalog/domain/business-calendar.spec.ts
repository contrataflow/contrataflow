import { describe, expect, it } from 'vitest';

import {
  addDays,
  endOfDayInstant,
  isBusinessDay,
  listBusinessDaysBetween,
  localDateOf,
  nonBusinessDatesOf,
} from './business-calendar.js';

const holiday = (date: string, scope: 'NATIONAL' | 'OPTIONAL' | 'MUNICIPAL', isActive = true) => ({
  date,
  scope,
  isActive,
});

describe('nonBusinessDatesOf (RN-TEN-74)', () => {
  const holidays = [
    holiday('2026-10-12', 'MUNICIPAL'),
    holiday('2026-11-02', 'NATIONAL', false),
    holiday('2026-06-04', 'OPTIONAL'),
  ];

  it('ignora inativos e pontos facultativos por padrão (FA-03)', () => {
    expect([...nonBusinessDatesOf(holidays, false)]).toEqual(['2026-10-12']);
  });

  it('inclui OPTIONAL com calendar.optionalHolidaysAreNonBusiness = true', () => {
    expect([...nonBusinessDatesOf(holidays, true)].sort()).toEqual(['2026-06-04', '2026-10-12']);
  });
});

describe('isBusinessDay', () => {
  const nonBusiness = new Set(['2026-10-12']);

  it('segunda a sexta é útil; sábado e domingo não', () => {
    expect(isBusinessDay('2026-10-09', nonBusiness)).toBe(true); // sexta
    expect(isBusinessDay('2026-10-10', nonBusiness)).toBe(false); // sábado
    expect(isBusinessDay('2026-10-11', nonBusiness)).toBe(false); // domingo
    expect(isBusinessDay('2026-10-13', nonBusiness)).toBe(true); // terça
  });

  it('data com feriado (segunda 12/10/2026) não é útil', () => {
    expect(isBusinessDay('2026-10-12', nonBusiness)).toBe(false);
    expect(isBusinessDay('2026-10-12', new Set())).toBe(true);
  });
});

describe('addDays (RN-TEN-78)', () => {
  it('BUSINESS pula fins de semana: sexta + 1 = segunda', () => {
    expect(addDays('2026-10-09', 1, 'BUSINESS', new Set())).toBe('2026-10-12');
  });

  it('BUSINESS pula o feriado municipal de segunda 12/10/2026', () => {
    const nonBusiness = new Set(['2026-10-12']);
    expect(addDays('2026-10-09', 1, 'BUSINESS', nonBusiness)).toBe('2026-10-13');
    expect(addDays('2026-10-09', 5, 'BUSINESS', new Set())).toBe('2026-10-16');
    expect(addDays('2026-10-09', 5, 'BUSINESS', nonBusiness)).toBe('2026-10-19');
  });

  it('combina fim de semana, feriados em sequência e virada de ano', () => {
    const nonBusiness = new Set(['2026-12-24', '2026-12-25', '2027-01-01']);
    // 23/12 (qua) + 3: 24 e 25 não contam, 28 (seg)=1, 29=2, 30=3.
    expect(addDays('2026-12-23', 3, 'BUSINESS', nonBusiness)).toBe('2026-12-30');
    // 30/12 (qua) + 2: 31 (qui)=1, 01/01 feriado, 04/01 (seg)=2 (sex 01 + sáb/dom).
    expect(addDays('2026-12-30', 2, 'BUSINESS', nonBusiness)).toBe('2027-01-04');
  });

  it('0 dias devolve a própria data, mesmo não útil', () => {
    expect(addDays('2026-10-10', 0, 'BUSINESS', new Set())).toBe('2026-10-10');
  });

  it('a partir de sábado, o 1º dia útil é a segunda', () => {
    expect(addDays('2026-10-10', 1, 'BUSINESS', new Set())).toBe('2026-10-12');
  });

  it('CALENDAR soma dias corridos sem olhar feriados', () => {
    expect(addDays('2026-10-08', 6, 'CALENDAR', new Set(['2026-10-12']))).toBe('2026-10-14');
  });
});

describe('listBusinessDaysBetween (CAL-05)', () => {
  it('lista os dias úteis do intervalo, inclusive as pontas', () => {
    const days = listBusinessDaysBetween('2026-10-09', '2026-10-14', new Set(['2026-10-12']));
    expect(days).toEqual(['2026-10-09', '2026-10-13', '2026-10-14']);
  });

  it('from = to e intervalo só de fim de semana', () => {
    expect(listBusinessDaysBetween('2026-10-09', '2026-10-09', new Set())).toEqual(['2026-10-09']);
    expect(listBusinessDaysBetween('2026-10-10', '2026-10-11', new Set())).toEqual([]);
  });
});

describe('fuso do tenant (DEC-003)', () => {
  it('localDateOf usa o fuso, não o do servidor', () => {
    expect(localDateOf(new Date('2026-10-13T02:30:00Z'), 'America/Sao_Paulo')).toBe('2026-10-12');
    expect(localDateOf(new Date('2026-10-13T02:30:00Z'), 'Europe/Lisbon')).toBe('2026-10-13');
  });

  it('endOfDayInstant: 23:59:59.999 locais convertidos a UTC', () => {
    expect(endOfDayInstant('2026-10-12', 'America/Sao_Paulo').toISOString()).toBe(
      '2026-10-13T02:59:59.999Z',
    );
    expect(endOfDayInstant('2026-10-12', 'America/Manaus').toISOString()).toBe(
      '2026-10-13T03:59:59.999Z',
    );
  });

  it('endOfDayInstant acompanha o horário de verão do fuso', () => {
    expect(endOfDayInstant('2026-01-15', 'America/New_York').toISOString()).toBe(
      '2026-01-16T04:59:59.999Z',
    );
    expect(endOfDayInstant('2026-07-01', 'America/New_York').toISOString()).toBe(
      '2026-07-02T03:59:59.999Z',
    );
    // Dia da virada (08/03/2026, 02:00 → 03:00): o fim do dia já está em UTC-4.
    expect(endOfDayInstant('2026-03-08', 'America/New_York').toISOString()).toBe(
      '2026-03-09T03:59:59.999Z',
    );
  });
});
