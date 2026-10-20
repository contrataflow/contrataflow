import { readFileSync } from 'node:fs';

import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TenantContextMissingError, TenantIsolationViolationError } from './errors.js';
import { isolateOperation, scopeTenantArgs } from './tenant-isolation.extension.js';
import {
  isPlatformModel,
  isTenantScopedModel,
  modelsFromSchema,
  PLATFORM_MODELS,
  TENANT_SCOPED_MODELS,
} from './tenant-models.js';
import { runInTransactionScope } from './transaction-scope.js';
import type { TransactionScope } from './transaction-scope.js';

const A = '0192a000-0000-7000-8000-00000000000a';
const B = '0192a000-0000-7000-8000-00000000000b';

const inScope = <T>(scope: TransactionScope, fn: () => T): Promise<T> =>
  runInTransactionScope(scope, () => Promise.resolve(fn()));
const inTenant = <T>(fn: () => T) => inScope({ kind: 'TENANT', tenantId: A }, fn);

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TENANT_SCOPED_MODELS (RN-TEN-24)', () => {
  it('a lista versionada é exatamente a dos modelos com tenantId no schema Prisma', () => {
    const schema = readFileSync(new URL('../../../prisma/schema.prisma', import.meta.url), 'utf8');
    const models = modelsFromSchema(schema);
    expect(models.tenantScoped).toEqual([...TENANT_SCOPED_MODELS].sort());
    // Sem tenantId só a lista fechada de plataforma (DEC-080).
    expect(models.withoutTenant).toEqual([...PLATFORM_MODELS].sort());
  });

  it('separa modelos com e sem tenantId', () => {
    const schema = `
model Process {
  id       String @id
  tenantId String @map("tenant_id")
}

model Permission {
  id  String @id
  key String
}
`;
    expect(modelsFromSchema(schema)).toEqual({
      tenantScoped: ['Process'],
      withoutTenant: ['Permission'],
    });
    expect(isTenantScopedModel('TenantMembership')).toBe(true);
    expect(isPlatformModel('User')).toBe(true);
    expect(isTenantScopedModel('User')).toBe(false);
  });
});

