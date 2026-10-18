// Detentores do perfil aprovador para `APPROVAL_REQUESTED` (US-051 · DEC-022 · RN-TRAM-47) sobre
// PostgreSQL real, com o papel `cf_worker` (sem BYPASSRLS): a mesma competência da API — atribuição
// vigente do perfil ativo, vínculo ativo, escopo `TENANT`, órgão do processo ou unidade
// (`DEPARTMENT`/`OWN_DEPARTMENTS`, subárvore pelo `path`) contendo a secretaria/setor solicitante.
// Concessões `CURRENT`/`HISTORICAL` (tramitação) NÃO contam e nada de outro tenant aparece (RLS).
// O cenário vem por SQL com as FKs desligadas (`session_replication_role`).
import type { DomainEventEnvelope } from '@contrataflow/types';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RoleHoldersLookup } from '../../src/notifications/role-holders.lookup.js';
import { createWorkerDatabase } from '../../src/shared/database/worker-database.js';
import type { WorkerDatabase } from '../../src/shared/database/worker-database.js';
import { startPostgres } from '../support/containers.js';
import type { TestPostgres } from '../support/containers.js';
import { TENANT_A, TENANT_B, seedQueueFixtures } from '../support/queue-fixtures.js';

const id = (n: number) => `0192f051-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ORG = id(1);
const OTHER_ORG = id(2);
const SEC = id(3);
const SETOR = id(4);
const VISITED = id(5);
const CURRENT = id(6);
const GABINETE = id(7);
const PROCESS = id(8);
const AUTORIDADE = id(9);
const OUTRO_PERFIL = id(10);
const AUTORIDADE_B = id(11);

const USERS = {
  tenantWide: id(101),
  organization: id(102),
  otherOrganization: id(103),
  secretariat: id(104),
  sectorNoSubtree: id(105),
  cabinetSubtree: id(106),
  cabinetNoSubtree: id(107),
  ownSector: id(108),
  /** "Vera": o perfil só sobre a unidade pela qual o processo tramitou (HISTORICAL). */
  historical: id(109),
  /** Lotado na unidade ATUAL do processo (CURRENT), sem escopo sobre a solicitante. */
  currentUnit: id(110),
  revoked: id(111),
  suspended: id(112),
  otherRole: id(113),
  otherTenant: id(114),
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
  return [
    `INSERT INTO users (id, external_subject, email, name) VALUES ('${userId}', NULL, '${userId}@a.test', 'Servidor');`,
    `INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES ('${membershipId}', '${tenantId}', '${userId}', 'INTERNAL', '${options.status ?? 'ACTIVE'}');`,
    ...(options.departments ?? []).map(
      (departmentId) =>
        `INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES ('${next()}', '${tenantId}', '${membershipId}', '${departmentId}', true);`,
    ),
    `INSERT INTO role_assignments (id, tenant_id, membership_id, role_id, scope_type, scope_organization_id, scope_department_id, include_subtree, valid_from, granted_by_id, revoked_at)
     VALUES ('${next()}', '${tenantId}', '${membershipId}', '${options.role ?? AUTORIDADE}', '${scope.type}',
             ${scope.organizationId ? `'${scope.organizationId}'` : 'NULL'},
             ${scope.departmentId ? `'${scope.departmentId}'` : 'NULL'},
             ${String(scope.subtree ?? true)}, '2026-01-01T00:00:00Z', '${userId}',
             ${options.revoked ? "'2026-02-01T00:00:00Z'" : 'NULL'});`,
  ].join('\n');
}

beforeAll(async () => {
  Logger.overrideLogger(false);
  db = await startPostgres();
  await seedQueueFixtures(db);
  await db.admin(`
    SET session_replication_role = replica;
    INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth, head_user_id, deputy_user_id) VALUES
      ('${GABINETE}', '${TENANT_A}', '${ORG}', NULL, 'SECRETARIAT', 'Gabinete', '/${GABINETE}/', 0, NULL, NULL),
      ('${SEC}', '${TENANT_A}', '${ORG}', '${GABINETE}', 'SECRETARIAT', 'Secretaria de Obras', '/${GABINETE}/${SEC}/', 1, NULL, NULL),
      ('${SETOR}', '${TENANT_A}', '${ORG}', '${SEC}', 'SECTOR', 'Setor de Manutenção', '/${GABINETE}/${SEC}/${SETOR}/', 2, NULL, NULL),
      ('${VISITED}', '${TENANT_A}', '${ORG}', NULL, 'SECTOR', 'Planejamento', '/${VISITED}/', 0, NULL, NULL),
      ('${CURRENT}', '${TENANT_A}', '${ORG}', NULL, 'SECTOR', 'Gabinete da autoridade', '/${CURRENT}/', 0, '${USERS.currentUnit}', NULL);
    INSERT INTO roles (id, tenant_id, key, name, is_active) VALUES
      ('${AUTORIDADE}', '${TENANT_A}', 'AUTORIDADE_COMPETENTE', 'Autoridade competente', true),
      ('${OUTRO_PERFIL}', '${TENANT_A}', 'OUTRO', 'Outro perfil', true),
      ('${AUTORIDADE_B}', '${TENANT_B}', 'AUTORIDADE_COMPETENTE', 'Autoridade competente', true);
    INSERT INTO processes (id, tenant_id, organization_id, year, title, object, contracting_type_id,
      requesting_secretariat_id, requesting_department_id, current_department_id, workflow_version_id,
      origin_id, pca_status, created_by_id)
    VALUES ('${PROCESS}', '${TENANT_A}', '${ORG}', 2026, 'Processo', 'Objeto', '${ORG}', '${SEC}',
      '${SETOR}', '${CURRENT}', '${ORG}', '${ORG}', 'NOT_APPLICABLE', '${USERS.tenantWide}');
    INSERT INTO process_access (id, tenant_id, process_id, principal_type, department_id, user_id, reason, source_id) VALUES
      ('${next()}', '${TENANT_A}', '${PROCESS}', 'DEPARTMENT', '${SEC}', NULL, 'REQUESTING', NULL),
      ('${next()}', '${TENANT_A}', '${PROCESS}', 'DEPARTMENT', '${VISITED}', NULL, 'HISTORICAL', NULL),
      ('${next()}', '${TENANT_A}', '${PROCESS}', 'DEPARTMENT', '${CURRENT}', NULL, 'CURRENT', NULL);
    ${member(USERS.tenantWide, {})}
    ${member(USERS.organization, { scope: { type: 'ORGANIZATION', organizationId: ORG } })}
    ${member(USERS.otherOrganization, { scope: { type: 'ORGANIZATION', organizationId: OTHER_ORG } })}
    ${member(USERS.secretariat, { scope: { type: 'DEPARTMENT', departmentId: SEC, subtree: false } })}
    ${member(USERS.sectorNoSubtree, { scope: { type: 'DEPARTMENT', departmentId: SETOR, subtree: false } })}
    ${member(USERS.cabinetSubtree, { scope: { type: 'DEPARTMENT', departmentId: GABINETE } })}
    ${member(USERS.cabinetNoSubtree, { scope: { type: 'DEPARTMENT', departmentId: GABINETE, subtree: false } })}
    ${member(USERS.ownSector, { scope: { type: 'OWN_DEPARTMENTS', subtree: false }, departments: [SETOR] })}
    ${member(USERS.historical, { scope: { type: 'DEPARTMENT', departmentId: VISITED } })}
    ${member(USERS.currentUnit, { scope: { type: 'OWN_DEPARTMENTS' }, departments: [CURRENT] })}
    ${member(USERS.revoked, { revoked: true })}
    ${member(USERS.suspended, { status: 'SUSPENDED' })}
    ${member(USERS.otherRole, { role: OUTRO_PERFIL })}
    ${member(USERS.otherTenant, { role: AUTORIDADE_B, tenantId: TENANT_B })}
    SET session_replication_role = origin;
  `);
  worker = createWorkerDatabase({ url: db.url('cf_worker') });
});

afterAll(async () => {
  await worker.close();
  await db.stop();
});

const event = (roleId: string) =>
  ({
    processId: PROCESS,
    payload: { approvalId: next(), approverType: 'ROLE', approverRoleId: roleId },
  }) as unknown as DomainEventEnvelope<Record<string, unknown>>;

describe('RoleHoldersLookup sobre PostgreSQL (US-051 · DEC-022)', () => {
  const lookup = new RoleHoldersLookup(() => NOW);
  const holders = (roleId: string, tenantId = TENANT_A) =>
    worker.tenantTransaction(tenantId, (client) => lookup.resolve(client, event(roleId)));

  it('[Permissão] só a competência sobre a unidade solicitante: CURRENT/HISTORICAL não contam', async () => {
    expect([...(await holders(AUTORIDADE))].sort()).toEqual(
      [
        USERS.tenantWide,
        USERS.organization,
        USERS.secretariat,
        USERS.sectorNoSubtree,
        USERS.cabinetSubtree,
        USERS.ownSector,
      ].sort(),
    );
  });

  it('[Tenant incorreto] na transação de B, nenhum detentor de A (nem o processo) aparece', async () => {
    expect(await holders(AUTORIDADE, TENANT_B)).toEqual([]);
    expect(await holders(AUTORIDADE_B, TENANT_B)).toEqual([]);
  });

  it('perfil sem nenhum detentor no escopo → ninguém', async () => {
    expect(await holders(id(999))).toEqual([]);
  });
});
