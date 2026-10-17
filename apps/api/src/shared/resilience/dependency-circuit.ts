/*
 * Disjuntor em processo de uma dependência externa do worker (queues.md §10.3): depois de N falhas
 * seguidas de conexão, abre por um período; em seguida deixa passar UMA chamada (meia-abertura) e
 * fecha no primeiro sucesso. Aberto, o job pausa sem consumir tentativa. Compartilhado pelo ClamAV
 * (US-068, `file-scan`) e pelo Gotenberg (US-067, `document-render`) — mesma política de 5 falhas
 * e meia-abertura em 30 s. Estado por processo (um perfil de worker por fila no MVP 1 — §14).
 */

export interface CircuitPolicy {
  readonly failureThreshold: number;
  readonly openMs: number;
}

export const DEFAULT_CIRCUIT_POLICY: CircuitPolicy = { failureThreshold: 5, openMs: 30_000 };

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class DependencyCircuit {
  private failures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;

  constructor(
    private readonly clock: () => Date,
    readonly policy: CircuitPolicy = DEFAULT_CIRCUIT_POLICY,
  ) {}

  get state(): CircuitState {
    if (this.openedAt === null) return 'CLOSED';
    return this.clock().getTime() - this.openedAt >= this.policy.openMs ? 'HALF_OPEN' : 'OPEN';
  }

  /** Pode tentar agora? Na meia-abertura, só uma chamada por vez. */
  tryAcquire(): boolean {
    const state = this.state;
    if (state === 'CLOSED') return true;
    if (state === 'OPEN' || this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.trialInFlight = false;
  }

  recordFailure(): void {
    const trial = this.trialInFlight;
    this.trialInFlight = false;
    this.failures += 1;
    if (trial || this.failures >= this.policy.failureThreshold) {
      this.openedAt = this.clock().getTime();
    }
  }

  /** Segundos até a próxima meia-abertura (0 = fechado ou já meio-aberto). */
  retryAfterSeconds(): number {
    if (this.openedAt === null) return 0;
    const remaining = this.openedAt + this.policy.openMs - this.clock().getTime();
    return Math.max(0, Math.ceil(remaining / 1000));
  }
}
