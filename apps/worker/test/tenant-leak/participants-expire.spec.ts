// Expiração automática de consultores (US-012 · RN-PROC-134) sobre PostgreSQL real, com o papel
// `cf_worker` (sem BYPASSRLS): a tarefa roda na TenantTransaction de A, revoga só o CONSULTANT
// vencido de A — com a concessão `process_access` (PARTICIPANT) na mesma transação —, grava a
// timeline `PARTICIPANT_REMOVED` com o nome congelado, a auditoria `process.participant_remove`
// (SYSTEM, EXPIRED) e o evento `ProcessParticipantRemoved` PENDING no outbox; é idempotente e nunca
// toca a Prefeitura B. O processo vem por SQL com as FKs desligadas (`session_replication_role`):
// o que se prova aqui é a tarefa, não o agregado.
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ParticipantsExpireTask } from '../../src/maintenance/participants-expire.js';
import { createWorkerDatabase } from '../../src/shared/database/worker-database.js';
import type { WorkerDatabase } from '../../src/shared/database/worker-database.js';
import { startPostgres } from '../support/containers.js';
import type { TestPostgres } from '../support/containers.js';
import { TENANT_A, TENANT_B, seedQueueFixtures } from '../support/queue-fixtures.js';

const PROCESS_A = '0192f012-0000-7000-8000-0000000000a1';
const PROCESS_B = '0192f012-0000-7000-8000-0000000000b1';
const DIEGO = '0192f012-0000-7000-8000-0000000000c1';
const ELISA = '0192f012-0000-7000-8000-0000000000c2';
const CARLA = '0192f012-0000-7000-8000-0000000000c3';
const EXPIRED_A = '0192f012-0000-7000-8000-0000000000d1';
const VALID_A = '0192f012-0000-7000-8000-0000000000d2';
const OBSERVER_A = '0192f012-0000-7000-8000-0000000000d3';
const EXPIRED_B = '0192f012-0000-7000-8000-0000000000d4';
const ANY = '0192f012-0000-7000-8000-0000000000ff';
const NOW = new Date('2026-10-23T06:00:00.000Z');

let db: TestPostgres;
let worker: WorkerDatabase;

const processSql = (id: string, tenantId: string) => `
  INSERT INTO processes (id, tenant_id, organization_id, year, title, object, contracting_type_id,
    requesting_secretariat_id, requesting_department_id, current_department_id, workflow_version_id,
    origin_id, pca_status, created_by_id)
  VALUES ('${id}', '${tenantId}', '${ANY}', 2026, 'Processo', 'Objeto', '${ANY}', '${ANY}', '${ANY}',
    '${ANY}', '${ANY}', '${ANY}', 'NOT_APPLICABLE', '${CARLA}');`;

const participantSql = (
  id: string,
  tenantId: string,
  processId: string,
  userId: string,
  role: string,
  expiresAt: string | null,
) => `
  INSERT INTO process_participants (id, tenant_id, process_id, user_id, role, granted_by_id, expires_at)
  VALUES ('${id}', '${tenantId}', '${processId}', '${userId}', '${role}', '${CARLA}',
    ${expiresAt === null ? 'NULL' : `'${expiresAt}'`});
  INSERT INTO process_access (id, tenant_id, process_id, principal_type, user_id, reason, source_id)
  VALUES (gen_random_uuid(), '${tenantId}', '${processId}', 'USER', '${userId}', 'PARTICIPANT', '${id}');`;

beforeAll(async () => {
  Logger.overrideLogger(false);
  db = await startPostgres();
  await seedQueueFixtures(db);
  await db.admin(`
    INSERT INTO users (id, external_subject, email, name, social_name) VALUES
      ('${DIEGO}', 'sub-diego-us012', 'diego@consultoria.test', 'Diego Alves', NULL),
      ('${ELISA}', 'sub-elisa-us012', 'elisa@a.test', 'Elisa Melo', 'Elisa'),
      ('${CARLA}', 'sub-carla-us012', 'carla@a.test', 'Carla Dias', NULL);
    SET session_replication_role = replica;
    ${processSql(PROCESS_A, TENANT_A)}
    ${processSql(PROCESS_B, TENANT_B)}
    SET session_replication_role = origin;
    ${participantSql(EXPIRED_A, TENANT_A, PROCESS_A, DIEGO, 'CONSULTANT', '2026-10-22T00:00:00Z')}
    ${participantSql(VALID_A, TENANT_A, PROCESS_A, ELISA, 'CONSULTANT', '2026-12-31T00:00:00Z')}
    ${participantSql(OBSERVER_A, TENANT_A, PROCESS_A, CARLA, 'OBSERVER', null)}
    ${participantSql(EXPIRED_B, TENANT_B, PROCESS_B, DIEGO, 'CONSULTANT', '2026-10-01T00:00:00Z')}
  `);
  worker = createWorkerDatabase({ url: db.url('cf_worker') });
});

