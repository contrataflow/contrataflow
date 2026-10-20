import { createHash } from 'node:crypto';

import { DASHBOARD_CACHE_TTL_SECONDS } from '@contrataflow/validation';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { TenantCache } from '#shared/cache/tenant-cache.js';

import { recordDashboardCacheLookup } from './dashboard-telemetry.js';

/*
 * Cache do painel (US-076 · RN-DASH-10): 60 s por `(tenant, usuário, indicador, filtros)`. O
 * tenant vem do contexto (`TenantCache` — `cf:{env}:t:{tenantId}:dashboard:…`); o usuário e o hash
 * dos filtros completam a chave, para nunca misturar resultados entre usuários ou recortes. Com o
 * Redis fora, a leitura segue direto ao banco (`warn dashboard.cache_unavailable`) — nunca 503.
 */

const MODULE = 'dashboard';

export interface DashboardCacheKeyInput {
  readonly userId: string;
  /** Chave do indicador ou `SUMMARY`. */
  readonly widget: string;
  readonly secretariatId?: string | undefined;
  readonly departmentId?: string | undefined;
  /** Só `RECENT_ACTIVITY` (nos demais, ignorado — não fragmenta o cache). */
  readonly limit?: number | undefined;
}

/** Chave relativa ao módulo: `{userId}:{widget}:{hash dos filtros}` (sem valores em claro). */
export function dashboardCacheKey(input: DashboardCacheKeyInput): string {
  const filters = JSON.stringify([
    input.secretariatId ?? null,
    input.departmentId ?? null,
    input.limit ?? null,
  ]);
  const hash = createHash('sha256').update(filters).digest('hex').slice(0, 16);
  return `${input.userId}:${input.widget}:${hash}`;
}

export interface CachedValue<T> {
  readonly value: T;
  readonly expiresAt: string;
}

@Injectable()
export class DashboardCache {
  private readonly logger = new Logger('Dashboard');

  constructor(private readonly cache: TenantCache) {}

  /** O valor ainda válido, ou `null` (ausente, corrompido ou Redis fora). */
  async read<T>(widget: string, key: string, schema: z.ZodType<T>): Promise<CachedValue<T> | null> {
    try {
      const entry = await this.cache.get(
        MODULE,
        key,
        z.object({ value: schema, expiresAt: z.string() }),
      );
      recordDashboardCacheLookup(widget, entry === null ? 'miss' : 'hit');
      return entry === null ? null : { value: entry.value, expiresAt: entry.expiresAt };
    } catch (error) {
      recordDashboardCacheLookup(widget, 'unavailable');
      this.unavailable(widget, error);
      return null;
    }
  }

  /** Grava por 60 s; falha do Redis só gera o `warn` (a resposta já está calculada). */
  async write(widget: string, key: string, value: unknown, now: Date): Promise<string> {
    const expiresAt = new Date(now.getTime() + DASHBOARD_CACHE_TTL_SECONDS * 1000).toISOString();
    try {
      await this.cache.set(
        MODULE,
        key,
        { value, expiresAt },
        { ttlSeconds: DASHBOARD_CACHE_TTL_SECONDS },
      );
    } catch (error) {
      this.unavailable(widget, error);
    }
    return expiresAt;
  }

  private unavailable(widget: string, error: unknown): void {
    this.logger.warn(
      {
        event: 'dashboard.cache_unavailable',
        widgetKey: widget,
        errorName: error instanceof Error ? error.name : null,
      },
      'dashboard.cache_unavailable',
    );
  }
}
