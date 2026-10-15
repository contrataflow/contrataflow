import { Injectable } from '@nestjs/common';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { SettingAlreadyExistsError } from '../application/settings-ports.js';
import type {
  SettingsTransactions,
  SettingWrite,
  TenantSettingsRepository,
} from '../application/settings-ports.js';
import type { StoredSetting } from '../domain/settings-update.js';

interface Row extends StoredSetting {
  readonly tenantId: string;
}

/**
 * Configurações em memória (testes e modo de identidade fake de local/dev/test): mesma semântica
 * do adaptador Prisma — isolamento pelo `tenantId` da escrita/leitura, unicidade `(tenant, chave)`
 * e concorrência otimista por versão. A leitura filtra pelo tenant do contexto da requisição, como
 * o `app.tenant_id` da RLS.
 */
export class InMemoryTenantSettingsRepository implements TenantSettingsRepository {
  private readonly rows = new Map<string, Row>();

  /** Tenant que as leituras enxergam (o do contexto da requisição, informado pelo módulo). */
  constructor(private readonly currentTenantId: () => string | null) {}

  private static id(tenantId: string, key: string): string {
    return `${tenantId}\u0000${key}`;
  }

  list(_tx: TenantTx): Promise<StoredSetting[]> {
    const tenantId = this.currentTenantId();
    return Promise.resolve(
      [...this.rows.values()]
        .filter((row) => row.tenantId === tenantId)
        .map(({ key, value, version }) => ({ key, value, version }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    );
  }

  insert(_tx: TenantTx, write: SettingWrite): Promise<void> {
    const id = InMemoryTenantSettingsRepository.id(write.tenantId, write.key);
    if (this.rows.has(id)) return Promise.reject(new SettingAlreadyExistsError(write.key));
    this.rows.set(id, { tenantId: write.tenantId, key: write.key, value: write.value, version: 1 });
    return Promise.resolve();
  }

  update(_tx: TenantTx, write: SettingWrite, expectedVersion: number): Promise<void> {
    const id = InMemoryTenantSettingsRepository.id(write.tenantId, write.key);
    const current = this.rows.get(id);
    if (current?.version !== expectedVersion) {
      return Promise.reject(
        new VersionConflictError({
          aggregateType: 'TenantSetting',
          aggregateId: write.key,
          expectedVersion,
        }),
      );
    }
    this.rows.set(id, { ...current, value: write.value, version: expectedVersion + 1 });
    return Promise.resolve();
  }

  insertMissing(_tx: TenantTx, writes: readonly SettingWrite[]): Promise<number> {
    let created = 0;
    for (const write of writes) {
      const id = InMemoryTenantSettingsRepository.id(write.tenantId, write.key);
      if (this.rows.has(id)) continue;
      this.rows.set(id, {
        tenantId: write.tenantId,
        key: write.key,
        value: write.value,
        version: 1,
      });
      created += 1;
    }
    return Promise.resolve(created);
  }

  /** Inspeção e carga de testes: todas as linhas de todos os tenants. */
  snapshot(): readonly Row[] {
    return [...this.rows.values()];
  }

  /** Carga de testes (configuração já gravada, em qualquer versão). */
  seed(tenantId: string, key: string, value: unknown, version = 1): void {
    this.rows.set(InMemoryTenantSettingsRepository.id(tenantId, key), {
      tenantId,
      key,
      value,
      version,
    });
  }
}

/** Transações simuladas: um `tx` sentinela ativo só durante o trabalho. */
@Injectable()
export class InMemorySettingsTransactions implements SettingsTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}
