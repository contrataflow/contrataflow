/*
 * Disjuntor do provedor de IA (RN-AI-08 · DEC-079, lacuna 3): 5 falhas consecutivas em 60 s abrem
 * o circuito por 60 s; um sucesso fecha e zera a contagem. Estado de PLATAFORMA (sem dado de
 * tenant), compartilhado entre API e worker na chave Redis `cf:{env}:ai:circuit`. O cliente Redis
 * fica em `modules/platform` (RM-03) e espelha esta regra num script Lua atômico; o adaptador em
 * memória (modo fake/testes) a usa diretamente. Redis fora: lê como fechado (a falha do provedor
 * continua tratada pela retentativa do job) — o disjuntor protege, não bloqueia.
 */

export interface AiCircuitSnapshot {
  readonly consecutiveFailures: number;
  /** Início da sequência de falhas (epoch ms); `null` sem falhas. */
  readonly firstFailureAt: number | null;
  /** Aberto até (epoch ms); `null` = fechado. */
  readonly openUntil: number | null;
}

export interface AiCircuitStorePort {
  read(now: number): Promise<AiCircuitSnapshot>;
  /** Registra uma falha transitória do provedor e devolve o estado resultante. */
  recordFailure(now: number): Promise<AiCircuitSnapshot>;
  /** Sucesso: fecha o circuito e zera a contagem. */
  recordSuccess(): Promise<void>;
}

export const AI_CIRCUIT_STORE = Symbol('AiCircuitStore');

export const AI_CIRCUIT_POLICY = {
  failureThreshold: 5,
  windowMs: 60_000,
  openMs: 60_000,
} as const;

export const CLOSED_CIRCUIT: AiCircuitSnapshot = {
  consecutiveFailures: 0,
  firstFailureAt: null,
  openUntil: null,
};

/** Falha do provedor (transitória: 429, 5xx, timeout, rede). */
export function recordCircuitFailure(state: AiCircuitSnapshot, now: number): AiCircuitSnapshot {
  const policy = AI_CIRCUIT_POLICY;
  const inWindow = state.firstFailureAt !== null && now - state.firstFailureAt <= policy.windowMs;
  const consecutiveFailures = inWindow ? state.consecutiveFailures + 1 : 1;
  const firstFailureAt = inWindow ? state.firstFailureAt : now;
  const opens = consecutiveFailures >= policy.failureThreshold;
  return {
    consecutiveFailures: opens ? 0 : consecutiveFailures,
    firstFailureAt: opens ? null : firstFailureAt,
    openUntil: opens ? now + policy.openMs : state.openUntil,
  };
}

export function isCircuitOpen(state: AiCircuitSnapshot, now: number): boolean {
  return state.openUntil !== null && now < state.openUntil;
}

/** Segundos até o circuito fechar (cabeçalho `Retry-After`), no mínimo 1. */
export function circuitRetryAfterSeconds(state: AiCircuitSnapshot, now: number): number {
  if (state.openUntil === null) return 1;
  return Math.max(1, Math.ceil((state.openUntil - now) / 1_000));
}
