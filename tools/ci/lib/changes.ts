// Escopo da mudança (US-079 — FA-05): PR que toca só `docs/**` pula os estágios 4–7 e mantém 1–3.
// O filtro é feito por job (output `code`) e não por `paths-ignore` no workflow: um workflow
// ignorado não reporta nenhum check, e os required checks ficariam pendentes para sempre.

/** Prefixo dos caminhos que, sozinhos, não exigem os estágios 4–7. */
export const DOCS_ONLY_PREFIX = 'docs/';

export interface ChangeScope {
  /** `true` quando há arquivos fora de `docs/**` (ou quando não dá para saber). */
  readonly code: boolean;
  readonly docsOnly: boolean;
  readonly files: number;
}

export function classifyChanges(files: readonly string[]): ChangeScope {
  // Sem diff (rebase vazio, base desconhecida): roda tudo — nunca pula por falta de informação.
  const docsOnly = files.length > 0 && files.every((file) => file.startsWith(DOCS_ONLY_PREFIX));
  return { code: !docsOnly, docsOnly, files: files.length };
}
