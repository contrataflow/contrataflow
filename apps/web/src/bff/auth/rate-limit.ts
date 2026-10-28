import 'server-only';

/*
 * Limite de tentativas de login por IP (RN-IAM-15 · api.md §1.6): 20 req/min em
 * `/api/auth/login`, `/api/auth/callback` e `/api/auth/step-up`, janela fixa de 1 min no Redis de
 * sessões (`cf:{env}:rl:auth:{ip}:{janela}`). Falha do Redis → falha aberta (o WAF continua
 * limitando por IP); sem IP conhecido (sem balanceador — só local), não limita. O login nativo
 * (DEC-187) usa o mesmo mecanismo para as falhas por usuário (`peek` + `record`).
 */

export interface RateLimitCounter {
  /** Incrementa o contador da janela e devolve o total. */
  hit(key: string, windowMs: number): Promise<number>;
  /** Total da janela sem incrementar (limite que só conta falhas — DEC-187). */
  peek(key: string): Promise<number>;
}

/** Subconjunto do ioredis usado pelo contador. */
export interface RateLimitRedis {
  incr(key: string): Promise<number>;
  pexpire(key: string, ttlMs: number): Promise<number>;
  get(key: string): Promise<string | null>;
}

export class RedisRateLimitCounter implements RateLimitCounter {
  constructor(private readonly redis: RateLimitRedis) {}

  async hit(key: string, windowMs: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.pexpire(key, windowMs);
    return count;
  }

  async peek(key: string): Promise<number> {
    return Number((await this.redis.get(key)) ?? 0);
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

  peek(key: string): Promise<number> {
    return Promise.resolve(this.counts.get(key) ?? 0);
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

  /** Conta a tentativa e decide (limite de tentativas: toda chamada conta). */
  async check(subject: string | null): Promise<RateLimitVerdict> {
    if (!subject) return { allowed: true };
    const window = this.window();
    let count: number;
    try {
      count = await this.counter.hit(this.key(subject, window.start), this.windowMs);
    } catch (error) {
      this.options.onError?.(error);
      return { allowed: true };
    }
    return count <= this.options.limit ? { allowed: true } : this.denied(window);
  }

  /**
   * Decide sem contar (limite de falhas — DEC-187): bloqueia quando a janela já tem `limit`
   * falhas registradas por `record`.
   */
  async peek(subject: string): Promise<RateLimitVerdict> {
    const window = this.window();
    let count: number;
    try {
      count = await this.counter.peek(this.key(subject, window.start));
    } catch (error) {
      this.options.onError?.(error);
      return { allowed: true };
    }
    return count < this.options.limit ? { allowed: true } : this.denied(window);
  }

  /** Registra uma falha (falha aberta se o contador estiver fora). */
  async record(subject: string): Promise<void> {
    try {
      await this.counter.hit(this.key(subject, this.window().start), this.windowMs);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private window(): { readonly now: number; readonly start: number } {
    const now = this.now();
    return { now, start: Math.floor(now / this.windowMs) * this.windowMs };
  }

  private key(subject: string, windowStart: number): string {
    return `${this.options.keyPrefix}${subject}:${windowStart}`;
  }

  private denied(window: { readonly now: number; readonly start: number }): RateLimitVerdict {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((window.start + this.windowMs - window.now) / 1000)),
    };
  }
}
