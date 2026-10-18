// Visibilidade do processo para notificações (US-072 · DEC-024 · RN-NTF-06) e `Mention.notifiedAt`
// sobre PostgreSQL real, com o papel `cf_worker` (sem BYPASSRLS): o predicado SQL do worker espelha
// o da API para TERCEIROS — concessão própria (consultor vencido não conta), escopos de
// `PROCESS_VIEW` (TENANT, unidade com/sem subárvore, lotação, HISTORICAL conforme a configuração),
// só atribuições vigentes de perfil ativo e vínculo ativo — e nunca enxerga vínculos de outro
// tenant (RLS). O cenário vem por SQL com as FKs desligadas (`session_replication_role`): o que se
// prova aqui é o predicado, não os agregados.
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MentionNotifiedEffect } from '../../src/notifications/mention-notified.effect.js';
import { SqlProcessVisibility } from '../../src/notifications/sql-process-visibility.js';
import { createWorkerDatabase } from '../../src/shared/database/worker-database.js';
import type { WorkerDatabase } from '../../src/shared/database/worker-database.js';
import { startPostgres } from '../support/containers.js';
import type { TestPostgres } from '../support/containers.js';
import { TENANT_A, TENANT_B, seedQueueFixtures } from '../support/queue-fixtures.js';

