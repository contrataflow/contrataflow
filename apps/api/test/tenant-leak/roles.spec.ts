// Perfis e matriz de permissões por tenant (US-094 · suíte "tenant leak"): com os perfis padrão
// semeados em A e B, a transação de um tenant só enxerga, grava e conta os próprios `roles` e
// `role_permissions` (RLS + extensão de isolamento); o catálogo `permissions` é global e idêntico
// para os dois. ROL-01 por HTTP (vínculo de outro tenant → 403 MEMBERSHIP_INACTIVE) está em
// `access/presentation/permission.routes.spec.ts`. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SeedDefaultRolesHandler } from '#modules/access/application/seed-default-roles.handler.js';
import { DEFAULT_ROLES, seedDefaultRoles } from '#modules/access/domain/default-roles.js';
import { PrismaRoleRepository } from '#modules/access/infrastructure/prisma-role.repository.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { runAsSystem } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantPrismaClient } from '#shared/database/prisma-client.js';
import { TenantIsolationViolationError } from '#shared/tenancy/isolation.js';

import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';

const A = '0192c000-0000-7000-8000-00000000094a';
const B = '0192c000-0000-7000-8000-00000000094b';
const NOW = new Date('2026-10-15T12:00:00.000Z');
const TOTAL_GRANTS = DEFAULT_ROLES.reduce((sum, role) => sum + role.permissions.length, 0);

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${A}', 'prefeitura-a-rol', 'Prefeitura A LEAK-A', 'MUNICIPALITY', 'ACTIVE', 'SC'),
  ('${B}', 'prefeitura-b-rol', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC');
`;

const audit = {
  record: () => Promise.resolve({ kind: 'recorded', id: 'x', occurredAt: NOW, rowHash: 'h' }),
} as unknown as AuditTrailPort;

describe('Feature: perfis padrão isolados por tenant (US-094 · tenant leak)', () => {
  let db: TestDatabase;
  let app: TenantPrismaClient;
  const repository = new PrismaRoleRepository();
  const handler = new SeedDefaultRolesHandler(repository, () => NOW, audit);

  const inTenant = <T>(
    tenantId: string,
    work: Parameters<TenantPrismaClient['$tenantTransaction']>[0],
  ): Promise<T> =>
    runAsSystem({ name: 'teste', tenantId }, () => app.$tenantTransaction(work) as Promise<T>);

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    app = db.client('cf_app');
    await inTenant(A, (tx) => handler.execute(tx));
    await inTenant(B, (tx) => handler.execute(tx));
  });
  afterAll(async () => {
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Tenant incorreto] cada tenant só enxerga os próprios 15 perfis e a própria matriz', async () => {
    for (const tenantId of [A, B]) {
      const roles = await inTenant<{ tenantId: string }[]>(tenantId, (tx) => tx.role.findMany());
      expect(roles).toHaveLength(15);
      expect(roles.every((role) => role.tenantId === tenantId)).toBe(true);
      const grants = await inTenant<number>(tenantId, (tx) => tx.rolePermission.count());
      expect(grants).toBe(TOTAL_GRANTS);
    }
    const [total] = await db.admin<{ count: string }>('SELECT count(*) FROM roles');
    expect(Number(total?.count)).toBe(30);
  });

  it('[Tenant incorreto] perfil de B não é encontrado pelo id na transação de A', async () => {
    const [roleOfB] = await db.admin<{ id: string }>(
      `SELECT id FROM roles WHERE tenant_id = $1 AND key = 'ADMIN_ORGAO'`,
      [B],
    );
    const found = await inTenant(A, (tx) =>
      tx.role.findFirst({ where: { id: roleOfB?.id ?? '' } }),
    );
    expect(found).toBeNull();
    const grants = await inTenant<number>(A, (tx) =>
      tx.rolePermission.count({ where: { roleId: roleOfB?.id ?? '' } }),
    );
    expect(grants).toBe(0);
  });

  it('[Tenant incorreto] semear perfis de B na transação de A é recusado', async () => {
    const rolesOfB = seedDefaultRoles(B, NOW, newId).map((seeded) => seeded.role);
    await expect(inTenant(A, (tx) => repository.insertMissing(tx, rolesOfB))).rejects.toThrow(
      TenantIsolationViolationError,
    );
    const [total] = await db.admin<{ count: string }>(
      'SELECT count(*) FROM roles WHERE tenant_id = $1',
      [B],
    );
    expect(Number(total?.count)).toBe(15);
  });

  it('o catálogo de permissões é global: idêntico nas transações de A e de B', async () => {
    const read = (tenantId: string) =>
      inTenant<{ code: string }[]>(tenantId, (tx) =>
        tx.permission.findMany({ orderBy: { code: 'asc' } }),
      );
    const [ofA, ofB] = await Promise.all([read(A), read(B)]);
    expect(ofA).toHaveLength(69);
    expect(ofA).toEqual(ofB);
  });
});
