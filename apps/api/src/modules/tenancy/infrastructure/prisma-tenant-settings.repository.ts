import { Injectable } from '@nestjs/common';

import { TenantTransaction } from '#shared/database/database.module.js';
import { newId } from '#shared/database/ids.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';

import { SettingAlreadyExistsError } from '../application/settings-ports.js';
import type {
  SettingsTransactions,
  SettingWrite,
  TenantSettingsRepository,
} from '../application/settings-ports.js';
import type { StoredSetting } from '../domain/settings-update.js';

function createData(write: SettingWrite): Prisma.TenantSettingUncheckedCreateInput {
  return {
    id: newId(),
    tenantId: write.tenantId,
    key: write.key,
    value: write.value as Prisma.InputJsonValue,
    createdAt: write.now,
    updatedAt: write.now,
    createdById: write.userId,
    updatedById: write.userId,
    version: 1,
  };
}

/**
 * `tenant_settings` no PostgreSQL (US-103): leituras e escritas no `tx` do caso de uso, sob a RLS
 * do tenant e a extensão de isolamento. Nenhuma exclusão.
 */
@Injectable()
export class PrismaTenantSettingsRepository implements TenantSettingsRepository {
  async list(tx: TenantTx): Promise<StoredSetting[]> {
    const rows = await tx.tenantSetting.findMany({ orderBy: { key: 'asc' } });
    return rows.map((row) => ({ key: row.key, value: row.value, version: row.version }));
  }

  async insert(tx: TenantTx, write: SettingWrite): Promise<void> {
    // `skipDuplicates` (ON CONFLICT DO NOTHING) não aborta a transação numa corrida de primeira
    // gravação: o chamador ainda relê a versão vencedora para responder 412.
    const result = await tx.tenantSetting.createMany({
      data: [createData(write)],
      skipDuplicates: true,
    });
    if (result.count === 0) throw new SettingAlreadyExistsError(write.key);
  }

  async update(tx: TenantTx, write: SettingWrite, expectedVersion: number): Promise<void> {
    await updateVersioned(
      { aggregateType: 'TenantSetting', aggregateId: write.key, expectedVersion },
      () =>
        tx.tenantSetting.updateMany({
          where: { key: write.key, version: expectedVersion },
          data: {
            value: write.value as Prisma.InputJsonValue,
            updatedAt: write.now,
            updatedById: write.userId,
            version: { increment: 1 },
          },
        }),
    );
  }

  async insertMissing(tx: TenantTx, writes: readonly SettingWrite[]): Promise<number> {
    if (writes.length === 0) return 0;
    const result = await tx.tenantSetting.createMany({
      data: writes.map(createData),
      skipDuplicates: true,
    });
    return result.count;
  }
}

/** Transações do módulo sobre a `TenantTransaction` (contexto de tenant da requisição). */
@Injectable()
export class PrismaSettingsTransactions implements SettingsTransactions {
  constructor(private readonly transaction: TenantTransaction) {}

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.run(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.read(work);
  }
}
