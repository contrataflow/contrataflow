import { describe, expect, it } from 'vitest';

import { HolidayChanged } from './events.js';
import {
  addBusinessDaysSchema,
  businessDaysQuerySchema,
  createHolidaySchema,
  holidayListQuerySchema,
  updateHolidaySchema,
} from './holiday.js';

const ID = '0192c000-0000-7000-8000-0000000106a1';

describe('createHolidaySchema (CAL-02)', () => {
  it('aceita feriado municipal e descarta isSystem/isActive do cliente', () => {
    const parsed = createHolidaySchema.parse({
      date: '2026-10-12',
      name: '  Aniversário da cidade ',
      scope: 'MUNICIPAL',
      isSystem: true,
      isActive: false,
    });
    expect(parsed).toEqual({
      date: '2026-10-12',
      name: 'Aniversário da cidade',
      scope: 'MUNICIPAL',
    });
  });

  it('exige data, nome e escopo (V-01) e recusa NATIONAL do cliente', () => {
    const result = createHolidaySchema.safeParse({ name: 'x', scope: 'NATIONAL' });
    expect(result.success).toBe(false);
    const paths = result.error?.issues.map((issue) => issue.path.join('.')).sort();
    expect(paths).toEqual(['date', 'scope']);
  });

  it.each(['12/10/2026', '2026-02-30', '2026-13-01', ''])('recusa a data %j (V-02)', (date) => {
    expect(createHolidaySchema.safeParse({ date, name: 'x', scope: 'STATE' }).success).toBe(false);
  });

  it('nome de 1 a 120 caracteres', () => {
    const base = { date: '2026-01-02', scope: 'STATE' };
    expect(createHolidaySchema.safeParse({ ...base, name: ' ' }).success).toBe(false);
    expect(createHolidaySchema.safeParse({ ...base, name: 'a'.repeat(120) }).success).toBe(true);
    expect(createHolidaySchema.safeParse({ ...base, name: 'a'.repeat(121) }).success).toBe(false);
  });
});

describe('updateHolidaySchema (CAL-03)', () => {
  it('ignora a data e aceita os 4 escopos', () => {
    expect(
      updateHolidaySchema.parse({ date: '2026-01-01', scope: 'NATIONAL', isActive: false }),
    ).toEqual({ scope: 'NATIONAL', isActive: false });
  });
});

describe('holidayListQuerySchema (CAL-01)', () => {
  it('ano opcional e paginação padrão', () => {
    expect(holidayListQuerySchema.parse({})).toEqual({ page: 1, pageSize: 100 });
    expect(holidayListQuerySchema.parse({ year: '2026' }).year).toBe(2026);
    expect(holidayListQuerySchema.safeParse({ year: 'abc' }).success).toBe(false);
    expect(holidayListQuerySchema.safeParse({ year: '1800' }).success).toBe(false);
  });
});

describe('businessDaysQuerySchema (CAL-05) e addBusinessDaysSchema (CAL-06)', () => {
  it('CAL-05 exige from e to', () => {
    expect(businessDaysQuerySchema.safeParse({ from: '2026-10-01' }).success).toBe(false);
    expect(businessDaysQuerySchema.parse({ from: '2026-10-01', to: '2026-10-31' })).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
    });
  });

  it('CAL-06 limita businessDays a 0..1000 e dayCountType a BUSINESS|CALENDAR', () => {
    const base = { fromDateTime: '2026-10-09T15:00:00Z' };
    expect(addBusinessDaysSchema.parse({ ...base, businessDays: 5 })).toEqual({
      ...base,
      businessDays: 5,
    });
    expect(addBusinessDaysSchema.safeParse({ ...base, businessDays: -1 }).success).toBe(false);
    expect(addBusinessDaysSchema.safeParse({ ...base, businessDays: 1001 }).success).toBe(false);
    expect(addBusinessDaysSchema.safeParse({ ...base, businessDays: 1.5 }).success).toBe(false);
    expect(
      addBusinessDaysSchema.safeParse({ ...base, businessDays: 3, dayCountType: 'CALENDAR' })
        .success,
    ).toBe(true);
    expect(
      addBusinessDaysSchema.safeParse({ ...base, businessDays: 3, dayCountType: 'X' }).success,
    ).toBe(false);
    expect(
      addBusinessDaysSchema.safeParse({ fromDateTime: '2026-10-09', businessDays: 3 }).success,
    ).toBe(false);
  });
});

describe('HolidayChanged', () => {
  it('é publicado em catalog.holiday_changed com change CREATED|UPDATED|DELETED', () => {
    const resolved = HolidayChanged.resolve({
      holidayId: ID,
      date: '2026-10-12',
      change: 'DELETED',
    });
    expect(resolved).toMatchObject({
      eventType: 'HolidayChanged',
      aggregateType: 'Holiday',
      routingKey: 'catalog.holiday_changed',
    });
    expect(() =>
      HolidayChanged.resolve({ holidayId: ID, date: '2026-10-12', change: 'ACTIVATED' }),
    ).toThrow();
  });
});
