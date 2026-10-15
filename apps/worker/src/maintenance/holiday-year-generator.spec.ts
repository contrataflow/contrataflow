import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';

import { HolidayYearGeneratorTask } from './holiday-year-generator.js';
import { TenantHousekeepingJob } from './tenant-housekeeping.job.js';
import type { JobHandlerContext } from '../queues/run-job.js';

const TENANT = '0192c000-0000-7000-8000-00000000106a';

interface Stored {
  date: string;
  name: string;
  scope: string;
  is_active: boolean;
  is_system: boolean;
}

/**
 * Cliente SQL falso do calendário do tenant: guarda os feriados recorrentes e honra o
 * `ON CONFLICT DO NOTHING` por `(data, nome em minúsculas)`.
 */
function fakeClient(timezone: string, existing: Stored[]) {
  const holidays = [...existing];
  const inserts: string[][] = [];
  const client: SqlClient = {
    query: (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes('FROM tenants')) {
        return Promise.resolve({ rows: [{ timezone }], rowCount: 1 }) as never;
      }
      if (sql.includes('FROM holidays')) {
        const before = String(params[1]);
        const rows = holidays.filter((holiday) => holiday.date < before);
        return Promise.resolve({ rows, rowCount: rows.length }) as never;
      }
      const [, , date, name, scope, isSystem, isActive] = params as [
        string,
        string,
        string,
        string,
        string,
        boolean,
        boolean,
      ];
      const duplicated = holidays.some(
        (holiday) => holiday.date === date && holiday.name.toLowerCase() === name.toLowerCase(),
      );
      if (!duplicated) {
        holidays.push({ date, name, scope, is_active: isActive, is_system: isSystem });
        inserts.push([date, name]);
      }
      return Promise.resolve({ rows: [], rowCount: duplicated ? 0 : 1 });
    },
  };
  return { client, holidays, inserts };
}

const sources: Stored[] = [
  { date: '2026-12-25', name: 'Natal', scope: 'NATIONAL', is_active: true, is_system: true },
  {
    date: '2026-04-03',
    name: 'Sexta-feira Santa',
    scope: 'MUNICIPAL',
    is_active: true,
    is_system: true,
  },
  { date: '2026-03-19', name: 'São José', scope: 'MUNICIPAL', is_active: true, is_system: false },
];

describe('HolidayYearGeneratorTask (US-106 · RN-TEN-76)', () => {
  it('na virada do ano gera o seguinte, recalculando a Sexta-feira Santa pela Páscoa', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { client, inserts } = fakeClient('America/Sao_Paulo', sources);
    const task = new HolidayYearGeneratorTask(() => new Date('2026-12-20T12:00:00Z'));

    const counts = await task.run(client, TENANT);

    expect(counts).toEqual({ '2026': 0, '2027': 3 });
    expect(inserts).toEqual([
      ['2027-03-19', 'São José'],
      ['2027-03-26', 'Sexta-feira Santa'],
      ['2027-12-25', 'Natal'],
    ]);
  });

  it('é idempotente: a segunda execução não cria nada', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { client, inserts } = fakeClient('America/Sao_Paulo', sources);
    const task = new HolidayYearGeneratorTask(() => new Date('2026-12-20T12:00:00Z'));

    await task.run(client, TENANT);
    const again = await task.run(client, TENANT);

    expect(again).toEqual({ '2026': 0, '2027': 0 });
    expect(inserts).toHaveLength(3);
  });

  it('usa o ano corrente do fuso do tenant (31/12 à noite em Manaus ainda é o ano velho)', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    // 2027-01-01 02:00Z = 31/12/2026 22:00 em Manaus (UTC-4): o "ano corrente" ainda é 2026.
    const { client } = fakeClient('America/Manaus', sources);
    const task = new HolidayYearGeneratorTask(() => new Date('2027-01-01T02:00:00Z'));

    expect(Object.keys(await task.run(client, TENANT))).toEqual(['2026', '2027']);
  });

  it('recupera anos perdidos: tenant parado desde 2026 recebe 2027 e 2028 ao voltar em 2027', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { client, holidays } = fakeClient('America/Sao_Paulo', sources);
    const task = new HolidayYearGeneratorTask(() => new Date('2027-03-01T12:00:00Z'));

    const counts = await task.run(client, TENANT);

    expect(counts).toEqual({ '2027': 3, '2028': 3 });
    expect(holidays.filter((holiday) => holiday.date.startsWith('2028'))).toHaveLength(3);
  });
});

describe('maintenance.tenant-housekeeping (queues.md §4.8)', () => {
  it('executa as tarefas, cada uma na tenantTransaction do tenant do job, e roda com tenant suspenso', async () => {
    const run = vi.fn(() => Promise.resolve({ x: 1 }));
    const job = new TenantHousekeepingJob([
      { name: 'a', run },
      { name: 'b', run },
    ]);
    const transaction = vi.fn((work: (client: SqlClient) => Promise<unknown>) =>
      work({} as SqlClient),
    );
    const context = {
      meta: { tenantId: TENANT },
      logger: { log: vi.fn() },
      tenantTransaction: transaction,
    } as unknown as JobHandlerContext;

    await expect(job.handle({}, context)).resolves.toBe('completed');
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith({}, TENANT);
    expect(job.runsForSuspendedTenant).toBe(true);
  });

  it('job sem tenant (plataforma) conclui sem executar nada', async () => {
    const run = vi.fn();
    const job = new TenantHousekeepingJob([{ name: 'a', run }]);
    const context = { meta: { tenantId: null } } as unknown as JobHandlerContext;
    await expect(job.handle({}, context)).resolves.toBe('skipped');
    expect(run).not.toHaveBeenCalled();
  });
});
