// Interessados no processo para `PROCESS_STATUS_CHANGED` (US-008 · events.md §6) sobre PostgreSQL
// real, com o papel `cf_worker` (sem BYPASSRLS): criador, responsável atual e participantes pessoais
// com `notify`, não revogados e dentro da validade — nada de outro tenant (RLS) nem de processo
// descartado. O cenário vem por SQL com as FKs desligadas (`session_replication_role`).
import type { DomainEventEnvelope } from '@contrataflow/types';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProcessStakeholdersLookup } from '../../src/notifications/process-stakeholders.lookup.js';
import { createWorkerDatabase } from '../../src/shared/database/worker-database.js';
import type { WorkerDatabase } from '../../src/shared/database/worker-database.js';
import { startPostgres } from '../support/containers.js';
import type { TestPostgres } from '../support/containers.js';
import { TENANT_A, TENANT_B, seedQueueFixtures } from '../support/queue-fixtures.js';

const id = (n: number) => `0192f008-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ORG = id(1);
const UNIT = id(2);
const PROCESS = id(3);
const DISCARDED = id(4);
const ORG_B = id(5);
const UNIT_B = id(6);
const PROCESS_B = id(7);
const NOW = new Date('2026-10-06T13:00:00.000Z');

const USERS = {
  ana: id(101),
  juliana: id(102),
  observer: id(103),
  muted: id(104),
  revoked: id(105),
  expired: id(106),
  otherTenant: id(107),
} as const;

let db: TestPostgres;
let worker: WorkerDatabase;
let seq = 1000;
const next = () => id((seq += 1));

function processRow(
  processId: string,
  tenantId: string,
  org: string,
  unit: string,
  deleted = false,
) {
  return `INSERT INTO processes (id, tenant_id, organization_id, year, title, object, contracting_type_id,
      requesting_secretariat_id, requesting_department_id, current_department_id, workflow_version_id,
      origin_id, pca_status, created_by_id, current_responsible_id, deleted_at)
    VALUES ('${processId}', '${tenantId}', '${org}', 2026, 'Processo', 'Objeto', '${org}', '${unit}',
      '${unit}', '${unit}', '${org}', '${org}', 'NOT_APPLICABLE', '${USERS.ana}', '${USERS.juliana}',
      ${deleted ? "'2026-10-01T00:00:00Z'" : 'NULL'});`;
}

function participant(
  processId: string,
  userId: string,
  options: { tenantId?: string; notify?: boolean; revoked?: boolean; expiresAt?: string } = {},
) {
  return `INSERT INTO process_participants (id, tenant_id, process_id, user_id, role, notify,
      granted_by_id, expires_at, revoked_at)
    VALUES ('${next()}', '${options.tenantId ?? TENANT_A}', '${processId}', '${userId}',
      '${options.expiresAt ? 'CONSULTANT' : 'OBSERVER'}', ${String(options.notify ?? true)},
      '${USERS.ana}', ${options.expiresAt ? `'${options.expiresAt}'` : 'NULL'},
      ${options.revoked ? "'2026-10-01T00:00:00Z'" : 'NULL'});`;
}

beforeAll(async () => {
  Logger.overrideLogger(false);
  db = await startPostgres();
  await seedQueueFixtures(db);
  await db.admin(`
    SET session_replication_role = replica;
    INSERT INTO users (id, external_subject, email, name)
      SELECT u, NULL, u || '@a.test', 'Servidor' FROM unnest(ARRAY[
        '${USERS.ana}', '${USERS.juliana}', '${USERS.observer}', '${USERS.muted}',
        '${USERS.revoked}', '${USERS.expired}', '${USERS.otherTenant}']::uuid[]) AS u;
    ${processRow(PROCESS, TENANT_A, ORG, UNIT)}
    ${processRow(DISCARDED, TENANT_A, ORG, UNIT, true)}
    ${processRow(PROCESS_B, TENANT_B, ORG_B, UNIT_B)}
    ${participant(PROCESS, USERS.observer)}
    ${participant(PROCESS, USERS.muted, { notify: false })}
    ${participant(PROCESS, USERS.revoked, { revoked: true })}
    ${participant(PROCESS, USERS.expired, { expiresAt: '2026-10-01T00:00:00Z' })}
    ${participant(PROCESS, USERS.juliana)}
    ${participant(PROCESS_B, USERS.otherTenant, { tenantId: TENANT_B })}
    SET session_replication_role = origin;
  `);
  worker = createWorkerDatabase({ url: db.url('cf_worker') });
});

afterAll(async () => {
  await worker.close();
  await db.stop();
});

const event = (processId: string) =>
  ({ processId, payload: {} }) as unknown as DomainEventEnvelope<Record<string, unknown>>;

describe('ProcessStakeholdersLookup sobre PostgreSQL (US-008)', () => {
  const lookup = new ProcessStakeholdersLookup(() => NOW);
  const stakeholders = (processId: string, tenantId = TENANT_A) =>
    worker.tenantTransaction(tenantId, (client) => lookup.resolve(client, event(processId)));

  it('[Sucesso] criador, responsável e participantes com notify, sem repetir ninguém', async () => {
    expect([...(await stakeholders(PROCESS))].sort()).toEqual(
      [USERS.ana, USERS.juliana, USERS.observer].sort(),
    );
  });

  it('processo descartado não tem interessados', async () => {
    expect(await stakeholders(DISCARDED)).toEqual([]);
  });

  it('[Tenant incorreto] na transação de B, o processo de A não aparece', async () => {
    expect(await stakeholders(PROCESS, TENANT_B)).toEqual([]);
    expect([...(await stakeholders(PROCESS_B, TENANT_B))].sort()).toEqual(
      [USERS.ana, USERS.juliana, USERS.otherTenant].sort(),
    );
  });
});
