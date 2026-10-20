import type { HolidayDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  buildCreateBody,
  buildPatch,
  formatHolidayDate,
  initialValues,
  scopeOptions,
  validateForm,
  weekdayOf,
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
