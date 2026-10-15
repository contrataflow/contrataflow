// Catálogo de permissões e perfis padrão contra PostgreSQL real (US-094): migração de sincronização
// do catálogo (validada contra `packages/types/src/permissions.ts`), seeder `access.defaultRoles`
// com o `PrismaRoleRepository` como `cf_app` (RLS) — idempotência (RN-IAM-76), rollback em falha
// (RN-IAM-77), concorrência — e as restrições do banco (FK do catálogo, imutabilidade da chave).
// `pnpm --filter @contrataflow/api test:integration`.
import { PERMISSIONS } from '@contrataflow/types';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SeedDefaultRolesHandler } from '#modules/access/application/seed-default-roles.handler.js';
import type { SeedDefaultRolesResult } from '#modules/access/application/seed-default-roles.handler.js';
import { DEFAULT_ROLES } from '#modules/access/domain/default-roles.js';
import { PrismaRoleRepository } from '#modules/access/infrastructure/prisma-role.repository.js';
import type { AuditEntry, AuditTrailPort } from '#shared/audit/audit-trail.js';
import { currentRequestContext, runAsSystem } from '#shared/context/request-context.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import type { TenantPrismaClient } from '#shared/database/prisma-client.js';

import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';

const A = '0192f000-0000-7000-8000-00000000094a';
const B = '0192f000-0000-7000-8000-00000000094b';
const C = '0192f000-0000-7000-8000-00000000094c';
const D = '0192f000-0000-7000-8000-00000000094d';
const E = '0192f000-0000-7000-8000-00000000094e';
const NOW = new Date('2026-10-15T12:00:00.000Z');
const TOTAL_GRANTS = DEFAULT_ROLES.reduce((sum, role) => sum + role.permissions.length, 0);

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${A}', 'sao-jose-094', 'Prefeitura de São José', 'MUNICIPALITY', 'PROVISIONING', 'SC'),
  ('${B}', 'retry-094', 'Prefeitura Retry', 'MUNICIPALITY', 'PROVISIONING', 'SC'),
  ('${C}', 'concorrente-094', 'Prefeitura Concorrente', 'MUNICIPALITY', 'PROVISIONING', 'SC'),
  ('${D}', 'falha-094', 'Prefeitura Falha', 'MUNICIPALITY', 'PROVISIONING', 'SC'),
  ('${E}', 'banco-094', 'Prefeitura Banco', 'MUNICIPALITY', 'PROVISIONING', 'SC');
