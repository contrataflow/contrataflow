import { Global, Inject, Injectable, Module } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';

import { DATABASE_CLIENT } from './database-client.js';
import { PlatformTransaction } from './platform-transaction.js';
import { createTenantPrismaClient } from './prisma-client.js';
import type { TenantPrismaClient } from './prisma-client.js';
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
}

/**
 * Módulo global do banco (shared kernel): exporta só as duas formas de transação
 * (`PlatformTransaction` em `platform-transaction.ts`, de uso restrito).
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
  ],
  exports: [TenantTransaction, PlatformTransaction],
})
export class DatabaseModule {}
