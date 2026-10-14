import { Logger } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';

import {
  DatabaseUnavailableError,
  isRetryableTransactionError,
  isTransientDatabaseError,
  TenantContextMissingError,
} from './errors.js';
import { Prisma } from './generated/prisma/client.js';
import type { PrismaClient } from './generated/prisma/client.js';
import { isUuid } from './ids.js';

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
}

const logger = new Logger('Database');

/** Tenant do contexto ativo (requisição ou job); sem ele, falha fechada antes do banco. */
function requireTenantId(): { tenantId: string; userId: string } {
  const context = currentRequestContext();
  const tenantId = context?.tenantId ?? null;
  if (tenantId === null || !isUuid(tenantId)) {
    // Não deveria ocorrer: indica rota/job sem o guard de tenant (sem dados da consulta no log).
    logger.error(`db.tenant_context_missing correlationId=${context?.correlationId ?? '-'}`);
    throw new TenantContextMissingError();
  }
  return { tenantId, userId: context?.actor.userId ?? '' };
}

/**
 * Corpo da `TenantTransaction` (RN-FND-43 · multi-tenancy.md §5.2): transação interativa
 * `READ COMMITTED` cuja PRIMEIRA instrução é `set_config('app.tenant_id', $1, true)` — escopo da
 * transação, nunca da sessão (RN-FND-44): ao terminar, a conexão volta ao pool sem contexto e
 * pode servir outro tenant (PgBouncer em modo transação/RDS Proxy — FA-01). Leituras também
 * passam por aqui (FA-02), em transação somente leitura.
 */
export async function runTenantTransaction<T>(
  base: PrismaClient,
  settings: TenantTransactionSettings,
  work: (tx: TenantTx) => Promise<T>,
  options: TenantTransactionOptions,
): Promise<T> {
  const { tenantId, userId } = requireTenantId();
  const statementTimeout = String(settings.statementTimeoutMs);
  const retries = settings.retries ?? 2;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await base.$transaction(
        async (tx) => {
          await (options.readOnly
            ? tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.user_id', ${userId}, true), set_config('statement_timeout', ${statementTimeout}, true), set_config('transaction_read_only', 'on', true)`
            : tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.user_id', ${userId}, true), set_config('statement_timeout', ${statementTimeout}, true)`);
          return work(tx);
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: settings.maxWaitMs,
          timeout: settings.transactionTimeoutMs,
        },
      );
    } catch (error) {
      // Serialização/deadlock: refaz a transação inteira (o trabalho não tem efeito externo).
      if (attempt < retries && isRetryableTransactionError(error)) continue;
      if (isTransientDatabaseError(error)) throw new DatabaseUnavailableError(error);
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
    },
  });
}
