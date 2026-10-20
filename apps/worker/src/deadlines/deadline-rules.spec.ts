import { describe, expect, it } from 'vitest';

import {
  businessDaysLeft,
  dueSoonCutoff,
  holidayWindowEnd,
  nonBusinessDatesOf,
  warnSettingOf,
} from './deadline-rules.js';

const TZ = 'America/Sao_Paulo';
// Semana de referência: segunda 19/10/2026, feriado nacional na quinta 22/10.
const MONDAY = '2026-10-19';
const HOLIDAY = new Set(['2026-10-22']);

describe('regras do job deadlines (US-055 · RN-TRAM-82)', () => {
  it('feriados: só ativos; OPTIONAL só com calendar.optionalHolidaysAreNonBusiness', () => {
    const rows = [
      { date: '2026-10-22', scope: 'NATIONAL', is_active: true },
      { date: '2026-10-23', scope: 'MUNICIPAL', is_active: false },
      { date: '2026-10-28', scope: 'OPTIONAL', is_active: true },
    ];
    expect([...nonBusinessDatesOf(rows, false)]).toEqual(['2026-10-22']);
    expect([...nonBusinessDatesOf(rows, true)]).toEqual(['2026-10-22', '2026-10-28']);
  });

  it('dias úteis restantes: depois de hoje até o dia do prazo, pulando fim de semana e feriado', () => {
    expect(businessDaysLeft(MONDAY, MONDAY, HOLIDAY)).toBe(0);
    expect(businessDaysLeft(MONDAY, '2026-10-21', HOLIDAY)).toBe(2);
    // Quinta é feriado: não conta.
    expect(businessDaysLeft(MONDAY, '2026-10-22', HOLIDAY)).toBe(2);
    expect(businessDaysLeft(MONDAY, '2026-10-25', HOLIDAY)).toBe(3);
    expect(businessDaysLeft(MONDAY, '2026-10-16', HOLIDAY)).toBe(0);
  });

  it('limite do aviso: com 2 dias úteis, vence em breve até o fim de quinta (sexta é o 3º dia útil)', () => {
    const before = dueSoonCutoff(MONDAY, 2, HOLIDAY, TZ);
    // Início de sexta 23/10 em São Paulo (UTC-3).
    expect(before?.toISOString()).toBe('2026-10-23T03:00:00.000Z');
    // Sem o feriado, o 3º dia útil seria a quinta.
    expect(dueSoonCutoff(MONDAY, 2, new Set(), TZ)?.toISOString()).toBe('2026-10-22T03:00:00.000Z');
  });

  it('FA-05: warnBeforeBusinessDays = 0 desativa o aviso antecipado', () => {
    expect(dueSoonCutoff(MONDAY, 0, HOLIDAY, TZ)).toBeNull();
  });

  it('configuração inválida ou ausente usa o padrão 2; a janela de feriados cobre a contagem', () => {
    expect(warnSettingOf(undefined)).toBe(2);
    expect(warnSettingOf('3')).toBe(2);
    expect(warnSettingOf(11)).toBe(2);
    expect(warnSettingOf(0)).toBe(0);
    expect(warnSettingOf(5)).toBe(5);
    expect(holidayWindowEnd(MONDAY, 10) > '2026-11-30').toBe(true);
  });
});
