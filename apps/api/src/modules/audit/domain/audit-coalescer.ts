/*
 * Coalescência de ações de alto volume (RN-AUD-06 · FA-05 — ex.: `document.draft_update`): dentro
 * da janela do último registro gravado da mesma chave (tenant, entidade, escopo, ator, ação), a
 * chamada é descartada — salvo salto de revisão ou de tamanho, que grava um registro novo e
 * reinicia a janela. A janela em si é o filtro da consulta do último registro.
 */

export interface CoalescePolicy {
  readonly windowMs: number;
  readonly maxRevisionGap: number;
  readonly maxSizeVariationPct: number;
}

/** Revisão e tamanho do conteúdo no último registro gravado / na chamada atual. */
export interface CoalesceState {
  readonly revision: number;
  readonly size: number;
}

export function sizeVariationPct(previous: number, current: number): number {
  return (Math.abs(current - previous) / Math.max(previous, 1)) * 100;
}

/**
 * `true` = descartar (o registro anterior representa a chamada); `false` = gravar. Sem registro na
 * janela, grava. Revisão que volta (nova versão do documento) conta como salto.
 */
export function shouldCoalesce(
  last: CoalesceState | null,
  current: CoalesceState,
  policy: Pick<CoalescePolicy, 'maxRevisionGap' | 'maxSizeVariationPct'>,
): boolean {
  if (last === null) return false;
  if (Math.abs(current.revision - last.revision) > policy.maxRevisionGap) return false;
  return sizeVariationPct(last.size, current.size) <= policy.maxSizeVariationPct;
}

/** Lê o estado gravado em `metadata.coalesce`; formato inesperado → sem estado (grava). */
export function coalesceStateFrom(value: unknown): CoalesceState | null {
  if (value === null || typeof value !== 'object') return null;
  const { revision, size } = value as { revision?: unknown; size?: unknown };
  return typeof revision === 'number' && typeof size === 'number' ? { revision, size } : null;
}
