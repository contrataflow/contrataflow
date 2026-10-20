/*
 * Diferenças de texto por parágrafo para o "Ver diferenças" do diálogo de conflito (US-015 ·
 * FA-01): LCS sobre as linhas do texto puro das duas versões. Cada trecho diz se é igual,
 * removido (só no servidor) ou inserido (só no local) — a tela marca com texto ("inserido",
 * "removido"), nunca só com cor.
 */

export interface TextDiffPart {
  readonly kind: 'same' | 'removed' | 'inserted';
  readonly text: string;
}

/** Acima disto (linhas × linhas) a comparação vira "tudo removido + tudo inserido". */
const MAX_CELLS = 4_000_000;

export function diffParagraphs(before: string, after: string): TextDiffPart[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text) => ({ kind: 'removed' as const, text })),
      ...b.map((text) => ({ kind: 'inserted' as const, text })),
    ];
  }
  // lengths[i][j] = LCS de a[i..] e b[j..].
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = lengths[i];
      if (row === undefined) continue;
      row[j] =
        a[i] === b[j]
          ? (lengths[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(lengths[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const parts: TextDiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      parts.push({ kind: 'same', text: a[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((lengths[i + 1]?.[j] ?? 0) >= (lengths[i]?.[j + 1] ?? 0)) {
      parts.push({ kind: 'removed', text: a[i] ?? '' });
      i += 1;
    } else {
      parts.push({ kind: 'inserted', text: b[j] ?? '' });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) parts.push({ kind: 'removed', text: a[i] ?? '' });
  for (; j < b.length; j += 1) parts.push({ kind: 'inserted', text: b[j] ?? '' });
  return parts;
}
