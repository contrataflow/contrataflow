import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Escopo da transação em curso (US-100): `TENANT` com o tenant do `set_config('app.tenant_id')` ou
 * `PLATFORM` (sem tenant). A extensão de isolamento do Prisma lê daqui o tenant a injetar e
 * conferir — o da TRANSAÇÃO, não o da requisição: um caso de uso `PLATFORM` abre transação para um
 * tenant alvo (FA-02). Fora de qualquer transação não há escopo: operação em modelo de tenant ou SQL
 * bruto falha antes do banco (FA-04 · V-06).
 */
export interface TransactionScope {
  readonly kind: 'TENANT' | 'PLATFORM';
  readonly tenantId: string | null;
}

const storage = new AsyncLocalStorage<TransactionScope>();

/** Uso exclusivo de `shared/database/**`: executa `fn` (a transação) no escopo informado. */
export function runInTransactionScope<T>(
  scope: TransactionScope,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(scope, fn);
}

export function currentTransactionScope(): TransactionScope | undefined {
  return storage.getStore();
}
