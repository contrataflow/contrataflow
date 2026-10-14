// US-078 — dataset e SQL do seed (RN-FND-18) e idempotência simulada com mocks
// (Gherkin "[Duplicidade]", V-05, "[Tenant incorreto]" no nível dos dados).
import { describe, expect, it } from 'vitest';

import type { AuthentikApi, AuthentikUser } from '../env/lib/authentik.js';
import type { CommandResult, Compose, ContainerStatus } from '../env/lib/compose.js';
import { memoryLogger } from '../env/lib/log.js';
import type { Psql } from '../env/lib/psql.js';
import { envSeed, SEED_REQUIRED_SERVICES } from '../env/lib/seed.js';
import {
  CATALOGS,
  DEPARTMENTS,
  PERSONA_DEPARTMENT,
  PERSONA_KEYS,
  personaScope,
  ROLE_TEMPLATES,
  seedId,
  seedUsers,
  TENANTS,
  WORKFLOWS,
  workflowTransitions,
} from '../env/seed/dataset.js';
import {
  buildSeedSql,
  countsSql,
  expectedCounts,
  schemaExistsSql,
  schemaSql,
  sqlLiteral,
  TENANT_TABLES,
  workflowDefinition,
  zeroCounts,
} from '../env/seed/sql.js';
import type { AuthentikIdentity, SeedTable } from '../env/seed/sql.js';
import { REPO_ROOT } from '../lib/workspace.js';

function identities(): Map<string, AuthentikIdentity> {
  return new Map(
    seedUsers().map((user, index) => [
      user.username,
      { pk: String(index + 1), uuid: seedId('ak', user.username) },
    ]),
  );
}

