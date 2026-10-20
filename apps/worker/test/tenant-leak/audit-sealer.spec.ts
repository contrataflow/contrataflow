// Selagem horária da trilha (US-074 · RN-AUD-11..14) sobre PostgreSQL real, com o papel
// `cf_worker` (sem BYPASSRLS): o selo de A só lê os registros de A, a cadeia encadeia no selo
// anterior, a reexecução e dois workers simultâneos gravam um único selo por período, uma falha no
// meio da transação não deixa selo parcial e `audit_seals` é imutável e isolada por tenant.
import { createHash } from 'node:crypto';

import { uuidv7 } from '@contrataflow/observability';
import { AUDIT_ACTIONS } from '@contrataflow/types';
import type { AuditAction } from '@contrataflow/types';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { rowHashOf } from '../../src/admin/platform-audit.js';
import type { AuditRow } from '../../src/admin/platform-audit.js';
import { AuditSealer, GENESIS_CHAIN_HASH, chainHashOf } from '../../src/audit/audit-sealer.js';
import type { JobHandlerContext } from '../../src/queues/run-job.js';
import type { SqlClient } from '../../src/shared/database/outbox-database.js';
import { createWorkerDatabase } from '../../src/shared/database/worker-database.js';
import type { WorkerDatabase } from '../../src/shared/database/worker-database.js';
import { startPostgres } from '../support/containers.js';
import type { TestPostgres } from '../support/containers.js';
import { TENANT_A, TENANT_B, jobMeta, seedQueueFixtures } from '../support/queue-fixtures.js';

const HOUR_MS = 3_600_000;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Dia 1 do mês seguinte (UTC): a migração já criou a partição de `audit_logs` dele. */
const now = new Date();
const BASE = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
const at = (hour: number, minute = 0, second = 0) =>
  new Date(BASE + hour * HOUR_MS + minute * 60_000 + second * 1_000);

let db: TestPostgres;
let worker: WorkerDatabase;

beforeAll(async () => {
  Logger.overrideLogger(false);
  db = await startPostgres();
  await seedQueueFixtures(db);
  worker = createWorkerDatabase({ url: db.url('cf_worker') });
});

afterAll(async () => {
  await worker.close();
  await db.stop();
});

/** Registro de trilha gravado como a API grava (rowHash RN-AUD-08), direto pelo superusuário. */
async function insertLog(
  tenantId: string,
  occurredAt: Date,
  action: AuditAction = 'process.create',
): Promise<AuditRow> {
  const row: AuditRow = {
    id: uuidv7(),
    occurredAt,
    tenantId,
    actorType: 'SYSTEM',
    actorUserId: null,
    actorName: 'teste',
    actorMembershipId: null,
    onBehalfOfUserId: null,
    action,
    category: AUDIT_ACTIONS[action].category,
    result: 'SUCCESS',
    entityType: null,
    entityId: null,
    processId: null,
    changes: null,
    metadata: { n: occurredAt.getTime() },
    reasonCode: null,
    ip: null,
    userAgent: null,
    correlationId: 'corr-seal-it',
    requestId: null,
    sessionIdHash: null,
  };
  await db.admin(
    `INSERT INTO audit_logs (id, occurred_at, tenant_id, actor_type, actor_name, action, category,
       result, metadata, correlation_id, row_hash)
     VALUES ($1, $2, $3, 'SYSTEM', $4, $5, $6::audit_category, 'SUCCESS', $7::jsonb, $8, $9)`,
    [
      row.id,
      row.occurredAt,
      tenantId,
      row.actorName,
      action,
      row.category,
      JSON.stringify(row.metadata),
      row.correlationId,
      rowHashOf(row),
    ],
  );
  return row;
}

function contextFor(
  tenantId: string,
  wrap: (client: SqlClient) => SqlClient = (client) => client,
): JobHandlerContext {
  return {
    meta: jobMeta(tenantId, { correlationId: 'scheduler:audit-seal-tick' }),
    queue: 'audit-seal',
    jobName: 'seal-tenant',
    jobId: `audit-seal.${tenantId}`,
    attempt: 1,
    maxAttempts: 5,
    signal: new AbortController().signal,
    logger: new Logger('audit-seal:seal-tenant'),
    tenantTransaction: (work) => worker.tenantTransaction(tenantId, (client) => work(wrap(client))),
    platformTransaction: () => Promise.reject(new Error('sem plataforma')),
  };
}

