/*
 * Disjuntor do provedor de IA (RN-AI-08): a regra fica no shared kernel (`#shared/ai/
 * ai-circuit-store.ts`) porque o adaptador Redis de `platform` e o adaptador em memória a espelham;
 * o `ai` a reexporta para o seu domínio.
 */
export {
  AI_CIRCUIT_POLICY,
  CLOSED_CIRCUIT,
  circuitRetryAfterSeconds,
  isCircuitOpen,
  recordCircuitFailure,
} from '#shared/ai/ai-circuit-store.js';
export type { AiCircuitSnapshot as AiCircuitState } from '#shared/ai/ai-circuit-store.js';
