import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { SUPPRESSED_TTL_SECONDS } from '#shared/audit/sampling-store.js';
import type {
  AuditSamplingDecision,
  AuditSamplingKey,
  AuditSamplingStorePort,
} from '#shared/audit/sampling-store.js';

import { RedisClient } from './redis.client.js';

/**
 * Conta a ocorrência na janela (KEYS[1], expira com a janela) e decide numa única ida ao Redis:
 * dentro do limite → grava e consome o excedente acumulado (KEYS[2]); acima → acumula.
 */
const SAMPLE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if count <= tonumber(ARGV[2]) then
  local pending = tonumber(redis.call('GETDEL', KEYS[2]) or '0')
  return { 1, pending }
end
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return { 0, 0 }
`;

/**
 * Amostragem de `access.denied` no Redis principal (RN-AUD-07 · multi-tenancy.md §7): chaves
 * `cf:{env}:t:{tenantId}:audit:ad:{hash}` (ou `cf:{env}:p:audit:ad:{hash}` na plataforma), com o
 * usuário/IP só como hash. Erro do Redis propaga: o `AuditService` grava sem amostragem.
 */
@Injectable()
export class RedisAuditSamplingStore implements AuditSamplingStorePort {
  constructor(
    private readonly client: RedisClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async sample(
    key: AuditSamplingKey,
    windowSeconds: number,
    maxPerWindow: number,
  ): Promise<AuditSamplingDecision> {
    const scope = key.tenantId ? `t:${key.tenantId}` : 'p';
    const digest = createHash('sha256').update(`${key.subject}|${key.action}`).digest('hex');
    const base = `cf:${this.config.appEnv}:${scope}:audit:ad:${digest}`;
    const window = Math.floor(Date.now() / (windowSeconds * 1_000));
    const [record, suppressed] = (await this.client.redis.eval(
      SAMPLE_SCRIPT,
      2,
      `${base}:${window}`,
      `${base}:suppressed`,
      String(windowSeconds * 1_000),
      String(maxPerWindow),
      String(SUPPRESSED_TTL_SECONDS),
    )) as [number, number];
    return { record: record === 1, suppressed };
  }
}
