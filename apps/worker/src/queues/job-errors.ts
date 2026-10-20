import { UnrecoverableError } from 'bullmq';
import { ZodError } from 'zod';

/*
 * Classificação de erros de job (RN-FND-66 · queues.md §10.2): decide entre retry com backoff,
 * pausa da fila sem consumir tentativa, falha final imediata (dead-letter) e sucesso silencioso.
 */

export type JobErrorClass =
  'TRANSIENT' | 'DEPENDENCY_DOWN' | 'PERMANENT' | 'SECURITY' | 'DUPLICATE';

/** Erro permanente: `meta`/payload inválidos, entidade inexistente, invariante violada. */
export class PermanentJobError extends Error {
  constructor(
    readonly code: string,
    message: string = code,
  ) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

/** Permanente de segurança (job sem tenant fora da lista, RLS/privilégio): falha final + alerta. */
export class SecurityJobError extends PermanentJobError {
  constructor(code: string, message: string = code) {
    super(code, message);
    this.name = 'SecurityJobError';
  }
}

/** Dependência externa fora (circuit breaker aberto): pausa a fila sem consumir tentativa. */
export class DependencyUnavailableError extends Error {
  constructor(readonly dependency: string) {
    super(`Dependência indisponível: ${dependency}`);
    this.name = 'DependencyUnavailableError';
  }
}

/** Estouro do timeout da fila (transitório — queues.md §9.2, passo 6). */
export class JobTimeoutError extends Error {
  readonly code = 'JOB_TIMEOUT';

  constructor(readonly timeoutMs: number) {
    super(`Job excedeu o timeout de ${String(timeoutMs)} ms`);
    this.name = 'JobTimeoutError';
  }
}

/** Duplicidade esperada lançada pelo handler (o efeito já existe): o job conclui como sucesso. */
export class ExpectedDuplicateError extends Error {
  constructor(message = 'Efeito já aplicado') {
    super(message);
    this.name = 'ExpectedDuplicateError';
  }
}

/** SQLSTATE do PostgreSQL tratados como transitórios (queues.md §10.2). */
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
]);

/** Erros de rede/conexão do Node (driver `pg`, ioredis, fetch). */
const CONNECTION_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Falha de conexão com o banco ou com uma dependência (não um erro da regra do handler): conta
 * para o circuit breaker e é transitória. Inclui as classes SQLSTATE 08 (conexão).
 */
export function isConnectionError(error: unknown): boolean {
  const code = codeOf(error);
  if (code !== undefined && (CONNECTION_CODES.has(code) || code.startsWith('08'))) return true;
  if (code === '57P01' || code === '57P03') return true;
  const message = error instanceof Error ? error.message : '';
  return /Connection terminated|connection timeout|timeout exceeded when trying to connect/i.test(
    message,
  );
}

export function classifyJobError(error: unknown): JobErrorClass {
  if (error instanceof DependencyUnavailableError) return 'DEPENDENCY_DOWN';
  if (error instanceof ExpectedDuplicateError) return 'DUPLICATE';
  if (error instanceof SecurityJobError) return 'SECURITY';
  if (error instanceof PermanentJobError || error instanceof UnrecoverableError) return 'PERMANENT';
  if (error instanceof ZodError) return 'PERMANENT';
  const code = codeOf(error);
  // 42501: privilégio insuficiente ou violação de política de RLS.
  if (code === '42501') return 'SECURITY';
  // 23505 na chave de idempotência: o efeito já existe (queues.md §8, camada 2).
  if (code === '23505') return 'DUPLICATE';
  if (code !== undefined && TRANSIENT_SQLSTATES.has(code)) return 'TRANSIENT';
  // Timeout, conexão e o desconhecido (`TypeError`…): transitórios até esgotar → DLQ com stack.
  return 'TRANSIENT';
}
