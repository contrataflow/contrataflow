import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { LAST_AUDITED_TTL_SECONDS } from '#shared/audit/draft-audit.js';
import type { DraftAuditWindowStorePort } from '#shared/audit/draft-audit.js';

import { RedisClient } from './redis.client.js';

/**
 * Abre a janela (KEYS[1], `SET NX PX`) e lê a última revisão auditada (KEYS[2]) numa única ida ao
 * Redis: `{ aberta (1|0), revisão (-1 = nenhuma) }`.
 */
const OPEN_SCRIPT = `
local opened = redis.call('SET', KEYS[1], '1', 'NX', 'PX', ARGV[1])
local last = redis.call('GET', KEYS[2])
return { opened and 1 or 0, tonumber(last or '-1') }
`;

/**
 * Janela da auditoria coalescida de rascunho no Redis principal (US-015 · RN-DFD-35): chaves
 * `cf:{env}:t:{tenantId}:audit:draft:{hash}` (+ `:last`), com documento/alvo/usuário só como hash.
 * Erro do Redis propaga: o coalescedor do `audit` grava a cada salvamento (fail-safe).
 */
@Injectable()
export class RedisDraftAuditWindowStore implements DraftAuditWindowStorePort {
  constructor(
    private readonly client: RedisClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** `key` = `<tenantId>|<resto>`: o tenant fica legível no prefixo; o resto vira hash. */
  private base(key: string): string {
    const [tenantId = '-', ...rest] = key.split('|');
    const digest = createHash('sha256').update(rest.join('|')).digest('hex');
    return `cf:${this.config.appEnv}:t:${tenantId}:audit:draft:${digest}`;
  }

  async open(
    key: string,
    windowMs: number,
  ): Promise<{ readonly opened: boolean; readonly lastAuditedRevision: number | null }> {
    const base = this.base(key);
    const [opened, last] = (await this.client.redis.eval(
      OPEN_SCRIPT,
      2,
      base,
      `${base}:last`,
      String(windowMs),
    )) as [number, number];
    return { opened: opened === 1, lastAuditedRevision: last < 0 ? null : last };
  }

  async markAudited(key: string, revision: number): Promise<void> {
    await this.client.redis.set(
      `${this.base(key)}:last`,
      String(revision),
      'EX',
      LAST_AUDITED_TTL_SECONDS,
    );
  }

  async release(key: string): Promise<void> {
    await this.client.redis.del(this.base(key));
  }
}
