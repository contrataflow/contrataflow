import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import type { AiCircuitSnapshot, AiCircuitStorePort } from '#shared/ai/ai-circuit-store.js';

import { RedisClient } from './redis.client.js';

/*
 * Disjuntor do provedor de IA no Redis principal (DEC-079, lacuna 3): chave de PLATAFORMA
 * `cf:{env}:ai:circuit` (hash sem dado de tenant), compartilhada entre réplicas da API e o worker.
 * A regra é a do domínio do `ai` (`recordCircuitFailure`: 5 falhas em 60 s abrem por 60 s),
 * espelhada neste Lua para ser atômica entre processos — mudou lá, muda aqui. A chave expira
 * sozinha 10 min depois da última falha.
 */

const THRESHOLD = 5;
const WINDOW_MS = 60_000;
const OPEN_MS = 60_000;
const KEY_TTL_MS = 10 * 60_000;

const FAILURE_SCRIPT = `
local now = tonumber(ARGV[1])
local failures = tonumber(redis.call('HGET', KEYS[1], 'failures') or '0')
local first = tonumber(redis.call('HGET', KEYS[1], 'first') or '-1')
local openUntil = tonumber(redis.call('HGET', KEYS[1], 'openUntil') or '-1')
if first >= 0 and now - first <= tonumber(ARGV[2]) then
  failures = failures + 1
else
  failures = 1
  first = now
end
if failures >= tonumber(ARGV[3]) then
  failures = 0
  first = -1
  openUntil = now + tonumber(ARGV[4])
end
redis.call('HSET', KEYS[1], 'failures', failures, 'first', first, 'openUntil', openUntil)
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return { failures, first, openUntil }
`;

function numberOf(value: string | number | null | undefined): number {
  return value === null || value === undefined ? -1 : Number(value);
}

/** `[failures, first, openUntil]` (−1 = ausente) → estado. */
export function circuitSnapshotOf(
  values: readonly (string | number | null | undefined)[],
): AiCircuitSnapshot {
  const failures = numberOf(values[0]);
  const first = numberOf(values[1]);
  const openUntil = numberOf(values[2]);
  return {
    consecutiveFailures: Math.max(0, failures),
    firstFailureAt: first < 0 ? null : first,
    openUntil: openUntil < 0 ? null : openUntil,
  };
}

@Injectable()
export class RedisAiCircuitStore implements AiCircuitStorePort {
  private readonly key: string;

  constructor(
    private readonly client: RedisClient,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.key = `cf:${config.appEnv}:ai:circuit`;
  }

  async read(): Promise<AiCircuitSnapshot> {
    return circuitSnapshotOf(
      await this.client.redis.hmget(this.key, 'failures', 'first', 'openUntil'),
    );
  }

  async recordFailure(now: number): Promise<AiCircuitSnapshot> {
    const values = (await this.client.redis.eval(
      FAILURE_SCRIPT,
      1,
      this.key,
      String(now),
      String(WINDOW_MS),
      String(THRESHOLD),
      String(OPEN_MS),
      String(KEY_TTL_MS),
    )) as (string | number)[];
    return circuitSnapshotOf(values);
  }

  async recordSuccess(): Promise<void> {
    await this.client.redis.del(this.key);
  }
}