describe('extensão tenant-isolation (RN-TEN-23)', () => {
  it('create/createMany/createManyAndReturn recebem o tenant da transação', async () => {
    await inTenant(() => {
      expect(isolateOperation('TenantMembership', 'create', { data: { userId: 'u' } })).toEqual({
        data: { userId: 'u', tenantId: A },
      });
      expect(
        isolateOperation('MembershipDepartment', 'createMany', {
          data: [{ membershipId: 'm1' }, { membershipId: 'm2', tenantId: A }],
          skipDuplicates: true,
        }),
      ).toEqual({
        data: [
          { membershipId: 'm1', tenantId: A },
          { membershipId: 'm2', tenantId: A },
        ],
        skipDuplicates: true,
      });
      expect(
        isolateOperation('OutboxEvent', 'createManyAndReturn', { data: { eventType: 'X' } }),
      ).toEqual({ data: { eventType: 'X', tenantId: A } });
    });
  });

  it.each([
    'findUnique',
    'findUniqueOrThrow',
    'findFirst',
    'findFirstOrThrow',
    'findMany',
    'count',
    'aggregate',
    'groupBy',
    'delete',
    'deleteMany',
  ])('%s recebe tenantId no where', async (operation) => {
    const args = await inTenant(() =>
      isolateOperation('TenantMembership', operation, { where: { id: 'm1' } }),
    );
    expect(args).toEqual({ where: { id: 'm1', tenantId: A } });
    const empty = await inTenant(() => isolateOperation('TenantMembership', operation, undefined));
    expect(empty).toEqual({ where: { tenantId: A } });
  });

  it('update/updateMany/updateManyAndReturn filtram pelo tenant e não mudam o tenantId', async () => {
    await inTenant(() => {
      for (const operation of ['update', 'updateMany', 'updateManyAndReturn']) {
        expect(
          isolateOperation('TenantMembership', operation, {
            where: { id: 'm1' },
            data: { status: 'ACTIVE' },
          }),
        ).toEqual({ where: { id: 'm1', tenantId: A }, data: { status: 'ACTIVE' } });
        expect(() =>
          isolateOperation('TenantMembership', operation, {
            where: { id: 'm1' },
            data: { tenantId: B },
          }),
        ).toThrow(TenantIsolationViolationError);
      }
    });
  });

  it('upsert: where e create com o tenant; update não troca o tenant', async () => {
    await inTenant(() => {
      expect(
        isolateOperation('TenantMembership', 'upsert', {
          where: { id: 'm1' },
          create: { userId: 'u' },
          update: { status: 'ACTIVE' },
        }),
      ).toEqual({
        where: { id: 'm1', tenantId: A },
        create: { userId: 'u', tenantId: A },
        update: { status: 'ACTIVE' },
      });
      expect(() =>
        isolateOperation('TenantMembership', 'upsert', {
          where: { id: 'm1' },
          create: { userId: 'u', tenantId: B },
          update: {},
        }),
      ).toThrow(TenantIsolationViolationError);
      expect(() =>
        isolateOperation('TenantMembership', 'upsert', {
          where: { id: 'm1' },
          create: {},
          update: { tenantId: B },
        }),
      ).toThrow(TenantIsolationViolationError);
    });
  });

  it('[Tenant incorreto] tenantId divergente nos dados ou no filtro → violação com log e métrica', async () => {
    await inTenant(() => {
      expect(() =>
        isolateOperation('TenantMembership', 'create', { data: { tenantId: B } }),
      ).toThrow(TenantIsolationViolationError);
      expect(() => isolateOperation('OutboxEvent', 'create', { data: { tenantId: null } })).toThrow(
        TenantIsolationViolationError,
      );
      expect(() =>
        isolateOperation('TenantMembership', 'findMany', { where: { tenantId: B } }),
      ).toThrow(TenantIsolationViolationError);
      expect(() =>
        isolateOperation('TenantMembership', 'findMany', { where: { tenantId: { in: [A, B] } } }),
      ).toThrow(TenantIsolationViolationError);
    });
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security.tenant_isolation_violation',
        barrier: 'prisma_extension',
        reason: 'tenant_id_mismatch_in_data',
        model: 'TenantMembership',
        operation: 'create',
      }),
      'security.tenant_isolation_violation',
    );
  });

  it('[Validação] modelo de tenant sem transação TENANT → TenantContextMissing antes do banco', async () => {
    expect(() => isolateOperation('TenantMembership', 'findMany', {})).toThrow(
      TenantContextMissingError,
    );
    await inScope({ kind: 'PLATFORM', tenantId: null }, () => {
      expect(() => isolateOperation('TenantMembership', 'findMany', {})).toThrow(
        TenantContextMissingError,
      );
    });
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security.tenant_context_missing',
        barrier: 'prisma_extension',
        model: 'TenantMembership',
        operation: 'findMany',
      }),
      'security.tenant_context_missing',
    );
  });

  it('SQL bruto só dentro de transação (FA-04); modelos de plataforma passam sem injeção', async () => {
    expect(() => isolateOperation(undefined, '$queryRaw', ['SELECT 1'])).toThrow(
      TenantContextMissingError,
    );
    await inTenant(() => {
      expect(isolateOperation(undefined, '$executeRaw', ['SELECT 1'])).toEqual(['SELECT 1']);
    });
    await inScope({ kind: 'PLATFORM', tenantId: null }, () => {
      expect(isolateOperation(undefined, '$queryRaw', ['SELECT 1'])).toEqual(['SELECT 1']);
      expect(isolateOperation('User', 'findMany', { where: { id: 'u' } })).toEqual({
        where: { id: 'u' },
      });
    });
    expect(isolateOperation('Tenant', 'findUnique', { where: { id: A } })).toEqual({
      where: { id: A },
    });
  });

  it('modelo fora das listas e operação não classificada falham fechadas', async () => {
    await inTenant(() => {
      expect(() => isolateOperation('ModeloDesconhecido', 'findMany', {})).toThrow(
        TenantIsolationViolationError,
      );
    });
    expect(() => scopeTenantArgs('TenantMembership', 'findRaw', {}, A)).toThrow(
      TenantIsolationViolationError,
    );
  });
});
