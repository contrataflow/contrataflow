import type { SessionRedisClient } from './session-redis.js';

/*
 * Redis de sessões em memória para os testes unitários do consumidor de eventos de vínculo
 * (US-088): só os comandos que o protocolo usa — GET, SET NX, DEL, SMEMBERS, SREM, ZADD, ZREM.
 * O TTL é anotado, não aplicado.
 */
export class MemorySessionRedis implements SessionRedisClient {
  readonly strings = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();
  readonly zsets = new Map<string, Map<string, number>>();
  readonly ttls = new Map<string, number>();
  /** `true` simula o Redis fora: todo comando rejeita. */
  down = false;

  private run<T>(command: () => T): Promise<T> {
    if (this.down) return Promise.reject(new Error('ECONNREFUSED'));
    return Promise.resolve(command());
  }

  get(key: string): Promise<string | null> {
    return this.run(() => this.strings.get(key) ?? null);
  }

  set(key: string, value: string, _mode: 'PX', ttlMs: number): Promise<'OK' | null> {
    return this.run(() => {
      if (this.strings.has(key)) return null;
      this.strings.set(key, value);
      this.ttls.set(key, ttlMs);
      return 'OK';
    });
  }

  del(...keys: string[]): Promise<number> {
    return this.run(() => keys.filter((key) => this.strings.delete(key)).length);
  }

  smembers(key: string): Promise<string[]> {
    return this.run(() => [...(this.sets.get(key) ?? [])]);
  }

  sadd(key: string, member: string): Promise<number> {
    return this.run(() => {
      const members = this.sets.get(key) ?? new Set<string>();
      this.sets.set(key, members);
      const added = members.has(member) ? 0 : 1;
      members.add(member);
      return added;
    });
  }

  srem(key: string, ...members: string[]): Promise<number> {
    return this.run(() => members.filter((member) => this.sets.get(key)?.delete(member)).length);
  }

  zadd(key: string, score: number, member: string): Promise<number> {
    return this.run(() => {
      const scores = this.zsets.get(key) ?? new Map<string, number>();
      this.zsets.set(key, scores);
      const added = scores.has(member) ? 0 : 1;
      scores.set(member, score);
      return added;
    });
  }

  zrem(key: string, ...members: string[]): Promise<number> {
    return this.run(() => members.filter((member) => this.zsets.get(key)?.delete(member)).length);
  }
}
