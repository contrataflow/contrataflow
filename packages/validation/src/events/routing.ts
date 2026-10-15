/*
 * Padrões de assinatura por routing key (queues.md §7.1): segmentos separados por `.`; `*` no meio
 * casa exatamente um segmento e `*` no fim casa um ou mais — `process.*` cobre `process.created` e
 * `process.stage_changed.forward`. Usado pelo fan-out do worker e pelos handlers síncronos da API.
 */

export function matchesRoutingKey(pattern: string, routingKey: string): boolean {
  const expected = pattern.split('.');
  const actual = routingKey.split('.');
  for (const [index, segment] of expected.entries()) {
    const isLast = index === expected.length - 1;
    if (segment === '*') {
      if (isLast) return actual.length > index;
      if (actual[index] === undefined) return false;
      continue;
    }
    if (actual[index] !== segment) return false;
  }
  return actual.length === expected.length;
}

/** `true` se algum dos padrões casa a routing key. */
export function matchesAnyRoutingKey(patterns: readonly string[], routingKey: string): boolean {
  return patterns.some((pattern) => matchesRoutingKey(pattern, routingKey));
}