/** Dígitos verificadores do CNPJ (numérico). */
function validCnpj(cnpj: string): boolean {
  const digits = cnpj.split('').map(Number);
  const dv = (length: number) => {
    const weights =
      length === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const rest =
      weights.reduce((sum, weight, index) => sum + weight * (digits[index] ?? 0), 0) % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return cnpj.length === 14 && dv(12) === digits[12] && dv(13) === digits[13];
}

describe('dataset', () => {
  it('cria exatamente os tenants "Prefeitura A" e "Prefeitura B"', () => {
    expect(TENANTS.map((tenant) => tenant.name)).toEqual(['Prefeitura A', 'Prefeitura B']);
    expect(new Set(TENANTS.map((tenant) => tenant.slug)).size).toBe(2);
  });

  it('semeia os 15 perfis de DEC-035, com ADMIN_ORGAO protegido', () => {
    expect(ROLE_TEMPLATES.map((role) => role.key)).toEqual([...PERSONA_KEYS]);
    expect(PERSONA_KEYS).toHaveLength(15);
    expect(ROLE_TEMPLATES.filter((role) => role.isProtected).map((role) => role.key)).toEqual([
      'ADMIN_ORGAO',
    ]);
    expect(
      ROLE_TEMPLATES.filter((role) => role.allowExternalAssignment).map((role) => role.key),
    ).toEqual(['AUDITOR', 'CONSULTOR_EXTERNO']);
  });

  it('tem um usuário por persona em cada tenant, com login e e-mail únicos', () => {
    const users = seedUsers();
    expect(users).toHaveLength(30);
    expect(new Set(users.map((user) => user.username)).size).toBe(30);
    expect(new Set(users.map((user) => user.email)).size).toBe(30);
    expect(new Set(users.map((user) => user.id)).size).toBe(30);
    for (const tenant of TENANTS) {
      expect(users.filter((user) => user.tenant === tenant).map((user) => user.persona)).toEqual([
        ...PERSONA_KEYS,
      ]);
    }
  });

  it('[Tenant incorreto] Ana (REQUISITANTE) existe apenas na Prefeitura A', () => {
    const anas = seedUsers().filter((user) => user.name.startsWith('Ana '));
    expect(anas).toHaveLength(1);
    expect(anas[0]).toMatchObject({ username: 'requisitante.a', persona: 'REQUISITANTE' });
    expect(anas[0]?.tenant.name).toBe('Prefeitura A');
  });

  it('organizações com CNPJ fictício válido', () => {
    for (const tenant of TENANTS)
      expect(validCnpj(tenant.organization.cnpj), tenant.slug).toBe(true);
  });

  it('lotação e escopo de cada persona apontam para unidades existentes', () => {
    const keys = new Set(DEPARTMENTS.map((department) => department.key));
    for (const persona of PERSONA_KEYS)
      expect(keys.has(PERSONA_DEPARTMENT[persona]), persona).toBe(true);
    for (const department of DEPARTMENTS)
      if (department.parent) expect(keys.has(department.parent)).toBe(true);
    expect(personaScope('REQUISITANTE')).toBe('OWN_DEPARTMENTS');
    expect(personaScope('AUTORIDADE_COMPETENTE')).toBe('ORGANIZATION');
    expect(personaScope('COMPRAS')).toBe('TENANT');
  });

  it('catálogos de entities.md §7 com códigos únicos', () => {
    expect(Object.keys(CATALOGS)).toHaveLength(8);
    for (const [type, items] of Object.entries(CATALOGS)) {
      expect(new Set(items.map(([code]) => code)).size, type).toBe(items.length);
      for (const [code] of items) expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
    expect(CATALOGS.MODALITY.map(([code]) => code)).toContain('DISPENSA');
  });

  it('workflows de DEC-015: padrão com 7 etapas e contratação direta com 5', () => {
    const [preparatory, direct] = WORKFLOWS;
    expect(preparatory?.stages.map((stage) => stage.key)).toEqual([
      'ABERTURA',
      'APROVACAO_DFD',
      'ESTUDOS_PRELIMINARES',
      'PESQUISA_PRECOS',
      'TERMO_REFERENCIA',
      'APROVACAO_AUTORIDADE',
      'CONCLUSAO',
    ]);
    expect(preparatory?.stages.map((stage) => stage.slaDays ?? null)).toEqual([
      5,
      3,
      15,
      10,
      10,
      5,
      null,
    ]);
    expect(preparatory).toMatchObject({
      isDefault: true,
      applicabilityPriority: 100,
      applicabilityRule: null,
    });
    expect(direct).toMatchObject({
      key: 'DIRECT_CONTRACTING_ART72',
      isDefault: false,
      applicabilityPriority: 50,
    });
    expect(direct?.stages).toHaveLength(5);
    expect(WORKFLOWS.filter((workflow) => workflow.isDefault)).toHaveLength(1);
  });

  it('transições: avança em sequência, aprova nas etapas de aprovação e devolve para trás', () => {
    const [preparatory] = WORKFLOWS;
    if (!preparatory) throw new Error('sem workflow padrão');
    const transitions = workflowTransitions(preparatory);
    // A etapa de aprovação da autoridade leva direto à conclusão: a decisão (APPROVE) encerra.
    expect(
      transitions
        .filter((transition) => transition.isPrimary)
        .map((transition) => transition.action),
    ).toEqual(['FORWARD', 'APPROVE', 'FORWARD', 'FORWARD', 'FORWARD', 'APPROVE']);
    const [, direct] = WORKFLOWS;
    if (!direct) throw new Error('sem workflow de contratação direta');
    expect(
      workflowTransitions({
        ...direct,
        stages: direct.stages.filter((stage) => stage.type !== 'APPROVAL'),
      }).at(1),
    ).toMatchObject({ from: 'INSTRUCAO', to: 'CONCLUSAO', action: 'COMPLETE' });
    expect(
      transitions.filter(
        (transition) => transition.action === 'RETURN' && transition.from === 'PESQUISA_PRECOS',
      ),
    ).toHaveLength(3);
    expect(
      transitions.some(
        (transition) => transition.from === 'ABERTURA' && transition.action === 'RETURN',
      ),
    ).toBe(false);
  });

  it('seedId é determinístico, UUID v8 e distingue entradas', () => {
    expect(seedId('x', 'y')).toBe(seedId('x', 'y'));
    expect(seedId('x', 'y')).not.toBe(seedId('xy'));
    expect(seedId('a')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('SQL do seed', () => {
  it('sqlLiteral escapa aspas e serializa JSON, nulos, números e booleanos', () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(10)).toBe('10');
    expect(sqlLiteral(false)).toBe('false');
    expect(sqlLiteral({ json: { a: "it's" } })).toBe(`'{"a":"it''s"}'::jsonb`);
    expect(sqlLiteral({ raw: 'now()' })).toBe('now()');
    expect(() => sqlLiteral(Number.NaN)).toThrow();
  });

  it('é determinístico e idempotente (toda inserção com ON CONFLICT, schema com IF NOT EXISTS)', () => {
    const sql = buildSeedSql(identities());
    expect(buildSeedSql(identities())).toBe(sql);
    const inserts = sql.split('\n').filter((line) => line.startsWith('INSERT INTO'));
    expect(inserts.length).toBeGreaterThan(300);
    for (const statement of inserts) expect(statement).toMatch(/ON CONFLICT/);
    for (const line of schemaSql()
      .split('\n')
      .filter((item) => item.startsWith('CREATE TABLE'))) {
      expect(line).toContain('IF NOT EXISTS');
    }
  });

  it('serializa seeds concorrentes com trava consultiva e transação', () => {
    const sql = buildSeedSql(identities());
    expect(sql).toMatch(/^\\set ON_ERROR_STOP on\nSELECT pg_advisory_lock\(/);
    expect(sql).toContain('\nBEGIN;\n');
    expect(sql.trimEnd()).toMatch(/COMMIT;\nSELECT pg_advisory_unlock\(.*\);$/);
  });

  it('grava fora do schema public (DEC-065)', () => {
    const sql = buildSeedSql(identities());
    expect(sql).not.toMatch(/INTO public\.|TABLE IF NOT EXISTS public\./);
  });

  it.each(TENANT_TABLES)(
    'tabela %s com tenant_id, RLS ENABLE + FORCE e política de DEC-082',
    (table) => {
      const ddl = schemaSql();
      expect(ddl).toMatch(
        new RegExp(
          `CREATE TABLE IF NOT EXISTS dev_seed\\.${table} \\([^;]*tenant_id uuid NOT NULL`,
        ),
      );
      expect(ddl).toContain(`ALTER TABLE dev_seed.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(ddl).toContain(`ALTER TABLE dev_seed.${table} FORCE ROW LEVEL SECURITY;`);
      expect(ddl).toContain(
        `CREATE POLICY tenant_isolation ON dev_seed.${table} USING (tenant_id = current_setting('app.tenant_id')::uuid)`,
      );
    },
  );

  it('papel de leitura sem BYPASSRLS para provar o isolamento', () => {
    expect(schemaSql()).toContain('CREATE ROLE dev_seed_reader NOLOGIN NOBYPASSRLS;');
  });

  it('liga o sub do Authentik ao usuário (external_subject) e se corrige se o sub mudar', () => {
    const ids = identities();
    const sql = buildSeedSql(ids);
    const ana = seedUsers().find((user) => user.username === 'requisitante.a');
    expect(sql).toContain(`'${ids.get('requisitante.a')?.uuid ?? ''}'`);
    expect(sql).toContain(`'${ana?.id ?? ''}'`);
    expect(sql).toMatch(
      /ON CONFLICT \(id\) DO UPDATE SET external_subject = EXCLUDED\.external_subject/,
    );
  });

  it('falha se faltar a identidade de algum usuário no Authentik', () => {
    const ids = identities();
    ids.delete('auditor.b');
    expect(() => buildSeedSql(ids)).toThrow('usuário auditor.b ausente no Authentik');
  });

  it('hash da definição do workflow é estável e muda com o conteúdo', () => {
    const [workflow] = WORKFLOWS;
    if (!workflow) throw new Error('sem workflow');
    const { hash } = workflowDefinition(workflow);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(workflowDefinition(workflow).hash).toBe(hash);
    expect(workflowDefinition({ ...workflow, rules: [] }).hash).not.toBe(hash);
  });

  it('contagens esperadas batem com o dataset', () => {
    expect(expectedCounts()).toMatchObject({
      tenants: 2,
      users: 30,
      roles: 30,
      tenant_memberships: 30,
      workflows: 4,
      catalog_items: 2 * Object.values(CATALOGS).reduce((sum, items) => sum + items.length, 0),
    });
    expect(Object.values(zeroCounts()).every((count) => count === 0)).toBe(true);
    expect(countsSql()).toContain(
      "'workflow_versions', (SELECT count(*) FROM dev_seed.workflow_versions)",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// envSeed com mocks: banco simulado que aplica o seed uma vez só (como ON CONFLICT DO NOTHING).
// ---------------------------------------------------------------------------------------------

function fakeCompose(services: readonly string[]): Compose {
  const statuses: ContainerStatus[] = services.map((service) => ({
    service,
    state: service === 'minio-bootstrap' ? 'exited' : 'running',
    health: service === 'minio-bootstrap' ? '' : 'healthy',
    exitCode: 0,
    publishedPorts: [],
  }));
  const ps: CommandResult = {
    status: 0,
    stdout: statuses
      .map((status) =>
        JSON.stringify({
          Service: status.service,
          State: status.state,
          Health: status.health,
          ExitCode: 0,
        }),
      )
      .join('\n'),
    stderr: '',
  };
  return { root: REPO_ROOT, run: () => Promise.resolve(ps) };
}

function fakeDatabase(): { psql: Psql; seedRuns: () => number } {
  let counts: Record<SeedTable, number> | undefined;
  let runs = 0;
  const psql: Psql = (sql) => {
    if (sql === schemaExistsSql())
      return Promise.resolve({ ok: true, stdout: counts ? 't' : 'f', stderr: '' });
    if (sql === countsSql())
      return Promise.resolve({ ok: true, stdout: JSON.stringify(counts), stderr: '' });
    if (sql.includes('pg_advisory_lock')) {
      runs += 1;
      counts = expectedCounts();
      return Promise.resolve({ ok: true, stdout: '', stderr: '' });
    }
    return Promise.resolve({ ok: false, stdout: '', stderr: 'SQL inesperado' });
  };
  return { psql, seedRuns: () => runs };
}

function fakeAuthentik(users: () => AuthentikUser[]): AuthentikApi {
  return {
    baseUrl: 'http://localhost:9080',
    usersInPath: () => Promise.resolve(users()),
    blueprints: () => Promise.resolve([]),
  };
}

const allUsers = () =>
  seedUsers().map((user, index) => ({
    pk: index + 1,
    uuid: seedId('ak', user.username),
    username: user.username,
    isActive: true,
  }));

const noWait = { sleep: () => Promise.resolve(), intervalMs: 1 };

describe('envSeed', () => {
  it('[Duplicidade] reexecução mantém as contagens e avisa env.seed.skipped_existing', async () => {
    const database = fakeDatabase();
    const deps = {
      compose: fakeCompose(SEED_REQUIRED_SERVICES),
      psql: database.psql,
      authentik: fakeAuthentik(allUsers),
      ...noWait,
    };
    const firstLogger = memoryLogger();
    const first = await envSeed({ ...deps, logger: firstLogger });
    expect(first.skippedExisting).toBe(false);
    expect(first.created).toEqual(expectedCounts());
    expect(firstLogger.lines[0]).toMatch(/^✔ env\.seed\.completed/);

    const secondLogger = memoryLogger();
    const second = await envSeed({ ...deps, logger: secondLogger });
    expect(second.skippedExisting).toBe(true);
    expect(second.after).toEqual(first.after);
    expect(secondLogger.lines[0]).toMatch(/^⚠ env\.seed\.skipped_existing — .*nada foi recriado/);
    expect(secondLogger.lines.join('\n')).not.toMatch(/duplicate|duplicad/i);
  });

  it('[V-05] sem o ambiente de pé → ENV_NOT_READY sem tocar no banco', async () => {
    const database = fakeDatabase();
    await expect(
      envSeed({
        compose: fakeCompose(['postgres']),
        psql: database.psql,
        authentik: fakeAuthentik(allUsers),
        logger: memoryLogger(),
        ...noWait,
      }),
    ).rejects.toMatchObject({
      code: 'ENV_NOT_READY',
      message: expect.stringMatching(/^Suba o ambiente antes: pnpm env:up\./) as string,
    });
    expect(database.seedRuns()).toBe(0);
  });

  it('espera o blueprint criar os usuários e falha com env.bootstrap_failed no tempo limite', async () => {
    const logger = memoryLogger();
    let now = 0;
    await expect(
      envSeed({
        compose: fakeCompose(SEED_REQUIRED_SERVICES),
        psql: fakeDatabase().psql,
        authentik: fakeAuthentik(() => allUsers().slice(0, 10)),
        logger,
        usersTimeoutMs: 5000,
        intervalMs: 1000,
        now: () => now,
        sleep: (ms) => {
          now += ms;
          return Promise.resolve();
        },
      }),
    ).rejects.toMatchObject({ code: 'BOOTSTRAP_FAILED' });
    expect(logger.lines[0]).toMatch(
      /^✖ env\.bootstrap_failed — 20 usuário\(s\) do blueprint ausentes/,
    );
  });

  it('acusa contagens inconsistentes (dados alterados à mão)', async () => {
    const database = fakeDatabase();
    const psql: Psql = async (sql, options) => {
      const result = await database.psql(sql, options);
      return sql === countsSql()
        ? { ...result, stdout: JSON.stringify({ ...expectedCounts(), users: 31 }) }
        : result;
    };
    await expect(
      envSeed({
        compose: fakeCompose(SEED_REQUIRED_SERVICES),
        psql,
        authentik: fakeAuthentik(allUsers),
        logger: memoryLogger(),
        ...noWait,
      }),
    ).rejects.toMatchObject({ code: 'SEED_INCONSISTENT' });
  });
});
