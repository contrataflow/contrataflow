import { DependencyUnavailableError, isConnectionError } from './job-errors.js';

/*
 * Circuit breaker por dependência (queues.md §10.3): depois de `failureThreshold` falhas seguidas
 * de conexão, abre por `openMs` (30 s); em seguida deixa passar UMA tentativa (meia-abertura) e
 * fecha no primeiro sucesso. Aberto, `execute` lança `DependencyUnavailableError` sem chamar a
 * dependência — o `runJob` pausa a fila sem consumir a tentativa do job.
 */

export type CircuitState = 'CLOSED' | 'HALF_OPEN' | 'OPEN';

/** Valor do gauge `cf_circuit_breaker_state` (0 fechado, 1 meia-aberto, 2 aberto). */
export const CIRCUIT_STATE_VALUE: Readonly<Record<CircuitState, number>> = {
  CLOSED: 0,
  HALF_OPEN: 1,
  OPEN: 2,
};

export interface CircuitBreakerOptions {
  readonly dependency: string;
  readonly failureThreshold?: number;
  /** Tempo aberto antes da meia-abertura (padrão 30 s). */
  readonly openMs?: number;
  /** Quais erros contam como falha da dependência (padrão: conexão/rede). */
  readonly isFailure?: (error: unknown) => boolean;
  readonly now?: () => number;
}

export class CircuitBreaker {
  readonly dependency: string;
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly isFailure: (error: unknown) => boolean;
  private readonly now: () => number;
  private failures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;

  constructor(options: CircuitBreakerOptions) {
    this.dependency = options.dependency;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.openMs = options.openMs ?? 30_000;
    this.isFailure = options.isFailure ?? isConnectionError;
    this.now = options.now ?? Date.now;
  }

  get state(): CircuitState {
    if (this.openedAt === null) return 'CLOSED';
    return this.now() - this.openedAt >= this.openMs ? 'HALF_OPEN' : 'OPEN';
  }

  /** Abre o circuito já (ex.: *health check* da dependência falhou). */
  trip(): void {
    this.openedAt = this.now();
    this.failures = this.failureThreshold;
  }

  reset(): void {
    this.openedAt = null;
    this.failures = 0;
    this.trialInFlight = false;
  }

  async execute<T>(work: () => Promise<T>): Promise<T> {
    const state = this.state;
    if (state === 'OPEN' || (state === 'HALF_OPEN' && this.trialInFlight)) {
      throw new DependencyUnavailableError(this.dependency);
    }
    const trial = state === 'HALF_OPEN';
    if (trial) this.trialInFlight = true;
    try {
      const result = await work();
      this.reset();
      return result;
    } catch (error) {
      if (this.isFailure(error)) {
        this.failures += 1;
        if (trial || this.failures >= this.failureThreshold) this.openedAt = this.now();
      }
      throw error;
    } finally {
      if (trial) this.trialInFlight = false;
    }
  }
}
