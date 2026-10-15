// Suíte "tenant leak" aplicada a um handler de fila (US-083 · DoD · RN-FND-64): o job de
// `deadlines` da Prefeitura A roda na TenantTransaction de A (RLS do papel cf_worker) e não lê nem
// altera dados da Prefeitura B, mesmo com o id de B no payload — a política falha fechada.
import type { DeadLetterRecord } from '@contrataflow/types';
import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { JobHandler } from '../../src/queues/run-job.js';
import { startPostgres, startRedis } from '../support/containers.js';
import type { TestPostgres, TestRedis } from '../support/containers.js';
import {
  DOC_TYPE_B,
  TENANT_A,
  TENANT_B,
  jobMeta,
  seedQueueFixtures,
  startRuntime,
} from '../support/queue-fixtures.js';
import type { RunningRuntime } from '../support/queue-fixtures.js';

let db: TestPostgres;
let redis: TestRedis;
let worker: RunningRuntime | undefined;

beforeAll(async () => {
  Logger.overrideLogger(false);
  [db, redis] = await Promise.all([startPostgres(), startRedis()]);
  await seedQueueFixtures(db);
});

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
});

afterAll(async () => {
  await Promise.all([db.stop(), redis.stop()]);
});

const payloadSchema = z.strictObject({ documentTypeId: z.uuid(), mode: z.enum(['read', 'write']) });

interface ScanResult {
  readonly read: number;
  readonly updated: number;
}

/** `DeadlineScanner` de teste: lê e "marca" a entidade do payload no tenant do job. */
function scanner(results: ScanResult[]): JobHandler<never> {
  const handler: JobHandler<z.infer<typeof payloadSchema>> = {
    queue: 'deadlines',
    name: 'scan-tenant',
    payloadSchema,
    handle: async (payload, context) => {
      await context.tenantTransaction(async (client) => {
        if (payload.mode === 'write') {
          // Escrita no tenant errado: a política WITH CHECK recusa (42501).
          await client.query(
            "INSERT INTO document_types (id, tenant_id, code, name, kind) VALUES (gen_random_uuid(), $1, 'INVASAO', 'x', 'FREE_TEXT')",
            [TENANT_B],
          );
          return;
        }
        const read = await client.query('SELECT id FROM document_types WHERE id = $1', [
          payload.documentTypeId,
        ]);
        const updated = await client.query(
          "UPDATE document_types SET name = 'alterado pelo job' WHERE id = $1",
          [payload.documentTypeId],
        );
        results.push({ read: read.rowCount ?? 0, updated: updated.rowCount ?? 0 });
      });
      return 'completed';
    },
  };
  return handler as unknown as JobHandler<never>;
}

const config = () => ({
  appEnv: 'test' as const,
  redisUrl: redis.url,
  workerDatabaseUrl: db.url('cf_worker'),
  admin: null,
});

describe('tenant leak — handler de fila (deadlines)', () => {
  it('[Tenant incorreto] job da Prefeitura A com id da Prefeitura B no payload termina sem efeito', async () => {
    const results: ScanResult[] = [];
    worker = await startRuntime(config(), [scanner(results)]);
    const id = await worker.add(
      'deadlines',
      'scan-tenant',
      { meta: jobMeta(TENANT_A), payload: { documentTypeId: DOC_TYPE_B, mode: 'read' } },
      { jobId: 'leak-read' },
    );
    await vi.waitFor(
      async () => {
        expect(await worker?.queue('deadlines').getJobState(id)).toBe('completed');
      },
      { timeout: 15_000 },
    );
    expect(results).toEqual([{ read: 0, updated: 0 }]);
    const [row] = await db.admin<{ name: string; tenant_id: string }>(
      'SELECT name, tenant_id FROM document_types WHERE id = $1',
      [DOC_TYPE_B],
    );
    expect(row).toEqual({ name: 'Ofício B', tenant_id: TENANT_B });
  });

  it('escrita no tenant errado é recusada pela RLS: falha de segurança, sem retry, com cópia na DLQ', async () => {
    worker = await startRuntime(config(), [scanner([])]);
    const id = await worker.add(
      'deadlines',
      'scan-tenant',
      { meta: jobMeta(TENANT_A), payload: { documentTypeId: DOC_TYPE_B, mode: 'write' } },
      { jobId: 'leak-write' },
    );
    await vi.waitFor(
      async () => {
        expect(await worker?.queue('deadlines').getJobState(id)).toBe('failed');
      },
      { timeout: 15_000 },
    );
    expect((await worker.queue('deadlines').getJob(id))?.attemptsMade).toBe(1);
    const copy = await worker.queue('dead-letter').getJob('deadlines.leak-write');
    expect((copy?.data as DeadLetterRecord).error.class).toBe('SECURITY');
    const invaded = await db.admin("SELECT 1 FROM document_types WHERE code = 'INVASAO'");
    expect(invaded).toEqual([]);
  });
});
