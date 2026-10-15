import { Global, Module } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { PlatformModule } from '#modules/platform/platform.module.js';
import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';

import { AuditFacade } from './application/audit.facade.js';
import { AuditService } from './application/audit.service.js';
import { EnsureAuditPartitionsJob } from './application/ensure-audit-partitions.job.js';
import {
  AUDIT_CLOCK,
  AUDIT_LOG_STORE,
  AUDIT_PARTITIONS,
  AUDIT_TRANSACTIONS,
} from './application/ports.js';
import { AuditPartitionScheduler } from './infrastructure/audit-partition.scheduler.js';
import {
  InMemoryAuditLogStore,
  InMemoryAuditPartitions,
  InMemoryAuditTransactions,
} from './infrastructure/in-memory-audit.store.js';
import { PrismaAuditLogStore } from './infrastructure/prisma-audit-log.store.js';
import {
  PrismaAuditPartitions,
  PrismaAuditTransactions,
} from './infrastructure/prisma-audit-transactions.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): trilha em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `audit` (DEC-040 · US-073): dono de `AuditLog` e do `AuditService`. É GLOBAL porque a
 * auditoria é transversal: todo módulo (inclusive os de nível 1, que não importam este) e o
 * pipeline HTTP injetam a porta `AUDIT_TRAIL` do shared kernel, nunca este módulo (DEC-071).
 */
@Global()
@Module({
  imports: [PlatformModule],
  providers: [
    AuditFacade,
    AuditService,
    { provide: AUDIT_TRAIL, useExisting: AuditService },
    PrismaAuditLogStore,
    PrismaAuditTransactions,
    PrismaAuditPartitions,
    {
      provide: AUDIT_LOG_STORE,
      inject: [APP_CONFIG, PrismaAuditLogStore],
      useFactory: (config: AppConfig, prisma: PrismaAuditLogStore) =>
        inMemory(config) ? new InMemoryAuditLogStore() : prisma,
    },
    {
      provide: AUDIT_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaAuditTransactions],
      useFactory: (config: AppConfig, prisma: PrismaAuditTransactions) =>
        inMemory(config) ? new InMemoryAuditTransactions() : prisma,
    },
    {
      provide: AUDIT_PARTITIONS,
      inject: [APP_CONFIG, PrismaAuditPartitions],
      useFactory: (config: AppConfig, prisma: PrismaAuditPartitions) =>
        inMemory(config) ? new InMemoryAuditPartitions() : prisma,
    },
    { provide: AUDIT_CLOCK, useValue: () => new Date() },
    EnsureAuditPartitionsJob,
    AuditPartitionScheduler,
  ],
  exports: [AuditFacade, AUDIT_TRAIL],
})
export class AuditModule {}