const id = (n: number) => `0192f072-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ORG = id(1);
const SEC = id(2);
const SETOR = id(3);
const OUTRA = id(4);
const PROCESS = id(5);
const ROLE_VIEW = id(6);
const ROLE_NO_VIEW = id(7);
const ROLE_INACTIVE = id(8);
const ROLE_VIEW_B = id(9);
const PARTICIPANT = id(10);
const COMMENT = id(11);
const MENTION = id(12);

const USERS = {
  tenantWide: id(101),
  subtree: id(102),
  noSubtree: id(103),
  own: id(104),
  ownNoSubtree: id(105),
  historical: id(106),
  direct: id(107),
  expiredConsultant: id(108),
  noPermission: id(109),
  revoked: id(110),
  inactiveRole: id(111),
  suspended: id(112),
  otherTenant: id(113),
} as const;
const NOW = new Date('2026-10-18T12:00:00.000Z');

let db: TestPostgres;
let worker: WorkerDatabase;
let seq = 1000;
const next = () => id((seq += 1));

function member(
  userId: string,
  options: {
    tenantId?: string;
    status?: string;
    departments?: readonly string[];
    role?: string;
    scope?: { type: string; organizationId?: string; departmentId?: string; subtree?: boolean };
    revoked?: boolean;
  },
): string {
  const tenantId = options.tenantId ?? TENANT_A;
  const membershipId = next();
  const scope = options.scope ?? { type: 'TENANT' };
  const lines = [
    `INSERT INTO users (id, external_subject, email, name) VALUES ('${userId}', NULL, '${userId}@a.test', 'Servidor');`,
    `INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES ('${membershipId}', '${tenantId}', '${userId}', 'INTERNAL', '${options.status ?? 'ACTIVE'}');`,
    ...(options.departments ?? []).map(
      (departmentId) =>
        `INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES ('${next()}', '${tenantId}', '${membershipId}', '${departmentId}', true);`,
    ),
  ];
  if (options.role) {
    lines.push(
      `INSERT INTO role_assignments (id, tenant_id, membership_id, role_id, scope_type, scope_organization_id, scope_department_id, include_subtree, valid_from, granted_by_id, revoked_at)
       VALUES ('${next()}', '${tenantId}', '${membershipId}', '${options.role}', '${scope.type}',
               ${scope.organizationId ? `'${scope.organizationId}'` : 'NULL'},
               ${scope.departmentId ? `'${scope.departmentId}'` : 'NULL'},
               ${String(scope.subtree ?? true)}, '2026-01-01T00:00:00Z', '${userId}',
               ${options.revoked ? "'2026-02-01T00:00:00Z'" : 'NULL'});`,
    );
  }
  return lines.join('\n');
}

beforeAll(async () => {
  Logger.overrideLogger(false);
  db = await startPostgres();
  await seedQueueFixtures(db);
  await db.admin(`
    SET session_replication_role = replica;
    INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
      ('${SEC}', '${TENANT_A}', '${ORG}', NULL, 'SECRETARIAT', 'Secretaria', '/${SEC}/', 0),
      ('${SETOR}', '${TENANT_A}', '${ORG}', '${SEC}', 'SECTOR', 'Setor', '/${SEC}/${SETOR}/', 1),
      ('${OUTRA}', '${TENANT_A}', '${ORG}', NULL, 'SECRETARIAT', 'Outra', '/${OUTRA}/', 0);
    INSERT INTO roles (id, tenant_id, key, name, is_active) VALUES
      ('${ROLE_VIEW}', '${TENANT_A}', 'VE', 'Vê processos', true),
      ('${ROLE_NO_VIEW}', '${TENANT_A}', 'NAO_VE', 'Não vê', true),
      ('${ROLE_INACTIVE}', '${TENANT_A}', 'INATIVO', 'Inativo', false),
      ('${ROLE_VIEW_B}', '${TENANT_B}', 'VE', 'Vê processos', true);
    INSERT INTO role_permissions (id, tenant_id, role_id, permission_code) VALUES
      ('${next()}', '${TENANT_A}', '${ROLE_VIEW}', 'PROCESS_VIEW'),
      ('${next()}', '${TENANT_A}', '${ROLE_NO_VIEW}', 'COMMENT_CREATE'),
      ('${next()}', '${TENANT_A}', '${ROLE_INACTIVE}', 'PROCESS_VIEW'),
      ('${next()}', '${TENANT_B}', '${ROLE_VIEW_B}', 'PROCESS_VIEW');
    INSERT INTO processes (id, tenant_id, organization_id, year, title, object, contracting_type_id,
      requesting_secretariat_id, requesting_department_id, current_department_id, workflow_version_id,
      origin_id, pca_status, created_by_id)
    VALUES ('${PROCESS}', '${TENANT_A}', '${ORG}', 2026, 'Processo', 'Objeto', '${ORG}', '${SEC}',
      '${SETOR}', '${SETOR}', '${ORG}', '${ORG}', 'NOT_APPLICABLE', '${USERS.direct}');
    INSERT INTO process_participants (id, tenant_id, process_id, user_id, role, granted_by_id, expires_at)
    VALUES ('${PARTICIPANT}', '${TENANT_A}', '${PROCESS}', '${USERS.expiredConsultant}', 'CONSULTANT',
      '${USERS.direct}', '2026-10-01T00:00:00Z');
    INSERT INTO process_access (id, tenant_id, process_id, principal_type, department_id, user_id, reason, source_id) VALUES
      ('${next()}', '${TENANT_A}', '${PROCESS}', 'DEPARTMENT', '${SETOR}', NULL, 'REQUESTING', NULL),
      ('${next()}', '${TENANT_A}', '${PROCESS}', 'DEPARTMENT', '${OUTRA}', NULL, 'HISTORICAL', NULL),
      ('${next()}', '${TENANT_A}', '${PROCESS}', 'USER', NULL, '${USERS.direct}', 'RESPONSIBLE', NULL),
      ('${next()}', '${TENANT_A}', '${PROCESS}', 'USER', NULL, '${USERS.expiredConsultant}', 'PARTICIPANT', '${PARTICIPANT}');
    ${member(USERS.tenantWide, { role: ROLE_VIEW })}
    ${member(USERS.subtree, { role: ROLE_VIEW, scope: { type: 'DEPARTMENT', departmentId: SEC } })}
    ${member(USERS.noSubtree, { role: ROLE_VIEW, scope: { type: 'DEPARTMENT', departmentId: SEC, subtree: false } })}
    ${member(USERS.own, { role: ROLE_VIEW, scope: { type: 'OWN_DEPARTMENTS' }, departments: [SETOR] })}
    ${member(USERS.ownNoSubtree, { role: ROLE_VIEW, scope: { type: 'OWN_DEPARTMENTS', subtree: false }, departments: [SEC] })}
    ${member(USERS.historical, { role: ROLE_VIEW, scope: { type: 'DEPARTMENT', departmentId: OUTRA } })}
    ${member(USERS.direct, {})}
    ${member(USERS.expiredConsultant, {})}
    ${member(USERS.noPermission, { role: ROLE_NO_VIEW })}
    ${member(USERS.revoked, { role: ROLE_VIEW, revoked: true })}
    ${member(USERS.inactiveRole, { role: ROLE_INACTIVE })}
    ${member(USERS.suspended, { role: ROLE_VIEW, status: 'SUSPENDED' })}
    ${member(USERS.otherTenant, { role: ROLE_VIEW_B, tenantId: TENANT_B })}
    INSERT INTO comments (id, tenant_id, process_id, target_type, author_id, body, body_text)
    VALUES ('${COMMENT}', '${TENANT_A}', '${PROCESS}', 'PROCESS', '${USERS.direct}', '{"type":"doc"}', 'Veja');
    INSERT INTO mentions (id, tenant_id, comment_id, process_id, mentioned_user_id)
    VALUES ('${MENTION}', '${TENANT_A}', '${COMMENT}', '${PROCESS}', '${USERS.tenantWide}');
    SET session_replication_role = origin;
  `);
  worker = createWorkerDatabase({ url: db.url('cf_worker') });
});

afterAll(async () => {
  await worker.close();
  await db.stop();
});

describe('SqlProcessVisibility (US-072 · DEC-024)', () => {
  const visibility = new SqlProcessVisibility(() => NOW);
  const visible = (tenantId = TENANT_A) =>
    worker.tenantTransaction(tenantId, (client) =>
      visibility.visibleTo(client, PROCESS, Object.values(USERS)),
    );

  it('mesmo predicado da API: concessão própria, TENANT, subárvore, lotação e HISTORICAL', async () => {
    expect([...(await visible())].sort()).toEqual(
      [USERS.tenantWide, USERS.subtree, USERS.own, USERS.historical, USERS.direct].sort(),
    );
  });

  it('access.historicalDepartmentsCanView = false: a unidade HISTORICAL deixa de ver', async () => {
    await db.admin(
      `INSERT INTO tenant_settings (id, tenant_id, key, value) VALUES ($1, $2, 'access.historicalDepartmentsCanView', 'false'::jsonb)`,
      [next(), TENANT_A],
    );
    try {
      expect(await visible()).not.toContain(USERS.historical);
    } finally {
      await db.admin(
        "DELETE FROM tenant_settings WHERE key = 'access.historicalDepartmentsCanView'",
      );
    }
  });

  it('[Tenant incorreto] na transação de B, nada de A é visível', async () => {
    expect(await visible(TENANT_B)).toEqual(new Set());
  });
});

describe('MentionNotifiedEffect (US-072 · Mention.notifiedAt)', () => {
  it('marca notified_at uma vez (GRANT de UPDATE só na coluna) e não toca outro tenant', async () => {
    const effect = new MentionNotifiedEffect();
    const event = { payload: { mentionId: MENTION } } as unknown as Parameters<
      typeof effect.apply
    >[1];
    await worker.tenantTransaction(TENANT_B, (client) => effect.apply(client, event, NOW));
    expect(await db.admin('SELECT notified_at FROM mentions WHERE id = $1', [MENTION])).toEqual([
      { notified_at: null },
    ]);
    await worker.tenantTransaction(TENANT_A, (client) => effect.apply(client, event, NOW));
    await worker.tenantTransaction(TENANT_A, (client) =>
      effect.apply(client, event, new Date('2026-10-19T00:00:00Z')),
    );
    expect(await db.admin('SELECT notified_at FROM mentions WHERE id = $1', [MENTION])).toEqual([
      { notified_at: NOW },
    ]);
    // O papel do worker não altera outras colunas da menção.
    await expect(
      worker.tenantTransaction(TENANT_A, (client) =>
        client.query('UPDATE mentions SET mentioned_user_id = NULL WHERE id = $1', [MENTION]),
      ),
    ).rejects.toThrow();
  });
});