`;

describe('catálogo de permissões e perfis padrão no PostgreSQL (US-094)', () => {
  let db: TestDatabase;
  let app: TenantPrismaClient;
  const repository = new PrismaRoleRepository();

  /** Auditoria de teste: registra o ator do contexto; `failAt` simula falha na N-ésima gravação. */
  function auditPort(options: { failAt?: number } = {}) {
    const recorded: { entry: AuditEntry; actorType: string | undefined }[] = [];
    const port = {
      record: (_tx: unknown, entry: AuditEntry) => {
        if (options.failAt !== undefined && recorded.length + 1 >= options.failAt) {
          return Promise.reject(new Error('falha induzida na auditoria'));
        }
        recorded.push({ entry, actorType: currentRequestContext()?.actor.type });
        return Promise.resolve({ kind: 'recorded', id: 'x', occurredAt: NOW, rowHash: 'h' });
      },
    } as unknown as AuditTrailPort;
    return { port, recorded };
  }

  /** O item "perfis padrão" do checklist (US-099): ator SYSTEM, transação do tenant. */
  const provision = (
    tenantId: string,
    handler: SeedDefaultRolesHandler,
  ): Promise<SeedDefaultRolesResult> =>
    runAsSystem({ name: 'Provisionamento do tenant', tenantId }, () =>
      app.$tenantTransaction((tx) => handler.execute(tx)),
    );

  const counts = async (tenantId: string) => {
    const [roles] = await db.admin<{ count: string }>(
      'SELECT count(*) FROM roles WHERE tenant_id = $1',
      [tenantId],
    );
    const [grants] = await db.admin<{ count: string }>(
      'SELECT count(*) FROM role_permissions WHERE tenant_id = $1',
      [tenantId],
    );
    return { roles: Number(roles?.count), grants: Number(grants?.count) };
  };

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    app = db.client('cf_app');
  });
  afterAll(async () => {
    await db.stop();
    vi.restoreAllMocks();
  });

  describe('migração do catálogo (RN-IAM-73)', () => {
    it('a tabela permissions tem exatamente o catálogo de packages/types, campo a campo', async () => {
      const rows = await db.admin<{
        code: string;
        module: string;
        name: string;
        description: string;
        risk_level: string;
        scopable: boolean;
        is_deprecated: boolean;
        introduced_in: string;
      }>(
        'SELECT code, module, name, description, risk_level, scopable, is_deprecated, introduced_in FROM permissions ORDER BY code',
      );
      const expected = [...PERMISSIONS]
        .sort((a, b) => (a.code < b.code ? -1 : 1))
        .map((permission) => ({
          code: permission.code,
          module: permission.module,
          name: permission.name,
          description: permission.description,
          risk_level: permission.riskLevel,
          scopable: permission.scopable,
          is_deprecated: permission.isDeprecated,
          introduced_in: permission.introducedIn,
        }));
      expect(rows).toHaveLength(68);
      expect(rows).toEqual(expected);
    });

    it('a aplicação só lê o catálogo (sem INSERT/DELETE)', async () => {
      await expect(
        app.$platformTransaction((tx) => tx.$executeRaw`DELETE FROM permissions`),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('seeder access.defaultRoles', () => {
    it('[Sucesso] 15 perfis isSystem, flags de §3.1, matriz §3.2 e auditoria SYSTEM por perfil', async () => {
      const audit = auditPort();
      const handler = new SeedDefaultRolesHandler(repository, () => NOW, audit.port);

      expect(await provision(A, handler)).toEqual({
        rolesCreated: 15,
        permissionsGranted: TOTAL_GRANTS,
      });

      const roles = await db.admin<{
        key: string;
        is_system: boolean;
        is_protected: boolean;
        allow_external_assignment: boolean;
        is_active: boolean;
        created_by_id: string | null;
      }>(
        'SELECT key, is_system, is_protected, allow_external_assignment, is_active, created_by_id FROM roles WHERE tenant_id = $1',
        [A],
      );
      expect(roles).toHaveLength(15);
      expect(roles.every((role) => role.is_system && role.is_active)).toBe(true);
      expect(roles.every((role) => role.created_by_id === null)).toBe(true);
      expect(roles.filter((role) => role.is_protected).map((role) => role.key)).toEqual([
        'ADMIN_ORGAO',
      ]);
      expect(
        roles
          .filter((role) => role.allow_external_assignment)
          .map((role) => role.key)
          .sort(),
      ).toEqual(['AUDITOR', 'CONSULTOR_EXTERNO']);
      expect(roles.filter((role) => !role.allow_external_assignment)).toHaveLength(13);

      const grants = await db.admin<{ key: string; permission_code: string }>(
        `SELECT r.key, rp.permission_code FROM role_permissions rp
           JOIN roles r ON r.tenant_id = rp.tenant_id AND r.id = rp.role_id
          WHERE rp.tenant_id = $1`,
        [A],
      );
      for (const definition of DEFAULT_ROLES) {
        expect(
          grants
            .filter((grant) => grant.key === definition.key)
            .map((grant) => grant.permission_code)
            .sort(),
          definition.key,
        ).toEqual([...definition.permissions].sort());
      }

      expect(audit.recorded).toHaveLength(15);
      expect(audit.recorded.every((r) => r.entry.action === 'role.create')).toBe(true);
      expect(audit.recorded.every((r) => r.actorType === 'SYSTEM')).toBe(true);
    });

    it('[Duplicidade] reexecução não duplica perfis nem concessões e não toca em updated_at', async () => {
      const first = new SeedDefaultRolesHandler(repository, () => NOW, auditPort().port);
      await provision(B, first);
      const before = await db.admin<{ id: string; updated_at: Date; version: number }>(
        'SELECT id, updated_at, version FROM roles WHERE tenant_id = $1 ORDER BY id',
        [B],
      );

      const audit = auditPort();
      const later = new Date('2026-10-16T12:00:00.000Z');
      const retry = new SeedDefaultRolesHandler(repository, () => later, audit.port);
      expect(await provision(B, retry)).toEqual({ rolesCreated: 0, permissionsGranted: 0 });

      expect(await counts(B)).toEqual({ roles: 15, grants: TOTAL_GRANTS });
      expect(
        await db.admin(
          'SELECT id, updated_at, version FROM roles WHERE tenant_id = $1 ORDER BY id',
          [B],
        ),
      ).toEqual(before);
      expect(audit.recorded).toHaveLength(0);
    });

    it('[Concorrência] duas execuções simultâneas: uma cria os 15 perfis, a outra conclui sem erro e sem duplicar', async () => {
      const audits = [auditPort(), auditPort()];
      const results = await Promise.all(
        audits.map((audit) =>
          provision(C, new SeedDefaultRolesHandler(repository, () => NOW, audit.port)),
        ),
      );

      expect(results.map((result) => result.rolesCreated).sort()).toEqual([0, 15]);
      expect(results.reduce((sum, result) => sum + result.permissionsGranted, 0)).toBe(
        TOTAL_GRANTS,
      );
      expect(await counts(C)).toEqual({ roles: 15, grants: TOTAL_GRANTS });
      expect(audits.reduce((sum, audit) => sum + audit.recorded.length, 0)).toBe(15);
    });

    it('falha no meio da semeadura desfaz perfis e concessões já inseridos (RN-IAM-77)', async () => {
      const handler = new SeedDefaultRolesHandler(
        repository,
        () => NOW,
        auditPort({ failAt: 3 }).port,
      );
      await expect(provision(D, handler)).rejects.toThrow('falha induzida');
      expect(await counts(D)).toEqual({ roles: 0, grants: 0 });

      // O item segue pendente: a nova tentativa semeia tudo.
      const retry = new SeedDefaultRolesHandler(repository, () => NOW, auditPort().port);
      expect(await provision(D, retry)).toMatchObject({ rolesCreated: 15 });
      expect(await counts(D)).toEqual({ roles: 15, grants: TOTAL_GRANTS });
    });

    it('[Falha de banco] banco indisponível durante a semeadura: nada é persistido', async () => {
      const failing = Object.assign(new PrismaRoleRepository(), {
        insertMissingGrants: () =>
          Promise.reject(new DatabaseUnavailableError(new Error('connection terminated'))),
      });
      const handler = new SeedDefaultRolesHandler(failing, () => NOW, auditPort().port);
      await expect(provision(E, handler)).rejects.toMatchObject({
        code: 'DEPENDENCY_UNAVAILABLE',
      });
      expect(await counts(E)).toEqual({ roles: 0, grants: 0 });
    });
  });

  describe('restrições do banco', () => {
    it('código do catálogo em uso não pode ser removido (FK de role_permissions)', async () => {
      await expect(db.admin(`DELETE FROM permissions WHERE code = 'ROLE_VIEW'`)).rejects.toThrow(
        /role_permissions_permission_code_fkey/,
      );
    });

    it('concessão a código fora do catálogo é recusada pela FK', async () => {
      const [role] = await db.admin<{ id: string }>(
        `SELECT id FROM roles WHERE tenant_id = $1 AND key = 'AUDITOR'`,
        [A],
      );
      await expect(
        db.admin(
          `INSERT INTO role_permissions (id, tenant_id, role_id, permission_code)
           VALUES (gen_random_uuid(), $1, $2, 'ROLE_DESTROY')`,
          [A, role?.id],
        ),
      ).rejects.toThrow(/role_permissions_permission_code_fkey/);
    });

    it('key, tenant_id e is_system do perfil são imutáveis; nome é único sem diferenciar maiúsculas', async () => {
      await expect(
        db.admin(`UPDATE roles SET key = 'OUTRA' WHERE tenant_id = $1 AND key = 'AUDITOR'`, [A]),
      ).rejects.toThrow(/imutáveis/);
      await expect(
        db.admin(
          `INSERT INTO roles (id, tenant_id, key, name) VALUES (gen_random_uuid(), $1, 'AUDITOR_2', 'AUDITOR')`,
          [A],
        ),
      ).rejects.toThrow(/roles_tenant_id_lower_name_key/);
    });
  });
});
