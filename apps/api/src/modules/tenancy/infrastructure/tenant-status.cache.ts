import { Logger } from '@nestjs/common';
import { z } from 'zod';

import type { TenantStatus, TenantStatusPort } from '#shared/auth/ports.js';
import type { PlatformCache } from '#shared/cache/tenant-cache.js';

/** TTL do status em cache (US-100 · Backend): 30 s, invalidado na mudança de status. */
export const TENANT_STATUS_TTL_SECONDS = 30;

const CACHE_MODULE = 'tenant-status';

const cachedStatusSchema = z.strictObject({
  status: z.enum(['PROVISIONING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'DEACTIVATED']).nullable(),
});

/** Intervalo mínimo entre avisos de cache fora do ar (evita inundar o log durante a queda). */
const WARN_INTERVAL_MS = 30_000;

/**
 * `TenantStatusPort` com cache (US-100 · fluxo principal, passo 4): chave
 * `cf:{env}:p:tenant-status:{tenantId}`, 30 s. Redis indisponível → lê do banco e registra
 * `warn tenant.status_cache_unavailable` (a requisição segue — Gherkin "Falha de integração").
 * Tenant inexistente também fica em cache (`null`), para não martelar o banco com IDs forjados.
 * A invalidação por `TenantActivated`/`TenantSuspended` chama `invalidate` (US-099).
 */
export class TenantStatusCache implements TenantStatusPort {
  private readonly logger = new Logger('TenantStatusCache');
  private lastWarnAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly source: TenantStatusPort,
    private readonly cache: PlatformCache,
    private readonly now: () => number = Date.now,
  ) {}

  async findStatus(tenantId: string): Promise<TenantStatus | null> {
    try {
      const cached = await this.cache.get(CACHE_MODULE, tenantId, cachedStatusSchema);
      if (cached !== null) return cached.status;
    } catch (error) {
      this.unavailable(error);
      return this.source.findStatus(tenantId);
    }
    const status = await this.source.findStatus(tenantId);
    try {
      await this.cache.set(
        CACHE_MODULE,
        tenantId,
        { status },
        {
          ttlSeconds: TENANT_STATUS_TTL_SECONDS,
        },
      );
    } catch (error) {
      this.unavailable(error);
    }
    return status;
  }

  /** Remove o status do cache após mudança de status pela plataforma (US-099). */
  async invalidate(tenantId: string): Promise<void> {
    try {
      await this.cache.delete(CACHE_MODULE, tenantId);
    } catch (error) {
      // O TTL de 30 s limita a janela de status desatualizado.
      this.unavailable(error);
    }
  }

  private unavailable(error: unknown): void {
    const now = this.now();
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return;
    this.lastWarnAt = now;
    this.logger.warn(
      {
        event: 'tenant.status_cache_unavailable',
        errorName: error instanceof Error ? error.name : null,
      },
      'tenant.status_cache_unavailable',
    );
  }
}
