// Geração do calendário do ano seguinte (US-106 · RN-TEN-76) sobre PostgreSQL real, com o papel
// `cf_worker` (sem BYPASSRLS): a tarefa roda na TenantTransaction de A, gera os recorrentes do ano
// corrente e do seguinte — móveis recalculados pela Páscoa —, é idempotente, respeita o que o
// administrador ajustou (inativo/escopo) e nunca lê nem grava dados da Prefeitura B.
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HolidayYearGeneratorTask } from '../../src/maintenance/holiday-year-generator.js';
import { createWorkerDatabase } from '../../src/shared/database/worker-database.js';
import type { WorkerDatabase } from '../../src/shared/database/worker-database.js';
import { startPostgres } from '../support/containers.js';
import type { TestPostgres } from '../support/containers.js';
import { TENANT_A, TENANT_B, seedQueueFixtures } from '../support/queue-fixtures.js';

let db: TestPostgres;
let worker: WorkerDatabase;

beforeAll(async () => {
  Logger.overrideLogger(false);
  db = await startPostgres();
  await seedQueueFixtures(db);
  await db.admin(`
    INSERT INTO holidays (id, tenant_id, date, name, scope, is_recurring, is_system, is_active) VALUES
      ('0192f0a0-0000-7000-8000-0000000a0001', '${TENANT_A}', '2026-12-25', 'Natal', 'NATIONAL', true, true, true),
      ('0192f0a0-0000-7000-8000-0000000a0002', '${TENANT_A}', '2026-04-03', 'Sexta-feira Santa', 'MUNICIPAL', true, true, true),
      ('0192f0a0-0000-7000-8000-0000000a0003', '${TENANT_A}', '2026-06-04', 'Corpus Christi', 'OPTIONAL', true, true, false),
      ('0192f0a0-0000-7000-8000-0000000a0004', '${TENANT_A}', '2026-03-19', 'São José', 'MUNICIPAL', true, false, true),
      ('0192f0a0-0000-7000-8000-0000000a0005', '${TENANT_A}', '2026-08-15', 'Sem recorrência', 'STATE', false, false, true),
      ('0192f0a0-0000-7000-8000-0000000b0001', '${TENANT_B}', '2026-11-17', 'Feriado LEAK-B', 'MUNICIPAL', true, false, true);
  `);
  worker = createWorkerDatabase({ url: db.url('cf_worker') });
});

afterAll(async () => {
  await worker.close();
  await db.stop();
});

const rowsOf = (tenantId: string) =>
  db.admin<{ date: string; name: string; scope: string; is_active: boolean; is_system: boolean }>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, name, scope::text AS scope, is_active, is_system
       FROM holidays WHERE tenant_id = $1 AND date >= '2027-01-01' ORDER BY date, name`,
    [tenantId],
  );

describe('HolidayYearGeneratorTask sobre PostgreSQL (US-106)', () => {
  const task = new HolidayYearGeneratorTask(() => new Date('2026-12-20T12:00:00Z'));

  it('gera 2027 só no tenant do job, recalculando os móveis e herdando o que o administrador ajustou', async () => {
    const digestOfB = await db.admin(
      `SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS d FROM holidays t WHERE tenant_id = $1`,
      [TENANT_B],
    );

    const counts = await worker.tenantTransaction(TENANT_A, (client) => task.run(client, TENANT_A));

    expect(counts).toEqual({ '2026': 0, '2027': 4 });
    expect(await rowsOf(TENANT_A)).toEqual([
      {
        date: '2027-03-19',
        name: 'São José',
        scope: 'MUNICIPAL',
        is_active: true,
        is_system: false,
      },
      {
        date: '2027-03-26',
        name: 'Sexta-feira Santa',
        scope: 'MUNICIPAL',
        is_active: true,
        is_system: true,
      },
      // Corpus Christi inativo no ano anterior continua inativo (herança do ajuste do administrador).
      {
        date: '2027-05-27',
        name: 'Corpus Christi',
        scope: 'OPTIONAL',
        is_active: false,
        is_system: true,
      },
      { date: '2027-12-25', name: 'Natal', scope: 'NATIONAL', is_active: true, is_system: true },
    ]);
    expect(await rowsOf(TENANT_B)).toEqual([]);
    expect(
      await db.admin(
        `SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS d FROM holidays t WHERE tenant_id = $1`,
        [TENANT_B],
      ),
    ).toEqual(digestOfB);
  });

  it('é idempotente: a segunda execução (e a repetição do job) não cria nada', async () => {
    const again = await worker.tenantTransaction(TENANT_A, (client) => task.run(client, TENANT_A));
    expect(again).toEqual({ '2026': 0, '2027': 0 });
    expect(await rowsOf(TENANT_A)).toHaveLength(4);
  });

  it('o tenant B, na própria transação, gera só os dele', async () => {
    const counts = await worker.tenantTransaction(TENANT_B, (client) => task.run(client, TENANT_B));
    expect(counts).toEqual({ '2026': 0, '2027': 1 });
    expect((await rowsOf(TENANT_B)).map((row) => row.name)).toEqual(['Feriado LEAK-B']);
    expect(await rowsOf(TENANT_A)).toHaveLength(4);
  });

  it('a RLS recusa a escrita em outro tenant (WITH CHECK) e o worker não vê as linhas de B', async () => {
    await expect(
      worker.tenantTransaction(TENANT_A, (client) =>
        client.query(
          `INSERT INTO holidays (id, tenant_id, date, name, scope)
           VALUES ('0192f0a0-0000-7000-8000-0000000c0001', $1, '2027-01-02', 'Invasão', 'STATE')`,
          [TENANT_B],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
    const visible = await worker.tenantTransaction(TENANT_A, (client) =>
      client.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM holidays'),
    );
    expect(visible.rows.map((row) => row.tenant_id)).toEqual([TENANT_A]);
  });
});
