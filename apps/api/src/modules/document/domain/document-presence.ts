/*
 * Regra pura do indicador de edição concorrente (US-070 · RN-DOC-89/90): quem aparece para o
 * chamador. O armazenamento já poda as presenças expiradas; a regra confere de novo (relógios do
 * Redis e da API podem divergir em milissegundos) e nunca devolve o próprio chamador.
 */

export interface PresenceRecord {
  readonly userId: string;
  readonly sectionKey: string | null;
  readonly since: Date;
  readonly lastSeenAt: Date;
}

/** Ativa = heartbeat nos últimos `ttlMs` (RN-DOC-89: sem heartbeat por 60 s, deixa de aparecer). */
export function isPresenceActive(record: PresenceRecord, now: Date, ttlMs: number): boolean {
  return record.lastSeenAt.getTime() > now.getTime() - ttlMs;
}

/**
 * Os demais editores ativos (RN-DOC-90): sem o chamador, sem os expirados, um por usuário, em ordem
 * de chegada à seção (o mais antigo primeiro) e, no empate, pelo id — resposta estável.
 */
export function otherActiveEditors<T extends PresenceRecord>(
  records: readonly T[],
  callerId: string,
  now: Date,
  ttlMs: number,
): T[] {
  const byUser = new Map<string, T>();
  for (const record of records) {
    if (record.userId === callerId || !isPresenceActive(record, now, ttlMs)) continue;
    const seen = byUser.get(record.userId);
    if (seen === undefined || seen.lastSeenAt < record.lastSeenAt)
      byUser.set(record.userId, record);
  }
  return [...byUser.values()].sort(
    (a, b) => a.since.getTime() - b.since.getTime() || a.userId.localeCompare(b.userId),
  );
}
