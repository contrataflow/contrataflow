import type { TenantLifecycleStatus } from '@contrataflow/types';

import type { TenantTx } from '#shared/database/prisma.js';

import type { Tenant, TenantLifecyclePatch } from '../domain/tenant.js';

/** Cache do status do tenant usado pelo guard de tenant (US-100); implementado em `infrastructure`. */
export interface TenantStatusCachePort {
  /** Descarta o status em cache; a próxima leitura vai ao banco. */
  invalidate(tenantId: string): Promise<void>;
}

export const TENANT_STATUS_CACHE = Symbol('TenantStatusCachePort');

/*
 * Portas do provisionamento e do ciclo de vida (US-099). `tenants` é tabela de plataforma: toda
 * leitura e escrita passa pelo `SystemDbService` (papel `cf_platform`) — inclusive a auditoria das
 * ações de plataforma e os eventos do agregado `Tenant` (políticas de US-100). Em memória nos
 * testes e no modo de identidade fake.
 */

/** Motivos do `SystemDbService` usados pelo `tenancy` (subconjunto da lista fechada de RN-TEN-28). */
export type PlatformAccessReason =
  'TENANT_LIFECYCLE' | 'TENANT_PROVISIONING' | 'TENANT_ENUMERATION';

export interface PlatformTransactions {
  run<T>(reason: PlatformAccessReason, work: (tx: TenantTx) => Promise<T>): Promise<T>;
  read<T>(reason: PlatformAccessReason, work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const PLATFORM_TRANSACTIONS = Symbol('TenancyPlatformTransactions');

export interface TenantListFilter {
  readonly status?: TenantLifecycleStatus;
  readonly stateCode?: string;
  /** Nome ou slug (contém, sem diferenciar maiúsculas). */
  readonly q?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface TenantPage {
  readonly items: readonly Tenant[];
  readonly totalItems: number;
}

/** Slug já usado (índice único `tenants_slug_key` — RN-TEN-02, inclusive em corrida). */
export class TenantSlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`Slug ${slug} já usado.`);
    this.name = 'TenantSlugTakenError';
  }
}

export interface TenantAdminRepository {
  findById(tx: TenantTx, id: string): Promise<Tenant | null>;
  findBySlug(tx: TenantTx, slug: string): Promise<Tenant | null>;
  list(tx: TenantTx, filter: TenantListFilter): Promise<TenantPage>;
  /** @throws TenantSlugTakenError */
  insert(tx: TenantTx, tenant: Tenant): Promise<Tenant>;
  /**
   * Aplica a transição só se a versão ainda for `expectedVersion` (incrementa `version`).
   * @throws VersionConflictError outra transação mudou o tenant antes (412 `VERSION_CONFLICT`)
   */
  updateLifecycle(
    tx: TenantTx,
    id: string,
    expectedVersion: number,
    patch: TenantLifecyclePatch,
    now: Date,
  ): Promise<Tenant>;
  /** Já existe a auditoria `tenant.provision` com sucesso (o `TenantProvisioned` é único)? */
  provisionRecorded(tx: TenantTx, tenantId: string): Promise<boolean>;
  /**
   * Marca a conclusão na mesma transação da auditoria `tenant.provision` — no banco a própria
   * linha de auditoria é a marca (nada a fazer); em memória, guarda o tenant.
   */
  markProvisioned(tx: TenantTx, tenantId: string): Promise<void>;
}

export const TENANT_ADMIN_REPOSITORY = Symbol('TenantAdminRepository');

export type TenancyClock = () => Date;

export const TENANCY_CLOCK = Symbol('TenancyClock');
