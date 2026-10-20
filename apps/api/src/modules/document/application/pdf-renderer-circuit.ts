import { Inject, Injectable } from '@nestjs/common';

import {
  DEFAULT_CIRCUIT_POLICY,
  DependencyCircuit,
} from '#shared/resilience/dependency-circuit.js';

import { DOCUMENT_CLOCK } from './ports.js';
import type { DocumentClock } from './ports.js';

/*
 * Disjuntor do Gotenberg (US-067 · RN-DOC-66 · queues.md §10.3): o mesmo `DependencyCircuit` do
 * ClamAV — 5 falhas seguidas abrem por 30 s, meia-abertura com UMA renderização. Aberto, o job
 * pausa sem consumir tentativa e o usuário continua vendo "Gerando PDF…" (FA-03).
 */
@Injectable()
export class PdfRendererCircuit extends DependencyCircuit {
  constructor(@Inject(DOCUMENT_CLOCK) clock: DocumentClock) {
    super(clock, DEFAULT_CIRCUIT_POLICY);
  }
}