interface SealRow {
  id: string;
  period_start: Date;
  record_count: number;
  digest: string;
  chain_hash: string;
  previous_seal_id: string | null;
  first_audit_id: string;
  last_audit_id: string;
}

const sealsOf = (tenantId: string) =>
  db.admin<SealRow>(
    `SELECT id::text, period_start, record_count, digest, chain_hash, previous_seal_id::text,
            first_audit_id::text, last_audit_id::text
       FROM audit_seals WHERE tenant_id = $1 ORDER BY period_start`,
    [tenantId],
  );

describe('AuditSealer sobre PostgreSQL (US-074)', () => {
  const H0 = sha('H0');
  const H0_SEAL = '0192f074-0000-7000-8000-0000000000a0';
  let periodRows: AuditRow[] = [];

  it('[Sucesso] 10 registros entre 14:00 e 14:59 e selo anterior H0: selo encadeado e audit.seal no período seguinte', async () => {
    // Selo anterior (13h) com chainHash H0.
    await db.admin(
      `INSERT INTO audit_seals (id, tenant_id, period_start, period_end, first_audit_id,
         last_audit_id, record_count, digest, chain_hash, sealed_at)
       VALUES ($1, $2, $3, $4, $1, $1, 1, $5, $6, $7)`,
      [H0_SEAL, TENANT_A, at(13), new Date(at(14).getTime() - 1), sha('d13'), H0, at(14, 5)],
    );
    periodRows = [];
    for (let minute = 0; minute < 10; minute += 1) {
      periodRows.push(await insertLog(TENANT_A, at(14, minute * 6, 30)));
    }
    // Ruído: registros de B na mesma hora e de A na hora corrente (aberta).
    await insertLog(TENANT_B, at(14, 10));
    await insertLog(TENANT_A, at(15, 1));

    const sealer = new AuditSealer({ now: () => at(15, 5) });
    await expect(sealer.handle({}, contextFor(TENANT_A))).resolves.toBe('completed');

    const seals = await sealsOf(TENANT_A);
    expect(seals).toHaveLength(2);
    const [, seal] = seals;
    if (!seal) throw new Error('selo das 14h ausente');
    const digest = sha(periodRows.map((row) => rowHashOf(row)).join(''));
    expect(seal).toMatchObject({
      period_start: at(14),
      record_count: 10,
      digest,
      chain_hash: chainHashOf(H0, digest),
      previous_seal_id: H0_SEAL,
      first_audit_id: periodRows[0]?.id,
      last_audit_id: periodRows[9]?.id,
    });
    const audit = await db.admin<{
      occurred_at: Date;
      actor_type: string;
      category: string;
      metadata: unknown;
      entity_id: string;
    }>(
      `SELECT occurred_at, actor_type::text, category::text, metadata, entity_id::text
         FROM audit_logs WHERE tenant_id = $1 AND action = 'audit.seal'`,
      [TENANT_A],
    );
    expect(audit).toEqual([
      {
        occurred_at: at(15, 5),
        actor_type: 'SYSTEM',
        category: 'SYSTEM',
        entity_id: seal.id,
        metadata: {
          periodStart: at(14).toISOString(),
          periodEnd: new Date(at(15).getTime() - 1).toISOString(),
          recordCount: 10,
          digest,
        },
      },
    ]);
  });

  it('[Duplicidade] reexecução para o mesmo período: nenhum selo nem audit.seal a mais', async () => {
    const sealer = new AuditSealer({ now: () => at(15, 5) });
    await sealer.handle({}, contextFor(TENANT_A));
    await sealer.handle({}, contextFor(TENANT_A));
    expect(await sealsOf(TENANT_A)).toHaveLength(2);
    const [{ total } = { total: 0 }] = await db.admin<{ total: number }>(
      `SELECT count(*)::int AS total FROM audit_logs WHERE tenant_id = $1 AND action = 'audit.seal'`,
      [TENANT_A],
    );
    expect(total).toBe(1);
  });

  it('[Concorrência] dois workers no mesmo período: um único selo, os dois concluem sem erro', async () => {
    for (let index = 0; index < 5; index += 1) await insertLog(TENANT_A, at(16, index));
    const first = new AuditSealer({ now: () => at(17, 5) });
    const second = new AuditSealer({ now: () => at(17, 5) });
    await expect(
      Promise.all([
        first.handle({}, contextFor(TENANT_A)),
        second.handle({}, contextFor(TENANT_A)),
      ]),
    ).resolves.toEqual(['completed', 'completed']);
    const seals = await sealsOf(TENANT_A);
    // 15h teve só o 15:01 (process.create) e o audit.seal das 15:05: selada; 16h selada uma vez.
    expect(seals.map((seal) => seal.period_start.getTime())).toEqual([
      at(13).getTime(),
      at(14).getTime(),
      at(15).getTime(),
      at(16).getTime(),
    ]);
    // A cadeia é contínua: cada selo aponta para o anterior.
    for (let index = 1; index < seals.length; index += 1) {
      expect(seals[index]?.previous_seal_id).toBe(seals[index - 1]?.id);
      expect(seals[index]?.chain_hash).toBe(
        chainHashOf(seals[index - 1]?.chain_hash ?? '', seals[index]?.digest ?? ''),
      );
    }
  });

  it('RN-AUD-12: hora só com audit.seal não é selada; lacunas não geram selo vazio', async () => {
    // 17h só tem o audit.seal das 17:05; 18h e 19h vazias; 20h com atividade.
    await insertLog(TENANT_A, at(20, 30));
    await new AuditSealer({ now: () => at(21, 5) }).handle({}, contextFor(TENANT_A));
    const seals = await sealsOf(TENANT_A);
    const [before, last] = seals.slice(-2);
    if (!before || !last) throw new Error('selos ausentes');
    expect(last.period_start).toEqual(at(20));
    expect(before.period_start).toEqual(at(16));
    expect(last.previous_seal_id).toBe(before.id);
    expect(last.record_count).toBe(1);
  });

  it('[Falha de banco] falha depois do INSERT do selo: a transação desfaz tudo; a nova tentativa sela', async () => {
    await insertLog(TENANT_A, at(22, 10));
    const failing = (client: SqlClient): SqlClient => ({
      query: (sql, params) =>
        sql.includes('INSERT INTO audit_logs')
          ? Promise.reject(Object.assign(new Error('terminating connection'), { code: '57P01' }))
          : client.query(sql, params),
    });
    const sealer = new AuditSealer({ now: () => at(23, 5) });
    await expect(sealer.handle({}, contextFor(TENANT_A, failing))).rejects.toThrow(
      'terminating connection',
    );
    expect(
      (await sealsOf(TENANT_A)).some((seal) => seal.period_start.getTime() === at(22).getTime()),
    ).toBe(false);

    await sealer.handle({}, contextFor(TENANT_A));
    expect((await sealsOf(TENANT_A)).at(-1)?.period_start).toEqual(at(22));
  });

  it('[Tenant] a cadeia de B começa do zero e nunca lê nem vê os selos de A', async () => {
    await new AuditSealer({ now: () => at(15, 5) }).handle({}, contextFor(TENANT_B));
    const [seal, ...rest] = await sealsOf(TENANT_B);
    expect(rest).toEqual([]);
    expect(seal).toMatchObject({ period_start: at(14), record_count: 1, previous_seal_id: null });
    expect(seal?.chain_hash).toBe(chainHashOf(GENESIS_CHAIN_HASH, seal?.digest ?? ''));

    const visible = await worker.tenantTransaction(TENANT_B, (client) =>
      client.query<{ tenant_id: string }>('SELECT tenant_id::text FROM audit_seals'),
    );
    expect(new Set(visible.rows.map((row) => row.tenant_id))).toEqual(new Set([TENANT_B]));
    await expect(
      worker.tenantTransaction(TENANT_B, (client) =>
        client.query(
          `INSERT INTO audit_seals (id, tenant_id, period_start, period_end, first_audit_id,
             last_audit_id, record_count, digest, chain_hash, sealed_at)
           VALUES ($1, $2, $3, $4, $1, $1, 1, $5, $5, now())`,
          [uuidv7(), TENANT_A, at(2), new Date(at(3).getTime() - 1), sha('x')],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('audit_seals é imutável: o worker não altera e nem o superusuário apaga', async () => {
    await expect(
      worker.tenantTransaction(TENANT_A, (client) =>
        client.query(`UPDATE audit_seals SET record_count = 99 WHERE tenant_id = $1`, [TENANT_A]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(db.admin(`DELETE FROM audit_seals WHERE id = $1`, [H0_SEAL])).rejects.toThrow(
      /imutável/,
    );
    await expect(
      db.admin(`UPDATE audit_seals SET digest = $2 WHERE id = $1`, [H0_SEAL, sha('y')]),
    ).rejects.toThrow(/imutável/);
  });
});
