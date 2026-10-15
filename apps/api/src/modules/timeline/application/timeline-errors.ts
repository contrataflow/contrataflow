import type { TimelineLookupKind } from '../domain/timeline-lookups.js';

/**
 * Evento mapeado cuja referência não tem fonte de nomes registrada no `TimelineModule`: erro de
 * programação (a story que passou a publicar o evento não registrou a fonte). Como em V-01, o caso
 * de uso de origem é desfeito (500 `INTERNAL_ERROR`) em vez de gravar a entrada sem os nomes.
 */
export class TimelineLookupUnavailableError extends Error {
  constructor(readonly kind: TimelineLookupKind) {
    super(`Timeline sem fonte de nomes para ${kind}: registre-a em TIMELINE_LOOKUP_SOURCES.`);
    this.name = 'TimelineLookupUnavailableError';
  }
}

/** Duas fontes para o mesmo tipo de referência (falha na subida). */
export class TimelineLookupSourceConflictError extends Error {
  constructor(readonly kind: TimelineLookupKind) {
    super(`Fonte de nomes da timeline repetida para ${kind}.`);
    this.name = 'TimelineLookupSourceConflictError';
  }
}
