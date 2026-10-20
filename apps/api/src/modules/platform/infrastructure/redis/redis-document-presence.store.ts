import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import type {
  DocumentPresenceEntry,
  DocumentPresenceKey,
  DocumentPresenceStorePort,
  DocumentPresenceTouch,
} from '#shared/document/document-presence.js';

import { RedisClient } from './redis.client.js';

/**
 * Heartbeat numa única ida ao Redis, atômico (Concorrência: dois editores no mesmo segundo nunca
 * apagam a entrada um do outro). KEYS[1] = `ZSET` usuário → último heartbeat (ms); KEYS[2] = `HASH`
 * com `<userId>:s` (seção) e `<userId>:t` (desde quando, ms). ARGV = usuário, agora (ms), TTL (ms),
 * seção (`''` = mantém a anterior). Poda (`ZRANGEBYSCORE` + `ZREMRANGEBYSCORE`) → grava → renova o
 * TTL das duas chaves → devolve `[usuário, seção, desde, último, …]`.
 */
const TOUCH_SCRIPT = `
local now = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local cutoff = now - ttl
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', cutoff)
for _, user in ipairs(expired) do
  redis.call('HDEL', KEYS[2], user .. ':s', user .. ':t')
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
local user = ARGV[1]
local present = redis.call('ZSCORE', KEYS[1], user)
local previous = redis.call('HGET', KEYS[2], user .. ':s') or ''
local section = ARGV[4]
if section == '' then section = previous end
if not present or section ~= previous then
  redis.call('HSET', KEYS[2], user .. ':t', ARGV[2])
end
redis.call('HSET', KEYS[2], user .. ':s', section)
redis.call('ZADD', KEYS[1], now, user)
redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('PEXPIRE', KEYS[2], ttl)
local members = redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')
local result = {}
for index = 1, #members, 2 do
  local member = members[index]
  table.insert(result, member)
  table.insert(result, redis.call('HGET', KEYS[2], member .. ':s') or '')
  table.insert(result, redis.call('HGET', KEYS[2], member .. ':t') or members[index + 1])
  table.insert(result, members[index + 1])
end
return result
`;

/** Saída: remove o usuário do conjunto e as suas duas entradas do `HASH`. */
const REMOVE_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1] .. ':s', ARGV[1] .. ':t')
return 1
`;

/**
 * Presença de edição no Redis principal (US-070 · DEC-055 · RN-DOC-88/91): chaves
 * `cf:{env}:t:{tenantId}:presence:document:{documentId}` (`ZSET`) e `…:sections` (`HASH`), sempre
 * prefixadas pelo tenant do contexto e com TTL de 60 s renovado a cada heartbeat — sem heartbeat, as
 * duas somem sozinhas. Erro do Redis propaga: o caso de uso falha aberto (RN-DOC-92).
 */
@Injectable()
export class RedisDocumentPresenceStore implements DocumentPresenceStorePort {
  constructor(
    private readonly client: RedisClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private keysOf(key: DocumentPresenceKey): [string, string] {
    const base = `cf:${this.config.appEnv}:t:${key.tenantId}:presence:document:${key.documentId}`;
    return [base, `${base}:sections`];
  }

  async touch(input: DocumentPresenceTouch): Promise<readonly DocumentPresenceEntry[]> {
    const raw = (await this.client.redis.eval(
      TOUCH_SCRIPT,
      2,
      ...this.keysOf(input),
      input.userId,
      String(input.now.getTime()),
      String(input.ttlMs),
      input.sectionKey ?? '',
    )) as string[];
    const entries: DocumentPresenceEntry[] = [];
    for (let index = 0; index + 3 < raw.length; index += 4) {
      const [userId = '', sectionKey = '', since = '0', lastSeenAt = '0'] = raw.slice(
        index,
        index + 4,
      );
      entries.push({
        userId,
        sectionKey: sectionKey === '' ? null : sectionKey,
        since: new Date(Number(since)),
        lastSeenAt: new Date(Number(lastSeenAt)),
      });
    }
    return entries;
  }

  async remove(input: DocumentPresenceKey & { readonly userId: string }): Promise<void> {
    await this.client.redis.eval(REMOVE_SCRIPT, 2, ...this.keysOf(input), input.userId);
  }
}
