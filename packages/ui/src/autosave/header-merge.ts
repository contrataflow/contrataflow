/*
 * Merge automático do cabeçalho tipado depois de um 412 (US-015 · FA-02 · RN-DFD-28): compara a
 * base (o que o cliente tinha do servidor), o local (o que a pessoa alterou) e o servidor atual
 * (`meta.current`). Sem interseção entre os campos alterados dos dois lados, o reenvio é
 * silencioso com o novo `ETag`; com interseção, os campos em comum vão para o diálogo por campo.
 * Campos "última gravação vence" (ex.: `wizardStep`) nunca conflitam; campos "união" (ex.:
 * `completedSteps`) juntam os dois lados. Genérico: ETP (ETP-04), TR (TRM-04) e documentos livres
 * (DOC-04) usam o mesmo merge com as suas listas de campos.
 */

export type HeaderValues = Readonly<Record<string, unknown>>;

export interface HeaderMergeRules {
  /** Campos em que a gravação local sempre vence (sem conflito). */
  readonly lastWriteWins?: readonly string[];
  /** Campos-lista unidos dos dois lados (sem repetição, na ordem de `unionOrder` se houver). */
  readonly union?: readonly string[];
  readonly unionOrder?: Readonly<Record<string, readonly unknown[]>>;
}

export interface HeaderMergeResult {
  /** Campos alterados localmente E no servidor com valores diferentes (diálogo por campo). */
  readonly conflicts: readonly string[];
  /** O que reenviar sobre o servidor atual (campos locais + uniões), sem os conflitos. */
  readonly patch: Readonly<Record<string, unknown>>;
}

export function sameHeaderValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameHeaderValue(item, b[index]));
  }
  return a === b || (a === undefined && b === null) || (a === null && b === undefined);
}

/** Campos em que `next` difere de `base` (só os de `fields`). */
export function changedHeaderFields(
  base: HeaderValues,
  next: HeaderValues,
  fields: readonly string[],
): string[] {
  return fields.filter((field) => !sameHeaderValue(base[field], next[field]));
}

export function mergeHeader(
  input: {
    readonly base: HeaderValues;
    readonly local: HeaderValues;
    readonly server: HeaderValues;
    readonly fields: readonly string[];
  },
  rules: HeaderMergeRules = {},
): HeaderMergeResult {
  const lastWriteWins = new Set(rules.lastWriteWins ?? []);
  const union = new Set(rules.union ?? []);
  const localChanged = changedHeaderFields(input.base, input.local, input.fields);
  const serverChanged = new Set(changedHeaderFields(input.base, input.server, input.fields));
  const conflicts: string[] = [];
  const patch: Record<string, unknown> = {};
  for (const field of localChanged) {
    if (union.has(field)) {
      const values = [
        ...(Array.isArray(input.server[field]) ? (input.server[field] as unknown[]) : []),
        ...(Array.isArray(input.local[field]) ? (input.local[field] as unknown[]) : []),
      ];
      const order = rules.unionOrder?.[field];
      const unique = [...new Set(values)];
      patch[field] = order === undefined ? unique : order.filter((item) => unique.includes(item));
      continue;
    }
    if (
      !lastWriteWins.has(field) &&
      serverChanged.has(field) &&
      !sameHeaderValue(input.local[field], input.server[field])
    ) {
      conflicts.push(field);
      continue;
    }
    patch[field] = input.local[field];
  }
  return { conflicts, patch };
}
