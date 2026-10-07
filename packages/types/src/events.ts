/**
 * Nomes dos eventos de domínio (PascalCase no passado — DEC-001; routing keys em DEC-162).
 * Preenchido pelas stories donas de cada evento a partir de docs/mvp-01/events.md.
 */
export const DOMAIN_EVENT_NAMES = [] as const satisfies readonly string[];

export type DomainEventName = (typeof DOMAIN_EVENT_NAMES)[number];
