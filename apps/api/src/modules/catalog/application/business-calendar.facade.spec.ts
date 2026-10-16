import { describe, expect, it } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { BusinessCalendarFacade } from './business-calendar.facade.js';
import { localDateOf } from '../domain/business-calendar.js';
import type { Holiday } from '../domain/holiday.js';
import {
  InMemoryCalendarSettingsReader,
  InMemoryHolidayRepository,
} from '../infrastructure/in-memory-holiday.repository.js';

const A = '0192c000-0000-7000-8000-00000000a701';
const B = '0192c000-0000-7000-8000-00000000a702';
const NOW = new Date('2026-10-15T12:00:00.000Z');

let counter = 0;
function holiday(tenantId: string, date: string, overrides: Partial<Holiday> = {}): Holiday {
  counter += 1;
  return {
    id: `0192c000-0000-7000-8000-00000a70${String(counter).padStart(4, '0')}`,
    tenantId,
    date,
    name: `Feriado ${date}`,
    scope: 'MUNICIPAL',
    isRecurring: false,
    isSystem: false,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    createdById: null,
    updatedById: null,
    version: 1,
    ...overrides,
  };
}

function setup() {
  const repository = new InMemoryHolidayRepository();
  const settings = new InMemoryCalendarSettingsReader();
  const facade = new BusinessCalendarFacade(repository, settings);
  const inTenant = <T>(tenantId: string, work: (tx: TenantTx) => Promise<T>): Promise<T> =>
    runWithRequestContext({ correlationId: 'corr-calendar', ip: '', userAgent: '' }, () => {
      updateRequestContext({
        tenantId,
        actor: { type: 'SYSTEM', userId: null, membershipId: null, name: 'Teste' },
      });
      return runSimulatedTransaction(work);
    });
  return { repository, settings, facade, inTenant };
}

describe('BusinessCalendarFacade (US-106 · DEC-031)', () => {
  it('addBusinessDays: sexta 09/10/2026 + 1 dia útil cai na terça 13/10 com feriado municipal na segunda', async () => {
    const { repository, facade, inTenant } = setup();
    repository.seed(holiday(A, '2026-10-12'));

    const due = await inTenant(A, (tx) =>
      facade.addBusinessDays(tx, new Date('2026-10-09T15:00:00Z'), 1),
    );

    // Fim do dia de 13/10 em America/Sao_Paulo (UTC-3), em UTC.
    expect(due.toISOString()).toBe('2026-10-14T02:59:59.999Z');
  });

  it('o feriado do outro tenant não entra no cálculo', async () => {
    const { repository, facade, inTenant } = setup();
    repository.seed(holiday(B, '2026-10-12'));

    const due = await inTenant(A, (tx) =>
      facade.addBusinessDays(tx, new Date('2026-10-09T15:00:00Z'), 1),
    );

    expect(due.toISOString()).toBe('2026-10-13T02:59:59.999Z'); // segunda 12/10
  });

  it('usa o dia local do tenant, não o UTC (23h de sexta em Brasília já é sábado em UTC)', async () => {
    const { facade, inTenant } = setup();
    // 2026-10-10T01:00Z = sexta 09/10 22:00 em São Paulo → +1 útil = segunda 12/10.
    const due = await inTenant(A, (tx) =>
      facade.addBusinessDays(tx, new Date('2026-10-10T01:00:00Z'), 1),
    );
    expect(due.toISOString()).toBe('2026-10-13T02:59:59.999Z');
  });

  it('ponto facultativo só conta com calendar.optionalHolidaysAreNonBusiness (FA-03)', async () => {
    const { repository, settings, facade, inTenant } = setup();
    repository.seed(holiday(A, '2026-10-12', { scope: 'OPTIONAL' }));

    const lista = (tx: TenantTx) => facade.listBusinessDaysBetween(tx, '2026-10-09', '2026-10-13');
    expect(await inTenant(A, lista)).toEqual(['2026-10-09', '2026-10-12', '2026-10-13']);

    settings.set(A, { optionalHolidaysAreNonBusiness: true });
    expect(await inTenant(A, lista)).toEqual(['2026-10-09', '2026-10-13']);
  });

  it('feriado inativo não conta', async () => {
    const { repository, facade, inTenant } = setup();
    repository.seed(holiday(A, '2026-10-12', { isActive: false }));
    expect(await inTenant(A, (tx) => facade.isBusinessDay(tx, '2026-10-12'))).toBe(true);
  });

  it('CALENDAR soma dias corridos e normaliza ao fim do dia no fuso do tenant', async () => {
    const { repository, settings, facade, inTenant } = setup();
    repository.seed(holiday(A, '2026-10-12'));
    settings.set(A, { timezone: 'America/Manaus' });

    const due = await inTenant(A, (tx) =>
      facade.addBusinessDays(tx, new Date('2026-10-08T15:00:00Z'), 6, 'CALENDAR'),
    );

    expect(due.toISOString()).toBe('2026-10-15T03:59:59.999Z'); // 14/10 23:59:59.999 em Manaus
  });

  it('janela longa: 300 dias úteis atravessam a virada do ano e seus feriados', async () => {
    const { repository, facade, inTenant } = setup();
    repository.seed(holiday(A, '2026-12-25'), holiday(A, '2027-01-01'));

    const due = await inTenant(A, (tx) =>
      facade.addBusinessDays(tx, new Date('2026-10-09T15:00:00Z'), 300),
    );
    const without = await inTenant(B, (tx) =>
      facade.addBusinessDays(tx, new Date('2026-10-09T15:00:00Z'), 300),
    );

    // Contagem independente: do dia seguinte ao último dia, há exatamente 300 dias úteis.
    const dueDate = localDateOf(due, 'America/Sao_Paulo');
    const counted = await inTenant(A, (tx) =>
      facade.listBusinessDaysBetween(tx, '2026-10-10', dueDate),
    );
    expect(counted).toHaveLength(300);
    expect(counted.at(-1)).toBe(dueDate);
    expect(due.getTime()).toBeGreaterThan(without.getTime());
  });

  it('businessDaysElapsed (US-041): dias úteis depois do dia de entrada até hoje, no fuso do tenant', async () => {
    const { repository, facade, inTenant } = setup();
    repository.seed(holiday(A, '2026-10-12'));
    // Entrou na sexta 09/10; hoje é quinta 15/10: 13, 14 e 15 (12 é feriado; 10/11 fim de semana).
    await expect(
      inTenant(A, (tx) => facade.businessDaysElapsed(tx, new Date('2026-10-09T15:00:00Z'), NOW)),
    ).resolves.toBe(3);
    // No mesmo dia (ou antes): 0.
    await expect(inTenant(A, (tx) => facade.businessDaysElapsed(tx, NOW, NOW))).resolves.toBe(0);
    await expect(
      inTenant(A, (tx) => facade.businessDaysElapsed(tx, NOW, new Date('2026-10-01T12:00:00Z'))),
    ).resolves.toBe(0);
  });
});
