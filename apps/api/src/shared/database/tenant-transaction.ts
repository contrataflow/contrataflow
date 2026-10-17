import { currentRequestContext } from '#shared/context/request-context.js';

import { trackTransaction } from './active-transaction.js';
import {
  DatabaseUnavailableError,
  isForeignKeyViolation,
  isRetryableTransactionError,
  isRowLevelSecurityViolation,
  isTransientDatabaseError,
  referenceNotFound,
  TenantContextMissingError,
} from './errors.js';
import { Prisma } from './generated/prisma/client.js';
import type { PrismaClient } from './generated/prisma/client.js';
import { isUuid } from './ids.js';
import { runInTransactionScope } from './transaction-scope.js';
import type { TransactionScope } from './transaction-scope.js';
import { isolationMetrics, tenantIsolationViolation } from '../tenancy/isolation.js';
import { TenantContext } from '../tenancy/tenant-context.js';

/** Cliente da transação entregue aos repositórios (sem `$transaction` nem `$connect`). */
export type TenantTx = Prisma.TransactionClient;

export interface TenantTransactionSettings {
  /** Espera máxima por uma conexão do pool ao abrir a transação. */
  readonly maxWaitMs: number;
  readonly transactionTimeoutMs: number;
  readonly statementTimeoutMs: number;
  /** Retentativas em falha de serialização/deadlock (architecture.md §6.4: até 2). */
  readonly retries?: number;
}

export interface TenantTransactionOptions {
  /** Consulta: a transação recusa escrita (`transaction_read_only`). */
  readonly readOnly?: boolean;
  /**
   * Leitura em instantâneo único (`REPEATABLE READ`): todas as consultas do trabalho veem o mesmo
   * instante (ex.: painel situacional — RN-PROC-56). Padrão: `READ COMMITTED`.
   */
  readonly repeatableRead?: boolean;
  /**
   * Tenant alvo de um caso de uso `PLATFORM` (FA-02 · RN-TEN-21): só fora de contexto de tenant
   * (ou no mesmo tenant) e com ator `SYSTEM`/`PLATFORM_OPERATOR`. Padrão: o tenant do contexto.
   */
  readonly tenantId?: string;
  /**
   * Leitura longa em *streaming* (exportação por cursor — US-003 · RN-PROC-45): substitui o
   * `statement_timeout` e o tempo máximo da transação interativa pelo mesmo valor.
   */
  readonly timeoutMs?: number;
}

/** Atores que podem abrir transação para um tenant alvo (RN-TEN-21). */
const TARGET_TENANT_ACTORS: ReadonlySet<string> = new Set(['SYSTEM', 'PLATFORM_OPERATOR']);

/** Tenant da transação: o do contexto ou, para casos de uso de plataforma, o alvo informado. */
function resolveTenant(options: TenantTransactionOptions): { tenantId: string; userId: string } {
  const context = currentRequestContext();
  if (options.tenantId === undefined) {
    const tenant = TenantContext.getOrThrow('context', { operation: 'tenant_transaction' });
    return { tenantId: tenant.tenantId, userId: tenant.userId ?? '' };
  }
  const target = options.tenantId;
  if (!isUuid(target)) throw new TenantContextMissingError();
  const current = context?.tenantId ?? null;
  if (current !== null && current !== target) {
    throw tenantIsolationViolation('context', 'transaction_for_other_tenant', {
      operation: 'tenant_transaction',
    });
  }
  if (current === null && !TARGET_TENANT_ACTORS.has(context?.actor.type ?? 'ANONYMOUS')) {
    throw tenantIsolationViolation('context', 'target_tenant_without_platform_actor', {
      operation: 'tenant_transaction',
    });
  }
  return { tenantId: target, userId: context?.actor.userId ?? '' };
}

/**
 * Corpo da `TenantTransaction` (RN-FND-43 · RN-TEN-22 · multi-tenancy.md §5.2): transação
 * interativa `READ COMMITTED` cuja PRIMEIRA instrução é `set_config('app.tenant_id', $1, true)` —
 * escopo da transação, nunca da sessão (RN-FND-44): ao terminar, a conexão volta ao pool sem
 * contexto e pode servir outro tenant (PgBouncer em modo transação/RDS Proxy — FA-01). Leituras
 * também passam por aqui (FA-02), em transação somente leitura.
 */
export async function runTenantTransaction<T>(
  base: PrismaClient,
  settings: TenantTransactionSettings,
  work: (tx: TenantTx) => Promise<T>,
  options: TenantTransactionOptions,
): Promise<T> {
  const { tenantId, userId } = resolveTenant(options);
  const effective: TenantTransactionSettings =
    options.timeoutMs === undefined
      ? settings
      : {
          ...settings,
          statementTimeoutMs: options.timeoutMs,
          transactionTimeoutMs: options.timeoutMs,
          retries: 0,
        };
  const statementTimeout = String(effective.statementTimeoutMs);
  const isolation = options.repeatableRead
    ? Prisma.TransactionIsolationLevel.RepeatableRead
    : Prisma.TransactionIsolationLevel.ReadCommitted;
  return await runScoped(
    base,
    effective,
    work,
    { kind: 'TENANT', tenantId },
    (tx) =>
      options.readOnly
        ? tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.user_id', ${userId}, true), set_config('statement_timeout', ${statementTimeout}, true), set_config('transaction_read_only', 'on', true)`
        : tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.user_id', ${userId}, true), set_config('statement_timeout', ${statementTimeout}, true)`,
    isolation,
  );
}

