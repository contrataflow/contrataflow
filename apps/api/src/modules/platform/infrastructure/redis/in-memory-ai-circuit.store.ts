import { CLOSED_CIRCUIT, recordCircuitFailure } from '#shared/ai/ai-circuit-store.js';
import type { AiCircuitSnapshot, AiCircuitStorePort } from '#shared/ai/ai-circuit-store.js';

/**
 * Disjuntor do provedor de IA em memória (modo de identidade fake e testes): a mesma regra do
 * adaptador Redis, num único processo. `down` simula o armazenamento indisponível.
 */
export class InMemoryAiCircuitStore implements AiCircuitStorePort {
  private state: AiCircuitSnapshot = CLOSED_CIRCUIT;
  down = false;

  read(): Promise<AiCircuitSnapshot> {
    if (this.down) return Promise.reject(new Error('circuit store down'));
    return Promise.resolve(this.state);
  }

  recordFailure(now: number): Promise<AiCircuitSnapshot> {
    if (this.down) return Promise.reject(new Error('circuit store down'));
    this.state = recordCircuitFailure(this.state, now);
    return Promise.resolve(this.state);
  }

  recordSuccess(): Promise<void> {
    if (this.down) return Promise.reject(new Error('circuit store down'));
    this.state = CLOSED_CIRCUIT;
    return Promise.resolve();
  }

  /** Testes: estado atual. */
  snapshot(): AiCircuitSnapshot {
    return this.state;
  }
}
