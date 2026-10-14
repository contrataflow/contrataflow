import { Global, Inject, Injectable, Module } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';

import { createTenantPrismaClient } from './prisma-client.js';
import type { TenantPrismaClient } from './prisma-client.js';
import type { TenantTx } from './tenant-transaction.js';

/**
 * Acesso a dados de todo módulo de negócio (RN-FND-43 · architecture.md §6.5): cada chamada abre
 * uma transação com `app.tenant_id` do contexto; os repositórios recebem só o `tx`. Nenhum código
 * fora de `shared/database/**` vê o `PrismaClient`.
 */
@Injectable()
export class TenantTransaction implements OnModuleDestroy {
  private readonly prisma: TenantPrismaClient;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.prisma = createTenantPrismaClient(config.database);
  }

  /** Comando: transação de escrita. */
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.prisma.$tenantTransaction(work);
  }

  /** Consulta: transação somente leitura (prepara o roteamento futuro para réplica). */
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.prisma.$tenantTransaction(work, { readOnly: true });
  }

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/** Módulo global do banco (shared kernel): exporta só o `TenantTransaction`. */
@Global()
@Module({ providers: [TenantTransaction], exports: [TenantTransaction] })
export class DatabaseModule {}
