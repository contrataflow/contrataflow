import { Global, Inject, Injectable, Module } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';

import { DATABASE_CLIENT } from './database-client.js';
import { PlatformTransaction } from './platform-transaction.js';
import { createTenantPrismaClient } from './prisma-client.js';
import type { TenantPrismaClient } from './prisma-client.js';
import { SystemDbService } from './system-db.service.js';
import type { TenantTx } from './tenant-transaction.js';

/** Encerra o pool no shutdown (o cliente é criado sob demanda, na primeira transação). */
@Injectable()
export class DatabaseLifecycle implements OnModuleDestroy {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: TenantPrismaClient) {}

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/**
 * Acesso a dados de todo módulo de negócio (RN-FND-43 · architecture.md §6.5): cada chamada abre
 * uma transação com `app.tenant_id` do contexto; os repositórios recebem só o `tx`. Nenhum código
 * fora de `shared/database/**` vê o `PrismaClient`.
 */
@Injectable()
export class TenantTransaction {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: TenantPrismaClient) {}

  /** Comando: transação de escrita. */
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.prisma.$tenantTransaction(work);
  }

  /** Consulta: transação somente leitura (prepara o roteamento futuro para réplica). */
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.prisma.$tenantTransaction(work, { readOnly: true });
  }

  /**
   * Comando de um caso de uso `PLATFORM` sobre um tenant alvo (US-100 · FA-02 · RN-TEN-21):
   * provisionamento, jobs de plataforma que iteram tenants. Só fora de contexto de tenant (ou no
   * mesmo tenant) e com ator `SYSTEM`/`PLATFORM_OPERATOR`; dentro de uma rota `TENANT` para outro
   * tenant → `TenantIsolationViolationError`.
   */
  runForTenant<T>(tenantId: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.prisma.$tenantTransaction(work, { tenantId });
  }
}

/**
 * Módulo global do banco (shared kernel): exporta as formas de transação — `TenantTransaction`
 * (todo módulo), `PlatformTransaction` e `SystemDbService` (papel `cf_platform`), estas duas de uso
 * restrito pelo dependency-cruiser.
 */
@Global()
@Module({
  providers: [
    {
      provide: DATABASE_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createTenantPrismaClient(config.database),
    },
    DatabaseLifecycle,
    TenantTransaction,
    PlatformTransaction,
    {
      provide: SystemDbService,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new SystemDbService({
          url: config.database.platformUrl,
          maxWaitMs: config.database.maxWaitMs,
          transactionTimeoutMs: config.database.transactionTimeoutMs,
          statementTimeoutMs: config.database.statementTimeoutMs,
        }),
    },
  ],
  exports: [TenantTransaction, PlatformTransaction, SystemDbService],
})
export class DatabaseModule {}
