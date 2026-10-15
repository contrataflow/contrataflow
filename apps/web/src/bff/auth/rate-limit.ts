import 'server-only';

/*
 * Limite de tentativas de login por IP (RN-IAM-15 · api.md §1.6): 20 req/min em
 * `/api/auth/login`, `/api/auth/callback` e `/api/auth/step-up`, janela fixa de 1 min no Redis de
 * sessões (`cf:{env}:rl:auth:{ip}:{janela}`). Falha do Redis → falha aberta (o WAF continua
 * limitando por IP); sem IP conhecido (sem balanceador — só local), não limita.
 */

export interface RateLimitCounter {
  /** Incrementa o contador da janela e devolve o total. */
  hit(key: string, windowMs: number): Promise<number>;
}

/** Subconjunto do ioredis usado pelo contador. */
export interface RateLimitRedis {
  incr(key: string): Promise<number>;
  pexpire(key: string, ttlMs: number): Promise<number>;
}

export class RedisRateLimitCounter implements RateLimitCounter {
  constructor(private readonly redis: RateLimitRedis) {}

  async hit(key: string, windowMs: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.pexpire(key, windowMs);
    return count;
  }
}

/** Contador em memória do processo (local/dev/test sem Redis de sessões). */
export class MemoryRateLimitCounter implements RateLimitCounter {
  private readonly counts = new Map<string, number>();

  hit(key: string): Promise<number> {
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    if (this.counts.size > 10_000) this.counts.clear();
    return Promise.resolve(count);
  }
}

export type RateLimitVerdict =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface AuthRateLimiterOptions {
  readonly limit: number;
  /** `cf:{env}:rl:auth:`. */
  readonly keyPrefix: string;
  readonly windowMs?: number;
  readonly now?: () => number;
  /** Chamado quando o contador falha (a requisição segue — falha aberta). */
  readonly onError?: (error: unknown) => void;
}

export class AuthRateLimiter {
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(
    private readonly counter: RateLimitCounter,
    private readonly options: AuthRateLimiterOptions,
  ) {
    this.windowMs = options.windowMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  async check(ip: string | null): Promise<RateLimitVerdict> {
    if (!ip) return { allowed: true };
    const now = this.now();
    const windowStart = Math.floor(now / this.windowMs) * this.windowMs;
    let count: number;
    try {
      count = await this.counter.hit(
        `${this.options.keyPrefix}${ip}:${windowStart}`,
        this.windowMs,
      );
    } catch (error) {
      this.options.onError?.(error);
      return { allowed: true };
    }
    if (count <= this.options.limit) return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((windowStart + this.windowMs - now) / 1000)),
    };
  }
}
