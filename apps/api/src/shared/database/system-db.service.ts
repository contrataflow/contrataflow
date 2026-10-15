import { Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { currentRequestContext } from '#shared/context/request-context.js';

import { trackTransaction } from './active-transaction.js';
import { DatabaseUnavailableError, isTransientDatabaseError } from './errors.js';
import { Prisma, PrismaClient } from './generated/prisma/client.js';
import { isUuid } from './ids.js';
import { isolationMetrics } from '../tenancy/isolation.js';

/**
 * Motivos aceitos pelo `SystemDbService` (RN-TEN-28 · ADR-002), lista fechada: toda chamada declara
 * por que precisa sair do contexto de tenant.
 */
export const SYSTEM_DB_REASONS = [
  'TENANT_LIFECYCLE',
  'TENANT_PROVISIONING',
  'TENANT_ENUMERATION',
  'USER_MEMBERSHIPS_LOOKUP',
  'INVITATION_LOOKUP',
  'PLATFORM_AUDIT',
] as const;

export type SystemDbReason = (typeof SYSTEM_DB_REASONS)[number];

/** Cliente da transação de plataforma (papel `cf_platform`, sem a extensão de tenant). */
export type SystemTx = Prisma.TransactionClient;

/**
 * `app.tenant_id` das transações de plataforma: o UUID nulo, que não corresponde a nenhum tenant
 * (multi-tenancy.md §4). As políticas `tenant_isolation` avaliam falso sem erro e só as políticas
 * explícitas `TO cf_platform` (auditoria de plataforma, eventos do agregado `Tenant`) liberam
 * linhas.
 */
export const NO_TENANT = '00000000-0000-0000-0000-000000000000';

export interface SystemDbSettings {
  /** `DATABASE_URL_PLATFORM`; `null` (só local/dev/test) → toda chamada é recusada. */
  readonly url: string | null;
  readonly maxWaitMs: number;
  readonly transactionTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export interface SystemDbCallOptions {
  /** Quem chama (classe/caso de uso), para o log `system_db.call`. */
  readonly caller: string;
  /** Usuário em `app.user_id` (condição de `cf_user_memberships`). */
  readonly userId?: string | null;
  readonly readOnly?: boolean;
}

/** `DATABASE_URL_PLATFORM` ausente: configuração de ambiente, não falha transitória. */
export class SystemDbNotConfiguredError extends Error {
  constructor() {
    super('SystemDbService sem DATABASE_URL_PLATFORM (papel cf_platform).');
    this.name = 'SystemDbNotConfiguredError';
  }
}

/** Motivo fora da lista fechada: erro de programação. */
export class SystemDbReasonError extends Error {
  constructor(reason: string) {
    super(`Motivo de acesso de plataforma não autorizado: ${reason}.`);
    this.name = 'SystemDbReasonError';
  }
}

const reasons: ReadonlySet<string> = new Set(SYSTEM_DB_REASONS);

/**
 * Acesso de plataforma ao banco (US-100 · RN-TEN-28 · multi-tenancy.md §5.3): segundo
 * `PrismaClient`, conectado como `cf_platform` (sem `BYPASSRLS`), SEM a extensão de tenant. Única via
 * para escrever em `tenants`, gravar auditoria de plataforma e eventos do agregado `Tenant` e
 * chamar as funções entre tenants (`cf_find_invitation`, `cf_user_memberships`). Importação restrita
 * pelo dependency-cruiser (`system-prisma-allowlist`); toda chamada exige um motivo da lista fechada
 * e gera log `system_db.call` + métrica `cf_system_db_calls_total{reason}`; toda escrita é auditada
 * pelo caso de uso que chama. Trabalho sobre dados de um tenant reabre a `TenantTransaction` daquele
 * tenant (`runForTenant`).
 */
export class SystemDbService implements OnModuleDestroy {
  private readonly logger = new Logger('SystemDb');
  private client: PrismaClient | null = null;

  constructor(private readonly settings: SystemDbSettings) {}

  async run<T>(
    reason: SystemDbReason,
    work: (tx: SystemTx) => Promise<T>,
    options: SystemDbCallOptions,
  ): Promise<T> {
    if (!reasons.has(reason)) throw new SystemDbReasonError(reason);
    const userId = options.userId ?? '';
    if (userId !== '' && !isUuid(userId)) throw new SystemDbReasonError('user_id');
    const client = this.connect();
    const startedAt = performance.now();
    let outcome: 'ok' | 'error' = 'error';
    try {
      const result = await this.transaction(client, userId, options.readOnly === true, work);
      outcome = 'ok';
      return result;
    } catch (error) {
      if (isTransientDatabaseError(error)) throw new DatabaseUnavailableError(error);
      throw error;
    } finally {
      isolationMetrics().systemDbCalls.add(1, { reason, outcome });
      this.logger.log(
        {
          event: 'system_db.call',
          reason,
          caller: options.caller,
          outcome,
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
          correlationId: currentRequestContext()?.correlationId ?? null,
        },
        'system_db.call',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.$disconnect();
  }

  private connect(): PrismaClient {
    if (this.settings.url === null) throw new SystemDbNotConfiguredError();
    this.client ??= new PrismaClient({
      adapter: new PrismaPg({
        connectionString: this.settings.url,
        max: 2,
        connectionTimeoutMillis: this.settings.maxWaitMs,
      }),
    });
    return this.client;
  }

  private transaction<T>(
    client: PrismaClient,
    userId: string,
    readOnly: boolean,
    work: (tx: SystemTx) => Promise<T>,
  ): Promise<T> {
    const statementTimeout = String(this.settings.statementTimeoutMs);
    return client.$transaction(
      async (tx) => {
        await (readOnly
          ? tx.$executeRaw`SELECT set_config('app.tenant_id', ${NO_TENANT}, true), set_config('app.user_id', ${userId}, true), set_config('statement_timeout', ${statementTimeout}, true), set_config('transaction_read_only', 'on', true)`
          : tx.$executeRaw`SELECT set_config('app.tenant_id', ${NO_TENANT}, true), set_config('app.user_id', ${userId}, true), set_config('statement_timeout', ${statementTimeout}, true)`);
        return trackTransaction(tx, () => work(tx));
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: this.settings.maxWaitMs,
        timeout: this.settings.transactionTimeoutMs,
      },
    );
  }
}