export interface PlatformTransactionOptions extends Omit<TenantTransactionOptions, 'tenantId'> {
  /**
   * Usuário em `app.user_id` (condição de `cf_user_memberships`); padrão: o ator do contexto.
   * Informado explicitamente só onde o usuário ainda não está no contexto (início de sessão).
   */
  readonly userId?: string | null;
}

/**
 * Transação de plataforma (multi-tenancy.md §6 · US-087): tabelas sem `tenant_id` (`users`,
 * `tenants`) e funções de leitura entre tenants (`cf_user_memberships`). NÃO define
 * `app.tenant_id`: qualquer consulta a tabela com RLS falha fechada (variável ausente ou vazia), e a
 * extensão recusa modelos de tenant antes do banco.
 */
export async function runPlatformTransaction<T>(
  base: PrismaClient,
  settings: TenantTransactionSettings,
  work: (tx: TenantTx) => Promise<T>,
  options: PlatformTransactionOptions,
): Promise<T> {
  const userId = options.userId ?? currentRequestContext()?.actor.userId ?? '';
  if (userId !== '' && !isUuid(userId)) throw new TenantContextMissingError();
  const statementTimeout = String(settings.statementTimeoutMs);
  return await runScoped(base, settings, work, { kind: 'PLATFORM', tenantId: null }, (tx) =>
    options.readOnly
      ? tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true), set_config('statement_timeout', ${statementTimeout}, true), set_config('transaction_read_only', 'on', true)`
      : tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true), set_config('statement_timeout', ${statementTimeout}, true)`,
  );
}

/**
 * Transação `READ COMMITTED` cuja primeira instrução é `prepare` (o `set_config` do escopo), com o
 * escopo visível à extensão de isolamento durante todo o trabalho. Falha ao preparar (conexão
 * caída no `set_config`) aborta antes de qualquer consulta de negócio.
 */
async function runScoped<T>(
  base: PrismaClient,
  settings: TenantTransactionSettings,
  work: (tx: TenantTx) => Promise<T>,
  scope: TransactionScope,
  prepare: (tx: TenantTx) => Promise<number>,
  isolationLevel: Prisma.TransactionIsolationLevel = Prisma.TransactionIsolationLevel.ReadCommitted,
): Promise<T> {
  const retries = settings.retries ?? 2;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runInTransactionScope(scope, () =>
        base.$transaction(
          async (tx) => {
            const startedAt = performance.now();
            await prepare(tx);
            isolationMetrics().contextOverhead.record((performance.now() - startedAt) / 1000, {
              scope: scope.kind,
            });
            return trackTransaction(tx, () => work(tx));
          },
          {
            isolationLevel,
            maxWait: settings.maxWaitMs,
            timeout: settings.transactionTimeoutMs,
          },
        ),
      );
    } catch (error) {
      // Serialização/deadlock: refaz a transação inteira (o trabalho não tem efeito externo).
      if (attempt < retries && isRetryableTransactionError(error)) continue;
      if (isTransientDatabaseError(error)) throw new DatabaseUnavailableError(error);
      // FK composta: referência a registro de outro tenant (ou inexistente) — RN-TEN-33.
      if (isForeignKeyViolation(error)) throw referenceNotFound(error);
      // Escrita barrada pela RLS: a aplicação deixou passar dado de outro tenant (V-07).
      if (isRowLevelSecurityViolation(error)) {
        throw tenantIsolationViolation('rls', 'rls_write_rejected', { scope: scope.kind }, error);
      }
      throw error;
    }
  }
}

/**
 * Extensão de cliente Prisma `TenantTransaction`: acrescenta `$tenantTransaction(work, options)`.
 * O cliente estendido só existe dentro de `shared/database/**` (lint
 * `contrataflow/no-prisma-client-outside-database`); os módulos recebem o `TenantTransaction`.
 */
export function tenantTransactionExtension(
  base: PrismaClient,
  settings: TenantTransactionSettings,
) {
  return Prisma.defineExtension({
    name: 'tenant-transaction',
    client: {
      $tenantTransaction<T>(
        work: (tx: TenantTx) => Promise<T>,
        options: TenantTransactionOptions = {},
      ): Promise<T> {
        return runTenantTransaction(base, settings, work, options);
      },
      $platformTransaction<T>(
        work: (tx: TenantTx) => Promise<T>,
        options: PlatformTransactionOptions = {},
      ): Promise<T> {
        return runPlatformTransaction(base, settings, work, options);
      },
    },
  });
}
