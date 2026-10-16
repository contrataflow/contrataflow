/*
 * Heurística de possível duplicidade (US-001 · FA-02 · RN-PROC-13): processo com título OU objeto
 * semelhante (similaridade trigram ≥ 0,6), criado pelo MESMO usuário ou para o MESMO setor
 * solicitante, dentro da janela `process.duplicateDetectionWindowMinutes` (0 desativa). No banco a
 * similaridade é a `similarity()` do `pg_trgm`; esta implementação reproduz o mesmo cálculo para o
 * repositório em memória e para os testes de limiar.
 */

/** Similaridade mínima (inclusive) para apontar candidato (FA-02). */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.6;

/** Máximo de candidatos devolvidos (os mais recentes primeiro). */
export const DUPLICATE_CANDIDATES_LIMIT = 10;

const WORD = /[\p{L}\p{N}]+/gu;

/**
 * Trigramas como o `pg_trgm` (`show_trgm`): palavras = sequências alfanuméricas em minúsculas, cada
 * uma com dois espaços antes e um depois; conjunto dos trechos de 3 caracteres.
 */
export function trigrams(text: string): Set<string> {
  const result = new Set<string>();
  for (const word of text.toLowerCase().match(WORD) ?? []) {
    const chars = Array.from(`  ${word} `);
    for (let index = 0; index + 3 <= chars.length; index += 1) {
      result.add(chars.slice(index, index + 3).join(''));
    }
  }
  return result;
}

/** `similarity(a, b)` do `pg_trgm`: trigramas em comum ÷ trigramas distintos dos dois textos. */
export function trigramSimilarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let common = 0;
  for (const trigram of left) if (right.has(trigram)) common += 1;
  return common / (left.size + right.size - common);
}

export interface DuplicateProbe {
  readonly title: string;
  readonly object: string;
  readonly requestingDepartmentId: string;
  readonly createdById: string;
  /** Início da janela (agora − `duplicateDetectionWindowMinutes`). */
  readonly since: Date;
}

export interface DuplicateCandidateFacts {
  readonly title: string;
  readonly object: string;
  readonly requestingDepartmentId: string;
  readonly createdById: string;
  readonly createdAt: Date;
}

/** RN-PROC-13: o processo existente é candidato a duplicidade do que está sendo criado? */
export function isPossibleDuplicate(candidate: DuplicateCandidateFacts, probe: DuplicateProbe) {
  if (candidate.createdAt < probe.since) return false;
  const sameOrigin =
    candidate.createdById === probe.createdById ||
    candidate.requestingDepartmentId === probe.requestingDepartmentId;
  if (!sameOrigin) return false;
  return (
    trigramSimilarity(candidate.title, probe.title) >= DUPLICATE_SIMILARITY_THRESHOLD ||
    trigramSimilarity(candidate.object, probe.object) >= DUPLICATE_SIMILARITY_THRESHOLD
  );
}

/** Início da janela de detecção, ou `null` quando desativada (janela 0 — RN-PROC-13). */
export function duplicateWindowStart(now: Date, windowMinutes: number): Date | null {
  if (windowMinutes <= 0) return null;
  return new Date(now.getTime() - windowMinutes * 60_000);
}
