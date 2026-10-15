import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuditEntry, AuditTrailPort } from '#shared/audit/audit-trail.js';
import { currentRequestContext, runAsSystem } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';

import { SeedDefaultRolesHandler } from './seed-default-roles.handler.js';
import { DEFAULT_ROLES } from '../domain/default-roles.js';
import type { DefaultRoleDefinition } from '../domain/default-roles.js';
import { UnknownPermissionError } from '../domain/role.js';
import { InMemoryRoleRepository } from '../infrastructure/in-memory-role.repository.js';

const TENANT = '0192f000-0000-7000-8000-000000000942';
const NOW = new Date('2026-10-15T12:00:00.000Z');
const TOTAL_GRANTS = DEFAULT_ROLES.reduce((sum, role) => sum + role.permissions.length, 0);

interface RecordedAudit {
  readonly entry: AuditEntry;
  readonly actorType: string | undefined;
}

function setup() {
  const repository = new InMemoryRoleRepository();
  const audits: RecordedAudit[] = [];
  const audit = {
    record: (_tx: unknown, entry: AuditEntry) => {
      audits.push({ entry, actorType: currentRequestContext()?.actor.type });
      return Promise.resolve({ kind: 'recorded', id: 'a', occurredAt: NOW, rowHash: 'h' });
    },
  } as unknown as AuditTrailPort;
  const handler = new SeedDefaultRolesHandler(repository, () => NOW, audit);
  const seed = (definitions?: readonly DefaultRoleDefinition[]) =>
    runAsSystem({ name: 'Provisionamento do tenant', tenantId: TENANT }, () =>
      runSimulatedTransaction((tx) =>
        handler.execute(tx, definitions ? { definitions } : undefined),
      ),
    );
  return { repository, audits, handler, seed };
}

describe('SeedDefaultRolesHandler — seeder access.defaultRoles (US-094)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('[Sucesso] semeia os 15 perfis, a matriz completa e audita role.create (SYSTEM) por perfil', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { repository, audits, seed } = setup();

    expect(await seed()).toEqual({ rolesCreated: 15, permissionsGranted: TOTAL_GRANTS });

    const roles = repository.rolesOfTenant(TENANT);
    expect(roles).toHaveLength(15);
    expect(roles.every((role) => role.isSystem && role.isActive)).toBe(true);
    expect(repository.grantsOfTenant(TENANT)).toHaveLength(TOTAL_GRANTS);

    expect(audits).toHaveLength(15);
    const admin = roles.find((role) => role.key === 'ADMIN_ORGAO');
    const adminAudit = audits.find((audit) => audit.entry.entityId === admin?.id);
    expect(adminAudit).toMatchObject({
      actorType: 'SYSTEM',
      entry: {
        action: 'role.create',
        entityType: 'Role',
        metadata: { key: 'ADMIN_ORGAO', isSystem: true, seeded: true },
      },
    });
    expect(adminAudit?.entry.metadata?.permissionsGranted).toHaveLength(26);
    expect(audits.every((audit) => audit.actorType === 'SYSTEM')).toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'access.default_roles_seeded',
        tenantId: TENANT,
        rolesCreated: 15,
        permissionsGranted: TOTAL_GRANTS,
        durationMs: expect.any(Number) as number,
      }),
      'access.default_roles_seeded',
    );
  });

  it('[Duplicidade] reexecução não cria perfis, concessões nem auditoria (FA-01 · RN-IAM-76)', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { repository, audits, seed } = setup();
    await seed();
    const before = repository.rolesOfTenant(TENANT).map((role) => ({ ...role }));

    expect(await seed()).toEqual({ rolesCreated: 0, permissionsGranted: 0 });
    expect(repository.rolesOfTenant(TENANT)).toEqual(before);
    expect(repository.grantsOfTenant(TENANT)).toHaveLength(TOTAL_GRANTS);
    expect(audits).toHaveLength(15);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'access.default_roles_seed_retry', rolesCreated: 0 }),
      'access.default_roles_seed_retry',
    );
  });

  it('reexecução completa concessões que faltam sem remover nenhuma', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { repository, seed } = setup();
    const partial = DEFAULT_ROLES.map((role) => ({
      ...role,
      permissions: role.permissions.slice(0, 1),
    }));
    expect(await seed(partial)).toEqual({ rolesCreated: 15, permissionsGranted: 15 });
    expect(await seed()).toEqual({ rolesCreated: 0, permissionsGranted: TOTAL_GRANTS - 15 });
    expect(repository.grantsOfTenant(TENANT)).toHaveLength(TOTAL_GRANTS);
  });

  it('[Validação] perfil com permissão fora do catálogo falha com REFERENCE_NOT_FOUND (V-02)', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { seed } = setup();
    const broken = [
      { ...DEFAULT_ROLES[0], permissions: ['ROLE_DESTROY'] },
    ] as unknown as readonly DefaultRoleDefinition[];

    await expect(seed(broken)).rejects.toBeInstanceOf(UnknownPermissionError);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'access.default_roles_seed_failed',
        errorCode: 'REFERENCE_NOT_FOUND',
        tenantId: TENANT,
      }),
      'access.default_roles_seed_failed',
    );
  });

  it('[Falha de banco] erro do banco sobe ao chamador (o tx do checklist desfaz tudo) com log de erro', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { repository, seed } = setup();
    vi.spyOn(repository, 'insertMissingGrants').mockRejectedValue(
      new DatabaseUnavailableError(new Error('connection refused')),
    );

    await expect(seed()).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'DEPENDENCY_UNAVAILABLE' }),
      'access.default_roles_seed_failed',
    );
  });

  it('sem tenant no contexto não toca no banco', async () => {
    const { handler, repository } = setup();
    const insert = vi.spyOn(repository, 'insertMissing');
    await expect(
      runAsSystem({ name: 'job de plataforma', tenantId: null }, () =>
        runSimulatedTransaction((tx) => handler.execute(tx)),
      ),
    ).rejects.toThrow('tenant do contexto');
    expect(insert).not.toHaveBeenCalled();
  });
});
