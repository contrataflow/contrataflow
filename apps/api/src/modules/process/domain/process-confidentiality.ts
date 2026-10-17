import type { Process } from './process.js';

/*
 * Sigilo do orçamento estimado (US-013 · RN-PROC-137 · DEC-030): a flag só muda por este comando
 * (PRC-33), nunca pelo PATCH genérico. A máscara das leituras (POL-09) é aplicada na serialização
 * de cada leitura (`canViewConfidentialBudget`), não aqui.
 */

/** Quem altera e quando (a versão sobe 1 — DEC-104). */
export interface ConfidentialityChangeContext {
  readonly now: Date;
  readonly userId: string;
}

/**
 * `Process.setBudgetConfidential(flag)`: o processo com o novo sigilo e `version + 1`, ou `null`
 * quando a flag já está no estado pedido (nada a gravar, sem evento nem auditoria).
 */
export function setBudgetConfidential(
  process: Process,
  isBudgetConfidential: boolean,
  { now, userId }: ConfidentialityChangeContext,
): Process | null {
  if (process.isBudgetConfidential === isBudgetConfidential) return null;
  return {
    ...process,
    isBudgetConfidential,
    updatedAt: now,
    updatedById: userId,
    version: process.version + 1,
  };
}