afterAll(async () => {
  await worker.close();
  await db.stop();
});

const state = (participantId: string) =>
  db.admin<{ revoked: boolean; revoked_by_id: string | null; access_revoked: boolean }>(
    `SELECT pp.revoked_at IS NOT NULL AS revoked, pp.revoked_by_id,
            bool_and(pa.revoked_at IS NOT NULL) AS access_revoked
       FROM process_participants pp
       JOIN process_access pa ON pa.source_id = pp.id
      WHERE pp.id = $1
      GROUP BY pp.id`,
    [participantId],
  );

describe('ParticipantsExpireTask sobre PostgreSQL (US-012 · RN-PROC-134)', () => {
  const task = new ParticipantsExpireTask(() => NOW);

  it('[Sucesso] revoga só o consultor vencido de A, com ProcessAccess, timeline, auditoria e evento na mesma transação', async () => {
    const counts = await worker.tenantTransaction(TENANT_A, (client) => task.run(client, TENANT_A));
    expect(counts).toEqual({ expired: 1 });

    expect(await state(EXPIRED_A)).toEqual([
      { revoked: true, revoked_by_id: null, access_revoked: true },
    ]);
    expect(await state(VALID_A)).toEqual([
      { revoked: false, revoked_by_id: null, access_revoked: false },
    ]);
    expect(await state(OBSERVER_A)).toEqual([
      { revoked: false, revoked_by_id: null, access_revoked: false },
    ]);
    // Tenant B intocado.
    expect(await state(EXPIRED_B)).toEqual([
      { revoked: false, revoked_by_id: null, access_revoked: false },
    ]);

    const [event] = await db.admin<{ payload: unknown; status: string; metadata: unknown }>(
      `SELECT payload, status::text AS status, metadata FROM outbox_events
        WHERE event_type = 'ProcessParticipantRemoved' AND aggregate_id = $1`,
      [PROCESS_A],
    );
    expect(event).toMatchObject({
      payload: { participantId: EXPIRED_A, reason: 'EXPIRED' },
      status: 'PENDING',
      metadata: { actor: { type: 'SYSTEM', userId: null, membershipId: null } },
    });
    expect(
      await db.admin(
        `SELECT type, actor_type::text AS actor_type, params, visibility::text AS visibility
           FROM process_timeline_entries WHERE process_id = $1`,
        [PROCESS_A],
      ),
    ).toEqual([
      {
        type: 'PARTICIPANT_REMOVED',
        actor_type: 'SYSTEM',
        params: { name: 'Diego Alves', role: 'CONSULTANT', reason: 'EXPIRED' },
        visibility: 'STANDARD',
      },
    ]);
    expect(
      await db.admin(
        `SELECT action, actor_type::text AS actor_type, entity_id, metadata
           FROM audit_logs WHERE process_id = $1`,
        [PROCESS_A],
      ),
    ).toEqual([
      {
        action: 'process.participant_remove',
        actor_type: 'SYSTEM',
        entity_id: EXPIRED_A,
        metadata: { reason: 'EXPIRED', role: 'CONSULTANT' },
      },
    ]);
  });

  it('é idempotente: a segunda execução não revoga nem emite de novo', async () => {
    const again = await worker.tenantTransaction(TENANT_A, (client) => task.run(client, TENANT_A));
    expect(again).toEqual({ expired: 0 });
    expect(
      await db.admin(
        `SELECT count(*)::int AS count FROM outbox_events WHERE event_type = 'ProcessParticipantRemoved'`,
      ),
    ).toEqual([{ count: 1 }]);
  });

  it('a RLS limita a tarefa ao tenant do job: com o tenant de A, o consultor de B nunca é revogado', async () => {
    // Mesmo pedindo o tenant B, a transação de A não enxerga as linhas de B (RLS).
    const counts = await worker.tenantTransaction(TENANT_A, (client) => task.run(client, TENANT_B));
    expect(counts).toEqual({ expired: 0 });
    expect(await state(EXPIRED_B)).toEqual([
      { revoked: false, revoked_by_id: null, access_revoked: false },
    ]);
    const own = await worker.tenantTransaction(TENANT_B, (client) => task.run(client, TENANT_B));
    expect(own).toEqual({ expired: 1 });
  });
});
