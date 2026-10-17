import { Inject, Injectable } from '@nestjs/common';

import { FILES_CLOCK } from './files-ports.js';
import type { FilesClock } from './files-ports.js';

/*
 * Disjuntor do ClamAV (US-068 · RN-DOC-75 · queues.md §4.5/§10.3): depois de 5 falhas seguidas de
 * conexão, abre por 30 s; em seguida deixa passar UMA varredura (meia-abertura) e fecha no primeiro
 * sucesso. Aberto, a varredura nem lê a quarentena: o job pausa sem consumir tentativa e o anexo
 * fica retido em `SCANNING` — nunca liberado sem antivírus (P3). Estado por processo (o worker
 * de `file-scan` é um perfil só no MVP 1 — queues.md §14).
 */

export const ANTIVIRUS_CIRCUIT_POLICY = { failureThreshold: 5, openMs: 30_000 } as const;

export type AntivirusCircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

@Injectable()
export class AntivirusCircuit {
  private failures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;

  constructor(@Inject(FILES_CLOCK) private readonly clock: FilesClock) {}

  get state(): AntivirusCircuitState {
    if (this.openedAt === null) return 'CLOSED';
    return this.clock().getTime() - this.openedAt >= ANTIVIRUS_CIRCUIT_POLICY.openMs
      ? 'HALF_OPEN'
      : 'OPEN';
  }

  /** Pode tentar agora? Na meia-abertura, só uma varredura por vez. */
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
    if (trial || this.failures >= ANTIVIRUS_CIRCUIT_POLICY.failureThreshold) {
      this.openedAt = this.clock().getTime();
    }
  }

  /** Segundos até a próxima meia-abertura (0 = fechado ou já meio-aberto). */
  retryAfterSeconds(): number {
    if (this.openedAt === null) return 0;
    const remaining = this.openedAt + ANTIVIRUS_CIRCUIT_POLICY.openMs - this.clock().getTime();
    return Math.max(0, Math.ceil(remaining / 1000));
  }
}
