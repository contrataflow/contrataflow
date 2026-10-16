import { Inject, Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';

import { CACHE_STORE } from './cache-store.js';
import type { CacheStore } from './cache-store.js';
import { tenantIsolationViolation } from '../tenancy/isolation.js';
import { TenantContext } from '../tenancy/tenant-context.js';

/*
 * Chaves de cache derivadas do contexto (US-100 · RN-TEN-29 · multi-tenancy.md §7):
 * - dados de tenant: `cf:{env}:t:{tenantId}:{módulo}:{chave}` — `TenantCache`, tenant do contexto;
 * - dados de plataforma: `cf:{env}:p:{módulo}:{chave}` — `PlatformCache`.
 * Quem chama nunca informa o tenant nem monta a chave inteira; TTL obrigatório; o valor lido é
 * validado pelo schema Zod (dado corrompido ou de outra versão vira ausência, não exceção).
 */

const MODULE = /^[a-z][a-z0-9-]{0,39}$/;
/** Chave relativa ao módulo: pode ter `:` (ex.: `eff:{membershipId}`), nunca curingas. */
const KEY = /^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*$/;
const MAX_TTL_SECONDS = 7 * 24 * 3600;

export interface CacheWriteOptions {
  /** Obrigatório (architecture.md §6.12): nada fica no cache sem prazo. */
  readonly ttlSeconds: number;
}

export interface CacheReadThroughOptions<T> extends CacheWriteOptions {
  readonly schema: z.ZodType<T>;
}

/** Chave inválida: erro de programação (segmento com curinga, chave já com prefixo de escopo…). */
export class CacheKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheKeyError';
  }
}

function assertTtl(ttlSeconds: number): void {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new CacheKeyError(`TTL inválido: ${String(ttlSeconds)}`);
  }
}

/** Base comum: serialização JSON validada e leitura com fallback quando o Redis falha. */
abstract class ScopedCache {
  protected readonly logger = new Logger('Cache');

  constructor(
    protected readonly store: CacheStore,
    protected readonly appEnv: string,
  ) {}

  /** Chave completa (`cf:{env}:{escopo}:{módulo}:{chave}`). */
  abstract keyFor(module: string, key: string): string;

  protected relative(module: string, key: string): string {
    if (!MODULE.test(module)) throw new CacheKeyError(`módulo de cache inválido: ${module}`);
    if (!KEY.test(key)) throw new CacheKeyError('chave de cache inválida');
    return `${module}:${key}`;
  }

  async get<T>(module: string, key: string, schema: z.ZodType<T>): Promise<T | null> {
    const raw = await this.store.get(this.keyFor(module, key));
    if (raw === null) return null;
    try {
      const parsed = schema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Valores crus (JSON) de várias chaves do módulo numa ida ao Redis (`MGET`) — leituras que
   * precisam de um retrato coerente de chaves relacionadas (ex.: permissões efetivas e os tokens
   * de geração — US-097). Erro do Redis propaga (quem chama degrada).
   */
  async getMany(module: string, keys: readonly string[]): Promise<(string | null)[]> {
    const fullKeys = keys.map((key) => this.keyFor(module, key));
    if (this.store.getMany) return this.store.getMany(fullKeys);
    const values: (string | null)[] = [];
    for (const key of fullKeys) values.push(await this.store.get(key));
    return values;
  }

  /** Grava um valor cru (string), sem serialização — tokens de geração (US-097). */
  async setRaw(
    module: string,
    key: string,
    value: string,
    options: CacheWriteOptions,
  ): Promise<void> {
    assertTtl(options.ttlSeconds);
    await this.store.set(this.keyFor(module, key), value, options.ttlSeconds);
  }

  async set(
    module: string,
    key: string,
    value: unknown,
    options: CacheWriteOptions,
  ): Promise<void> {
    assertTtl(options.ttlSeconds);
    await this.store.set(this.keyFor(module, key), JSON.stringify(value), options.ttlSeconds);
  }

  async delete(module: string, key: string): Promise<void> {
    await this.store.delete(this.keyFor(module, key));
  }

  /**
   * Lê do cache ou carrega e grava. Cache fora do ar não derruba a operação: `warn
   * cache.unavailable` e o valor vem de `load` (CA-T-07).
   */
  async getOrSet<T>(
    module: string,
    key: string,
    load: () => Promise<T>,
    options: CacheReadThroughOptions<T>,
  ): Promise<T> {
    assertTtl(options.ttlSeconds);
    const fullKey = this.keyFor(module, key);
    try {
      const cached = await this.get(module, key, options.schema);
      if (cached !== null) return cached;
    } catch (error) {
      this.unavailable(module, error);
      return load();
    }
    const value = await load();
    try {
      await this.store.set(fullKey, JSON.stringify(value), options.ttlSeconds);
    } catch (error) {
      this.unavailable(module, error);
    }
    return value;
  }

  private unavailable(module: string, error: unknown): void {
    this.logger.warn(
      { event: 'cache.unavailable', module, errorName: error instanceof Error ? error.name : null },
      'cache.unavailable',
    );
  }
}

/** Cache de dados de tenant: o tenant vem SEMPRE do contexto (sem contexto → falha fechada). */
@Injectable()
export class TenantCache extends ScopedCache {
  constructor(@Inject(CACHE_STORE) store: CacheStore, @Inject(APP_CONFIG) config: AppConfig) {
    super(store, config.appEnv);
  }

  keyFor(module: string, key: string): string {
    // Chave já com escopo (`cf:…`) indica tentativa de endereçar outro tenant (V-08).
    if (key.startsWith('cf:') || key.startsWith('t:') || key.startsWith('p:')) {
      throw tenantIsolationViolation('cache', 'scoped_key_passed', { module });
    }
    const { tenantId } = TenantContext.getOrThrow('cache', { module });
    return `cf:${this.appEnv}:t:${tenantId}:${this.relative(module, key)}`;
  }
}

/** Cache de dados de plataforma (status de tenant, catálogos globais): sem tenant na chave. */
@Injectable()
export class PlatformCache extends ScopedCache {
  constructor(@Inject(CACHE_STORE) store: CacheStore, @Inject(APP_CONFIG) config: AppConfig) {
    super(store, config.appEnv);
  }

  keyFor(module: string, key: string): string {
    return `cf:${this.appEnv}:p:${this.relative(module, key)}`;
  }
}
