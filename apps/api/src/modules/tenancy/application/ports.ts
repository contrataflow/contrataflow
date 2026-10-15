/** Cache do status do tenant usado pelo guard de tenant (US-100); implementado em `infrastructure`. */
export interface TenantStatusCachePort {
  /** Descarta o status em cache; a próxima leitura vai ao banco. */
  invalidate(tenantId: string): Promise<void>;
}

export const TENANT_STATUS_CACHE = Symbol('TenantStatusCachePort');
