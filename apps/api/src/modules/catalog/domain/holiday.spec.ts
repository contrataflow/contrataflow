import { describe, expect, it } from 'vitest';

import {
  createHoliday,
  HolidayScopeNotAllowedError,
  HolidaySystemError,
  updateHoliday,
} from './holiday.js';
import type { Holiday } from './holiday.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const LATER = new Date('2026-10-16T12:00:00.000Z');
const USER = '0192c000-0000-7000-8000-0000000106a1';
const TENANT = '0192c000-0000-7000-8000-00000000106a';

const custom: Holiday = createHoliday(
  { date: '2026-10-12', name: 'Aniversário da cidade', scope: 'MUNICIPAL' },
  { id: '0192c000-0000-7000-8000-0000000116a1', tenantId: TENANT, now: NOW, userId: USER },
);
const system: Holiday = {
  ...custom,
  id: '0192c000-0000-7000-8000-0000000116a2',
  name: 'Natal',
  date: '2026-12-25',
  scope: 'NATIONAL',
  isRecurring: true,
  isSystem: true,
};

describe('createHoliday (RN-TEN-75/77)', () => {
  it('cria ativo, não-sistema, não recorrente por padrão e na versão 1', () => {
    expect(custom).toMatchObject({
      date: '2026-10-12',
      name: 'Aniversário da cidade',
      scope: 'MUNICIPAL',
      isRecurring: false,
      isSystem: false,
      isActive: true,
      createdById: USER,
      version: 1,
    });
  });

  it('respeita isRecurring informado', () => {
    const holiday = createHoliday(
      { date: '2026-03-19', name: 'São José', scope: 'MUNICIPAL', isRecurring: true },
      { id: custom.id, tenantId: TENANT, now: NOW, userId: null },
    );
    expect(holiday.isRecurring).toBe(true);
  });
});

describe('updateHoliday (CAL-03)', () => {
  const ctx = { now: LATER, userId: USER };

  it('registra só os campos que mudaram', () => {
    const { next, changes } = updateHoliday(
      custom,
      { name: 'Aniversário de São José', scope: 'MUNICIPAL', isRecurring: true },
      ctx,
    );
    expect(changes).toEqual([
      { path: 'name', old: 'Aniversário da cidade', new: 'Aniversário de São José' },
      { path: 'isRecurring', old: false, new: true },
    ]);
    expect(next).toMatchObject({
      name: 'Aniversário de São José',
      updatedAt: LATER,
      updatedById: USER,
    });
  });

  it('sem mudança devolve o mesmo registro', () => {
    const result = updateHoliday(custom, { name: custom.name, isActive: true }, ctx);
    expect(result.changes).toEqual([]);
    expect(result.next).toBe(custom);
  });

  it('feriado de sistema pode ser desativado, ter o escopo e a recorrência ajustados', () => {
    const { next, changes } = updateHoliday(
      system,
      { isActive: false, scope: 'OPTIONAL', isRecurring: false },
      ctx,
    );
    expect(changes.map((change) => change.path)).toEqual(['scope', 'isRecurring', 'isActive']);
    expect(next).toMatchObject({ isActive: false, scope: 'OPTIONAL', isSystem: true });
  });

  it('feriado de sistema não pode ser renomeado (V-04 · RN-TEN-77)', () => {
    expect(() => updateHoliday(system, { name: 'Natal do Senhor' }, ctx)).toThrow(
      HolidaySystemError,
    );
    // O mesmo nome não é alteração.
    expect(updateHoliday(system, { name: 'Natal' }, ctx).changes).toEqual([]);
  });

  it('escopo NATIONAL só em feriado de sistema ou que já era nacional (RN-TEN-74)', () => {
    expect(() => updateHoliday(custom, { scope: 'NATIONAL' }, ctx)).toThrow(
      HolidayScopeNotAllowedError,
    );
    const demoted = updateHoliday(system, { scope: 'OPTIONAL' }, ctx).next;
    expect(updateHoliday(demoted, { scope: 'NATIONAL' }, ctx).next.scope).toBe('NATIONAL');
  });
});
