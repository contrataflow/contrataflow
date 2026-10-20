import { Prisma } from './generated/prisma/client.js';
import { isPlatformModel, isTenantScopedModel } from './tenant-models.js';
import { currentTransactionScope } from './transaction-scope.js';
import { tenantContextMissing, tenantIsolationViolation } from '../tenancy/isolation.js';

/*
 * Barreira 2 de isolamento (US-100 · RN-TEN-23 · multi-tenancy.md §5.1): extensão do cliente Prisma
 * aplicada ANTES da `TenantTransaction` — todo `tx` entregue aos repositórios passa por ela.
 * - Modelos de `TENANT_SCOPED_MODELS`: exigem transação `TENANT`; `create`/`createMany`/`upsert`
 *   recebem o `tenantId` da transação (valor diferente informado → violação); leituras,
 *   atualizações e exclusões recebem `tenantId` no `where` (filtro divergente → violação); mudar o
 *   `tenantId` num `update` → violação.
 * - Modelos de plataforma (`Tenant`, `User`): sem injeção (acesso restrito por dependency-cruiser).
 * - Modelo fora das duas listas: falha fechada (o meta-teste de `tenant-models.ts` já barra no CI).
 * - SQL bruto (`$queryRaw`/`$executeRaw`): só dentro de uma transação (FA-04); continua sob RLS.
 * Escritas aninhadas (`create` dentro de `create`) não recebem injeção: use escalares compostos
 * (`tenantId` + FK) — a RLS (`WITH CHECK`) e as FKs compostas barram qualquer escape.
 */

/** Operações que recebem `tenantId` nos dados. */
const CREATE_OPERATIONS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
]);

/** Operações que recebem `tenantId` no `where`. */
const WHERE_OPERATIONS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
]);

/** Operações cujo `data` não pode mudar o tenant. */
const UPDATE_OPERATIONS: ReadonlySet<string> = new Set([
  'update',
  'updateMany',
  'updateManyAndReturn',
]);

type Args = Record<string, unknown>;

function asRecord(value: unknown): Args {
  return typeof value === 'object' && value !== null ? (value as Args) : {};
}

function withTenant(data: unknown, tenantId: string, model: string, operation: string): Args {
  const record = asRecord(data);
  if ('tenantId' in record && record.tenantId !== tenantId) {
    throw tenantIsolationViolation('prisma_extension', 'tenant_id_mismatch_in_data', {
      model,
      operation,
    });
  }
  return { ...record, tenantId };
}

function scopedWhere(where: unknown, tenantId: string, model: string, operation: string): Args {
  const record = asRecord(where);
  if ('tenantId' in record && record.tenantId !== tenantId) {
    throw tenantIsolationViolation('prisma_extension', 'tenant_id_mismatch_in_filter', {
      model,
      operation,
    });
  }
  return { ...record, tenantId };
}

function assertUnchangedTenant(
  data: unknown,
  tenantId: string,
  model: string,
  operation: string,
): void {
  const record = asRecord(data);
  if ('tenantId' in record && record.tenantId !== tenantId) {
    throw tenantIsolationViolation('prisma_extension', 'tenant_id_change', { model, operation });
  }
}

/** Argumentos da operação com o tenant da transação injetado e conferido. */
export function scopeTenantArgs(
  model: string,
  operation: string,
  args: unknown,
  tenantId: string,
): Args {
  const scoped: Args = { ...asRecord(args) };
  if (CREATE_OPERATIONS.has(operation)) {
    scoped.data = Array.isArray(scoped.data)
      ? scoped.data.map((item) => withTenant(item, tenantId, model, operation))
      : withTenant(scoped.data, tenantId, model, operation);
    return scoped;
  }
  if (operation === 'upsert') {
    scoped.where = scopedWhere(scoped.where, tenantId, model, operation);
    scoped.create = withTenant(scoped.create, tenantId, model, operation);
    assertUnchangedTenant(scoped.update, tenantId, model, operation);
    return scoped;
  }
  if (WHERE_OPERATIONS.has(operation)) {
    scoped.where = scopedWhere(scoped.where, tenantId, model, operation);
    if (UPDATE_OPERATIONS.has(operation)) {
      assertUnchangedTenant(scoped.data, tenantId, model, operation);
    }
    return scoped;
  }
  // Operação nova do Prisma sem regra aqui: falha fechada até ser classificada.
  throw tenantIsolationViolation('prisma_extension', 'unclassified_operation', {
    model,
    operation,
  });
}

/**
 * Decide o destino de cada operação: argumentos com tenant (modelo de tenant), sem mudança
 * (plataforma, SQL bruto em transação) ou erro antes do banco.
 */
export function isolateOperation(
  model: string | undefined,
  operation: string,
  args: unknown,
): unknown {
  const scope = currentTransactionScope();
  if (model === undefined) {
    // SQL bruto (`$queryRaw`, `$executeRaw`…): só dentro de uma transação com escopo.
    if (!scope) throw tenantContextMissing('prisma_extension', { operation });
    return args;
  }
  if (isPlatformModel(model)) return args;
  if (!isTenantScopedModel(model)) {
    throw tenantIsolationViolation('prisma_extension', 'unregistered_model', { model, operation });
  }
  if (scope?.kind !== 'TENANT' || scope.tenantId === null) {
    throw tenantContextMissing('prisma_extension', { model, operation });
  }
  return scopeTenantArgs(model, operation, args, scope.tenantId);
}

/** Extensão `tenant-isolation` (aplicada pelo `createTenantPrismaClient`). */
export const tenantIsolationExtension = Prisma.defineExtension({
  name: 'tenant-isolation',
  query: {
    async $allOperations({ model, operation, args, query }) {
      return (await query(isolateOperation(model, operation, args) as typeof args)) as unknown;
    },
  },
});
