import { Inject, Injectable, Logger } from '@nestjs/common';

import { AI_CIRCUIT_STORE } from '#shared/ai/ai-circuit-store.js';
import type { AiCircuitStorePort } from '#shared/ai/ai-circuit-store.js';

import { AI_CLOCK } from './ports.js';
import type { AiClock } from './ports.js';
import {
  AI_CIRCUIT_POLICY,
  CLOSED_CIRCUIT,
  circuitRetryAfterSeconds,
  isCircuitOpen,
} from '../domain/circuit-breaker.js';

/*
 * Disjuntor do provedor (RN-AI-08 · FA-03): AI-01 recusa com 503 `AI_PROVIDER_UNAVAILABLE` e
 * `Retry-After` enquanto o circuito estiver aberto; o job registra falhas transitórias e sucessos.
 * O armazenamento (Redis de plataforma) indisponível não bloqueia: lê como fechado e segue.
 */

export interface AiCircuitView {
  readonly open: boolean;
  readonly retryAfterSeconds: number;
}

@Injectable()
export class AiCircuitBreaker {
  private readonly logger = new Logger('AiCircuitBreaker');

  constructor(
    @Inject(AI_CIRCUIT_STORE) private readonly store: AiCircuitStorePort,
    @Inject(AI_CLOCK) private readonly clock: AiClock,
  ) {}

  async view(): Promise<AiCircuitView> {
    const now = this.clock().getTime();
    const state = await this.store.read(now).catch((error: unknown) => {
      this.logger.warn({ event: 'ai.circuit_store_unavailable', cause: nameOf(error) });
      return CLOSED_CIRCUIT;
    });
    return {
      open: isCircuitOpen(state, now),
      retryAfterSeconds: circuitRetryAfterSeconds(state, now),
    };
  }

  async failure(errorCode: string): Promise<void> {
    const now = this.clock().getTime();
    try {
      const state = await this.store.recordFailure(now);
      if (isCircuitOpen(state, now) && state.openUntil === now + AI_CIRCUIT_POLICY.openMs) {
        this.logger.warn({
          event: 'ai.circuit_opened',
          errorCode,
          openForMs: AI_CIRCUIT_POLICY.openMs,
        });
      }
    } catch (error) {
      this.logger.warn({ event: 'ai.circuit_store_unavailable', cause: nameOf(error) });
    }
  }

  async success(): Promise<void> {
    await this.store.recordSuccess().catch((error: unknown) => {
      this.logger.warn({ event: 'ai.circuit_store_unavailable', cause: nameOf(error) });
    });
  }
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
