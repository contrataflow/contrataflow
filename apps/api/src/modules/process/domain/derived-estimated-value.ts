import type { EstimatedValueSource } from '@contrataflow/validation';

/*
 * Valor estimado derivado de documento (DEC-032 · RN-PROC-10/63): `Process.estimatedValue` segue a
 * fonte de maior precedência — TR aprovado > pesquisa de preços concluída > ETP > DFD > manual. Um
 * documento grava o valor quando a origem atual não tem precedência maior que a dele. Puro.
 */

const PRECEDENCE: Readonly<Record<EstimatedValueSource, number>> = {
  MANUAL: 0,
  DFD: 1,
  ETP: 2,
  PRICE_RESEARCH: 3,
  TERM: 4,
};

/** A fonte `incoming` pode substituir o valor de origem `current` (`null` = sem valor/origem). */
export function acceptsDerivedEstimatedValue(
  current: EstimatedValueSource | null,
  incoming: EstimatedValueSource,
): boolean {
  return current === null || PRECEDENCE[incoming] >= PRECEDENCE[current];
}
