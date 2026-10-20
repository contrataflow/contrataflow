import type { Prisma } from './generated/prisma/client.js';

/** O mesmo `TenantTx` de `tenant-transaction.ts` (sem importá-lo: evita o ciclo). */
type TenantTx = Prisma.TransactionClient;

/**
 * Clientes de transação em uso (V-03 da US-073): a `TenantTransaction`/`PlatformTransaction`
 * registra o `tx` ao abrir e o retira ao confirmar ou desfazer. Quem exige estar dentro da
 * transação do caso de uso (o `AuditService`) recusa um `tx` que não está aqui — o cliente raiz,
 * um objeto qualquer ou o `tx` de uma transação já encerrada.
 */
const active = new WeakSet<object>();

export function isActiveTransaction(tx: unknown): boolean {
  return typeof tx === 'object' && tx !== null && active.has(tx);
}

/** Uso exclusivo de `shared/database/**`: marca o `tx` como ativo durante `work`. */
export async function trackTransaction<T>(tx: TenantTx, work: () => Promise<T>): Promise<T> {
  active.add(tx);
  try {
    return await work();
  } finally {
    active.delete(tx);
  }
}

/**
 * Transação simulada para adaptadores em memória (modo de identidade fake e testes): um `tx`
 * sentinela, sem banco, ativo só durante `work`.
 */
export function runSimulatedTransaction<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
  const tx = Object.freeze({}) as TenantTx;
  return trackTransaction(tx, () => work(tx));
}
