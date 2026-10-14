// SQL do seed local (US-078 · RN-FND-18 · DEC-065). Gera um script psql idempotente:
// - schema provisório `dev_seed` (fora de `public`, que pertence às migrações do Prisma — US-081);
// - nomes de tabela/coluna de entities.md, `tenant_id` + FKs compostas (DEC-081) e RLS
//   ENABLE + FORCE com a política de DEC-082;
// - ids determinísticos + `ON CONFLICT DO NOTHING`: reexecutar não duplica nada;
// - trava consultiva: dois seeds simultâneos são serializados.
import { createHash } from 'node:crypto';

import {
  CATALOGS,
  DEPARTMENTS,
  PERSONA_DEPARTMENT,
  personaScope,
  ROLE_TEMPLATES,
  seedId,
  seedUsers,
  TENANT_SETTINGS,
  TENANTS,
  WORKFLOWS,
  workflowTransitions,
} from './dataset.js';
import type { CatalogType, DepartmentSeed, TenantSeed, WorkflowSeed } from './dataset.js';

export const SEED_SCHEMA = 'dev_seed';

/** Papel sem BYPASSRLS usado para provar o isolamento (o superusuário ignora RLS). */
export const SEED_READER_ROLE = 'dev_seed_reader';

/** Tabelas de plataforma (sem `tenant_id`, sem RLS — DEC-080). */
export const PLATFORM_TABLES = ['tenants', 'users'] as const;

/** Tabelas com `tenant_id`, RLS ENABLE + FORCE (DEC-082). */
export const TENANT_TABLES = [
  'organizations',
  'tenant_settings',
  'departments',
  'tenant_memberships',
  'membership_departments',
  'roles',
  'role_assignments',
  'catalog_items',
  'workflows',
  'workflow_versions',
] as const;

export type SeedTable = (typeof PLATFORM_TABLES)[number] | (typeof TENANT_TABLES)[number];

type SqlValue =
  string | number | boolean | null | { readonly json: unknown } | { readonly raw: string };

/** Literal SQL seguro (aspas duplicadas); JSON vira `'…'::jsonb`. */
export function sqlLiteral(value: SqlValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`número inválido no seed: ${value}`);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  if ('raw' in value) return value.raw;
  return `${sqlLiteral(JSON.stringify(value.json))}::jsonb`;
}

function insert(
  table: SeedTable,
  row: Readonly<Record<string, SqlValue>>,
  onConflict = 'ON CONFLICT DO NOTHING',
): string {
  const columns = Object.keys(row);
  const values = columns.map((column) => sqlLiteral(row[column] ?? null));
  return `INSERT INTO ${SEED_SCHEMA}.${table} (${columns.join(', ')}) VALUES (${values.join(', ')}) ${onConflict};`;
}

const NOW: SqlValue = { raw: 'now()' };

