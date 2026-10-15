import { ApiError } from '#shared/errors/api-error.js';

/**
 * Transação aberta sem tenant no contexto (RN-FND-43). Erro de programação, nunca comportamento
 * esperado: falha fechada antes de tocar no banco — vira 500 `INTERNAL_ERROR` (architecture.md §6.4).
 */
export class TenantContextMissingError extends Error {
  constructor() {
    super('TenantTransaction sem tenant no contexto da requisição ou do job.');
    this.name = 'TenantContextMissingError';
  }
}

export interface VersionedTarget {
  /** Agregado (`Process`, `Dfd`…), para o log `db.optimistic_concurrency_conflict`. */
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** Versão lida pelo chamador (`If-Match` — DEC-104). */
  readonly expectedVersion: number;
}

/**
 * `UPDATE … WHERE version = @expected` afetou 0 linhas (DEC-055 · RN-FND-42): outra pessoa
 * alterou o registro. A API responde 412 `VERSION_CONFLICT` (DEC-104).
 */
export class VersionConflictError extends ApiError {
  constructor(readonly target: VersionedTarget) {
    super('VERSION_CONFLICT');
    this.name = 'VersionConflictError';
  }
}

/**
 * Banco ou pool indisponível (erro transitório): 503 `DEPENDENCY_UNAVAILABLE`. A transação não
 * chegou a confirmar nada; a nova tentativa fica a cargo do chamador (idempotência — DEC-105).
 */
export class DatabaseUnavailableError extends ApiError {
  constructor(cause: unknown) {
    super('DEPENDENCY_UNAVAILABLE', {
      detail: 'Não foi possível completar a operação agora. Tente novamente em instantes.',
      headers: { 'Retry-After': '5' },
      cause,
    });
    this.name = 'DatabaseUnavailableError';
  }
}

/** Erros do Prisma de conexão/tempo de espera (P1001 inalcançável … P2024 pool esgotado). */
const PRISMA_TRANSIENT = ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'];

/** Códigos de rede do Node e SQLSTATE de conexão/encerramento do PostgreSQL (classes 08 e 57P). */
const DRIVER_TRANSIENT = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '57P01',
  '57P02',
  '57P03',
];

/** Tipos de erro do *driver adapter* do Prisma 7 que indicam banco fora do ar. */
const ADAPTER_TRANSIENT = [
  'DatabaseNotReachable',
  'ConnectionClosed',
  'SocketTimeout',
  'TooManyConnections',
];

const TRANSIENT = new Set([...PRISMA_TRANSIENT, ...DRIVER_TRANSIENT, ...ADAPTER_TRANSIENT]);

/** Conflito de serialização/deadlock: a transação inteira pode ser refeita (architecture.md §6.4). */
const RETRYABLE = new Set(['P2034', '40001', '40P01', 'TransactionWriteConflict']);

/**
 * Mensagens do `pg` quando a conexão caiu (não trazem `code`): o servidor encerrou o processo,
 * a rede caiu ou o pool não conseguiu conectar a tempo.
 */
const CONNECTION_LOST =
  /Connection terminated|connection error and is not queryable|timeout exceeded when trying to connect/i;

/**
 * Objetos da cadeia do erro: `cause` e, no Prisma 7, `meta.driverAdapterError.cause` (onde o
 * *driver adapter* guarda o SQLSTATE do PostgreSQL).
 */
function* chain(error: unknown): Generator<Record<string, unknown>> {
  const pending: unknown[] = [error];
  for (let visited = 0; pending.length > 0 && visited < 16; visited += 1) {
    const current = pending.shift();
    if (current === null || typeof current !== 'object') continue;
    const record = current as Record<string, unknown>;
    yield record;
    pending.push(record.cause, record.meta, record.driverAdapterError);
  }
}

function codesOf(error: unknown): string[] {
  const codes: string[] = [];
  for (const item of chain(error)) {
    for (const key of ['code', 'kind', 'originalCode']) {
      const value = item[key];
      if (typeof value === 'string') codes.push(value);
    }
  }
  return codes;
}

/** O banco não respondeu ou derrubou a conexão: falha transitória, nada foi confirmado. */
export function isTransientDatabaseError(error: unknown): boolean {
  if (error instanceof ApiError) return false;
  if (codesOf(error).some((code) => TRANSIENT.has(code))) return true;
  return [...chain(error)].some(
    (item) => typeof item.message === 'string' && CONNECTION_LOST.test(item.message),
  );
}

/** Falha de serialização ou deadlock: retentável pela `TenantTransaction`. */
export function isRetryableTransactionError(error: unknown): boolean {
  return codesOf(error).some((code) => RETRYABLE.has(code));
}

/** Violação de unicidade (P2002 do Prisma ou SQLSTATE 23505): o chamador relê o estado vencedor. */
export function isUniqueViolation(error: unknown): boolean {
  return codesOf(error).some((code) => code === 'P2002' || code === '23505');
}

const MISSING_PARTITION = /no partition of relation/i;

/**
 * INSERT em tabela particionada sem partição para a linha (SQLSTATE 23514, "no partition of
 * relation … found for row") — ex.: `audit_logs` sem a partição do mês (US-073 · FA-03).
 */
export function isMissingPartitionError(error: unknown): boolean {
  return [...chain(error)].some((item) =>
    ['message', 'originalMessage'].some((key) => {
      const value = item[key];
      return typeof value === 'string' && MISSING_PARTITION.test(value);
    }),
  );
}