/** DDL idempotente do schema provisório. */
export function schemaSql(): string {
  const s = SEED_SCHEMA;
  const tenantFk = `tenant_id uuid NOT NULL REFERENCES ${s}.tenants (id)`;
  const audit = `created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()`;
  const ddl = [
    `CREATE SCHEMA IF NOT EXISTS ${s};`,
    `COMMENT ON SCHEMA ${s} IS 'Seed provisório do ambiente local (US-078 · DEC-065); substituído pelas tabelas reais na US-081.';`,
    `CREATE TABLE IF NOT EXISTS ${s}.tenants (
  id uuid PRIMARY KEY,
  slug varchar(63) NOT NULL UNIQUE,
  name varchar(200) NOT NULL,
  legal_name varchar(250),
  type varchar(30) NOT NULL,
  status varchar(20) NOT NULL,
  state_code char(2) NOT NULL,
  timezone varchar(64) NOT NULL DEFAULT 'America/Sao_Paulo',
  locale varchar(10) NOT NULL DEFAULT 'pt-BR',
  plan varchar(40) NOT NULL DEFAULT 'STANDARD',
  primary_organization_id uuid,
  activated_at timestamptz,
  ${audit},
  version int NOT NULL DEFAULT 1
);`,
    `CREATE TABLE IF NOT EXISTS ${s}.users (
  id uuid PRIMARY KEY,
  external_subject varchar(255) UNIQUE,
  authentik_user_id varchar(64) UNIQUE,
  email citext NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  name varchar(200) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'ACTIVE',
  is_platform_operator boolean NOT NULL DEFAULT false,
  preferences jsonb NOT NULL DEFAULT '{}',
  ${audit},
  version int NOT NULL DEFAULT 1
);`,
    `CREATE TABLE IF NOT EXISTS ${s}.organizations (
  id uuid PRIMARY KEY,
  ${tenantFk},
  name varchar(250) NOT NULL,
  short_name varchar(30) NOT NULL,
  cnpj varchar(14) NOT NULL,
  type varchar(30) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  email citext,
  metadata jsonb NOT NULL DEFAULT '{}',
  ${audit},
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, cnpj),
  UNIQUE (tenant_id, short_name)
);`,
    `CREATE TABLE IF NOT EXISTS ${s}.tenant_settings (
  id uuid PRIMARY KEY,
  ${tenantFk},
  key varchar(120) NOT NULL,
  value jsonb NOT NULL,
  ${audit},
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, key)
);`,
    `CREATE TABLE IF NOT EXISTS ${s}.departments (
  id uuid PRIMARY KEY,
  ${tenantFk},
  organization_id uuid NOT NULL,
  parent_id uuid,
  type varchar(20) NOT NULL,
  name varchar(200) NOT NULL,
  acronym varchar(30),
  path text NOT NULL,
  depth int NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  ${audit},
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES ${s}.organizations (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES ${s}.departments (tenant_id, id)
);`,
    `CREATE TABLE IF NOT EXISTS ${s}.tenant_memberships (
  id uuid PRIMARY KEY,
  ${tenantFk},
  user_id uuid NOT NULL REFERENCES ${s}.users (id),
  type varchar(20) NOT NULL DEFAULT 'INTERNAL',
  status varchar(20) NOT NULL DEFAULT 'INVITED',
  job_title varchar(150),
  activated_at timestamptz,
  expires_at timestamptz,
  ${audit},
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, user_id),
  CHECK (type <> 'EXTERNAL' OR expires_at IS NOT NULL)
);`,
    `CREATE TABLE IF NOT EXISTS ${s}.membership_departments (
  id uuid PRIMARY KEY,
  ${tenantFk},
  membership_id uuid NOT NULL,
  department_id uuid NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, membership_id, department_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES ${s}.tenant_memberships (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES ${s}.departments (tenant_id, id)
);`,
    `CREATE TABLE IF NOT EXISTS ${s}.roles (
  id uuid PRIMARY KEY,
  ${tenantFk},
  key varchar(60) NOT NULL,
  name varchar(120) NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  is_protected boolean NOT NULL DEFAULT false,
  allow_external_assignment boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  ${audit},
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, key)
);`,
    `CREATE TABLE IF NOT EXISTS ${s}.role_assignments (
  id uuid PRIMARY KEY,
  ${tenantFk},
  membership_id uuid NOT NULL,
  role_id uuid NOT NULL,
  scope_type varchar(20) NOT NULL,
  scope_organization_id uuid,
  scope_department_id uuid,
  include_subtree boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL DEFAULT now(),
  reason text,
  ${audit},
  version int NOT NULL DEFAULT 1,
  FOREIGN KEY (tenant_id, membership_id) REFERENCES ${s}.tenant_memberships (tenant_id, id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES ${s}.roles (tenant_id, id)
);`,
    `CREATE TABLE IF NOT EXISTS ${s}.catalog_items (
  id uuid PRIMARY KEY,
  ${tenantFk},
  catalog_type varchar(40) NOT NULL,
  code varchar(60) NOT NULL,
  label varchar(150) NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}',
  ${audit},
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, catalog_type, code)
);`,
    `CREATE TABLE IF NOT EXISTS ${s}.workflows (
  id uuid PRIMARY KEY,
  ${tenantFk},
  key varchar(60) NOT NULL,
  name varchar(150) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  applicability_rule jsonb,
  applicability_priority int NOT NULL DEFAULT 100,
  current_published_version_id uuid,
  ${audit},
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, key)
);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS workflows_one_default ON ${s}.workflows (tenant_id) WHERE is_default;`,
    `CREATE TABLE IF NOT EXISTS ${s}.workflow_versions (
  id uuid PRIMARY KEY,
  ${tenantFk},
  workflow_id uuid NOT NULL,
  version_number int NOT NULL,
  status varchar(20) NOT NULL,
  published_at timestamptz,
  definition_snapshot jsonb,
  definition_hash varchar(64),
  ${audit},
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, workflow_id, version_number),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES ${s}.workflows (tenant_id, id)
);`,
  ];

  const rls = TENANT_TABLES.flatMap((table) => [
    `ALTER TABLE ${s}.${table} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${s}.${table} FORCE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS tenant_isolation ON ${s}.${table};`,
    `CREATE POLICY tenant_isolation ON ${s}.${table} USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);`,
  ]);

  const reader = [
    `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SEED_READER_ROLE}') THEN
    CREATE ROLE ${SEED_READER_ROLE} NOLOGIN NOBYPASSRLS;
  END IF;
END $$;`,
    `GRANT USAGE ON SCHEMA ${s} TO ${SEED_READER_ROLE};`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${SEED_READER_ROLE};`,
  ];

  return [...ddl, ...rls, ...reader].join('\n');
}

/** Identidade do usuário no Authentik (`sub` = UUID do usuário — DEC-130). */
export interface AuthentikIdentity {
  readonly pk: string;
  readonly uuid: string;
}

function departmentPath(tenant: TenantSeed, department: DepartmentSeed): string {
  const chain: string[] = [];
  let current: DepartmentSeed | undefined = department;
  while (current) {
    chain.unshift(seedId(tenant.slug, 'department', current.key));
    const parentKey: string | undefined = current.parent;
    current = DEPARTMENTS.find((candidate) => candidate.key === parentKey);
  }
  return `/${chain.join('/')}/`;
}

/** Snapshot canônico (chaves ordenadas) e hash SHA-256 da definição (DEC-084). */
export function workflowDefinition(workflow: WorkflowSeed): { snapshot: unknown; hash: string } {
  const snapshot = {
    stages: workflow.stages.map((stage, index) => ({ ...stage, displayOrder: index + 1 })),
    transitions: workflowTransitions(workflow),
    rules: workflow.rules,
  };
  const canonical = JSON.stringify(snapshot, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
  return { snapshot, hash: createHash('sha256').update(canonical).digest('hex') };
}

function tenantSql(tenant: TenantSeed): string[] {
  const tenantId = seedId(tenant.slug, 'tenant');
  const organizationId = seedId(tenant.slug, 'organization');
  const statements: string[] = [];

  statements.push(
    insert('organizations', {
      id: organizationId,
      tenant_id: tenantId,
      name: tenant.organization.name,
      short_name: tenant.organization.shortName,
      cnpj: tenant.organization.cnpj,
      type: 'DIRECT_ADMINISTRATION',
      email: tenant.organization.email,
    }),
    `UPDATE ${SEED_SCHEMA}.tenants SET primary_organization_id = ${sqlLiteral(organizationId)} WHERE id = ${sqlLiteral(tenantId)} AND primary_organization_id IS DISTINCT FROM ${sqlLiteral(organizationId)};`,
  );

  for (const [key, value] of Object.entries(TENANT_SETTINGS)) {
    statements.push(
      insert('tenant_settings', {
        id: seedId(tenant.slug, 'setting', key),
        tenant_id: tenantId,
        key,
        value: { json: value },
      }),
    );
  }

  DEPARTMENTS.forEach((department, index) => {
    statements.push(
      insert('departments', {
        id: seedId(tenant.slug, 'department', department.key),
        tenant_id: tenantId,
        organization_id: organizationId,
        parent_id: department.parent ? seedId(tenant.slug, 'department', department.parent) : null,
        type: department.type,
        name: department.name,
        acronym: department.acronym,
        path: departmentPath(tenant, department),
        depth: department.parent ? 1 : 0,
        sort_order: index,
      }),
    );
  });

  for (const role of ROLE_TEMPLATES) {
    statements.push(
      insert('roles', {
        id: seedId(tenant.slug, 'role', role.key),
        tenant_id: tenantId,
        key: role.key,
        name: role.name,
        is_system: true,
        is_protected: role.isProtected,
        allow_external_assignment: role.allowExternalAssignment,
      }),
    );
  }

  for (const user of seedUsers().filter((candidate) => candidate.tenant === tenant)) {
    const membershipId = seedId(tenant.slug, 'membership', user.username);
    const external = user.persona === 'CONSULTOR_EXTERNO';
    const scope = personaScope(user.persona);
    statements.push(
      insert('tenant_memberships', {
        id: membershipId,
        tenant_id: tenantId,
        user_id: user.id,
        type: external ? 'EXTERNAL' : 'INTERNAL',
        status: 'ACTIVE',
        job_title: ROLE_TEMPLATES.find((role) => role.key === user.persona)?.name ?? null,
        activated_at: NOW,
        expires_at: external ? { raw: "now() + interval '180 days'" } : null,
      }),
      insert('membership_departments', {
        id: seedId(tenant.slug, 'membership-department', user.username),
        tenant_id: tenantId,
        membership_id: membershipId,
        department_id: seedId(tenant.slug, 'department', PERSONA_DEPARTMENT[user.persona]),
        is_primary: true,
      }),
      insert('role_assignments', {
        id: seedId(tenant.slug, 'role-assignment', user.username),
        tenant_id: tenantId,
        membership_id: membershipId,
        role_id: seedId(tenant.slug, 'role', user.persona),
        scope_type: scope,
        scope_organization_id: scope === 'ORGANIZATION' ? organizationId : null,
        reason: 'Seed do ambiente local (US-078)',
      }),
    );
  }

  for (const [catalogType, items] of Object.entries(CATALOGS) as [
    CatalogType,
    readonly (readonly [string, string])[],
  ][]) {
    items.forEach(([code, label], index) => {
      statements.push(
        insert('catalog_items', {
          id: seedId(tenant.slug, 'catalog', catalogType, code),
          tenant_id: tenantId,
          catalog_type: catalogType,
          code,
          label,
          is_system: true,
          sort_order: (index + 1) * 10,
        }),
      );
    });
  }

  for (const workflow of WORKFLOWS) {
    const workflowId = seedId(tenant.slug, 'workflow', workflow.key);
    const versionId = seedId(tenant.slug, 'workflow-version', workflow.key, '1');
    const { snapshot, hash } = workflowDefinition(workflow);
    statements.push(
      insert('workflows', {
        id: workflowId,
        tenant_id: tenantId,
        key: workflow.key,
        name: workflow.name,
        is_default: workflow.isDefault,
        applicability_rule: workflow.applicabilityRule
          ? { json: workflow.applicabilityRule }
          : null,
        applicability_priority: workflow.applicabilityPriority,
      }),
      insert('workflow_versions', {
        id: versionId,
        tenant_id: tenantId,
        workflow_id: workflowId,
        version_number: 1,
        status: 'PUBLISHED',
        published_at: NOW,
        definition_snapshot: { json: snapshot },
        definition_hash: hash,
      }),
      `UPDATE ${SEED_SCHEMA}.workflows SET current_published_version_id = ${sqlLiteral(versionId)} WHERE id = ${sqlLiteral(workflowId)} AND current_published_version_id IS DISTINCT FROM ${sqlLiteral(versionId)};`,
    );
  }

  return statements;
}

/**
 * Script psql completo. `identities` traz, por login, o usuário correspondente no Authentik; o
 * `sub` do token (UUID do usuário) vai para `users.external_subject` (DEC-130), o que liga o login
 * OIDC aos vínculos semeados.
 */
export function buildSeedSql(identities: ReadonlyMap<string, AuthentikIdentity>): string {
  const lock = `pg_advisory_lock(hashtext('contrataflow.dev_seed'))`;
  const statements: string[] = ['\\set ON_ERROR_STOP on', `SELECT ${lock};`, 'BEGIN;', schemaSql()];

  for (const tenant of TENANTS) {
    statements.push(
      insert('tenants', {
        id: seedId(tenant.slug, 'tenant'),
        slug: tenant.slug,
        name: tenant.name,
        legal_name: tenant.legalName,
        type: 'MUNICIPALITY',
        status: 'ACTIVE',
        state_code: tenant.stateCode,
        activated_at: NOW,
      }),
    );
  }

  for (const user of seedUsers()) {
    const identity = identities.get(user.username);
    if (!identity) throw new Error(`usuário ${user.username} ausente no Authentik`);
    statements.push(
      insert(
        'users',
        {
          id: user.id,
          external_subject: identity.uuid,
          authentik_user_id: identity.pk,
          email: user.email,
          email_verified: true,
          name: user.name,
        },
        // Autocorreção: se o volume do Authentik foi recriado, o `sub` muda e é atualizado aqui.
        `ON CONFLICT (id) DO UPDATE SET external_subject = EXCLUDED.external_subject, authentik_user_id = EXCLUDED.authentik_user_id, updated_at = now() WHERE ${SEED_SCHEMA}.users.external_subject IS DISTINCT FROM EXCLUDED.external_subject OR ${SEED_SCHEMA}.users.authentik_user_id IS DISTINCT FROM EXCLUDED.authentik_user_id`,
      ),
    );
  }

  for (const tenant of TENANTS) statements.push(...tenantSql(tenant));

  statements.push('COMMIT;', `SELECT pg_advisory_unlock(hashtext('contrataflow.dev_seed'));`);
  return `${statements.join('\n')}\n`;
}

/** `t` quando o schema do seed já existe por completo. */
export function schemaExistsSql(): string {
  return `SELECT to_regclass('${SEED_SCHEMA}.workflow_versions') IS NOT NULL;`;
}

/** Contagem por tabela em JSON (exige o schema — veja `schemaExistsSql`). */
export function countsSql(): string {
  const fields = [...PLATFORM_TABLES, ...TENANT_TABLES]
    .map((table) => `'${table}', (SELECT count(*) FROM ${SEED_SCHEMA}.${table})`)
    .join(', ');
  return `SELECT json_build_object(${fields})::text;`;
}

export function zeroCounts(): Record<SeedTable, number> {
  return Object.fromEntries(
    [...PLATFORM_TABLES, ...TENANT_TABLES].map((table) => [table, 0]),
  ) as Record<SeedTable, number>;
}

/** Quantidade de linhas que o dataset produz por tabela (para checar a idempotência). */
export function expectedCounts(): Record<SeedTable, number> {
  const users = seedUsers().length;
  const catalogItems = Object.values(CATALOGS).reduce((sum, items) => sum + items.length, 0);
  return {
    tenants: TENANTS.length,
    users,
    organizations: TENANTS.length,
    tenant_settings: TENANTS.length * Object.keys(TENANT_SETTINGS).length,
    departments: TENANTS.length * DEPARTMENTS.length,
    tenant_memberships: users,
    membership_departments: users,
    roles: TENANTS.length * ROLE_TEMPLATES.length,
    role_assignments: users,
    catalog_items: TENANTS.length * catalogItems,
    workflows: TENANTS.length * WORKFLOWS.length,
    workflow_versions: TENANTS.length * WORKFLOWS.length,
  };
}
