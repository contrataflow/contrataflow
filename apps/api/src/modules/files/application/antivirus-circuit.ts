import { Inject, Injectable } from '@nestjs/common';

import {
  DEFAULT_CIRCUIT_POLICY,
  DependencyCircuit,
} from '#shared/resilience/dependency-circuit.js';
import type { CircuitState } from '#shared/resilience/dependency-circuit.js';

import { FILES_CLOCK } from './files-ports.js';
import type { FilesClock } from './files-ports.js';

/*
 * Disjuntor do ClamAV (US-068 · RN-DOC-75 · queues.md §4.5/§10.3): depois de 5 falhas seguidas de
 * conexão, abre por 30 s; em seguida deixa passar UMA varredura (meia-abertura) e fecha no primeiro
 * sucesso. Aberto, a varredura nem lê a quarentena: o job pausa sem consumir tentativa e o anexo
 * fica retido em `SCANNING` — nunca liberado sem antivírus (P3). A regra é o `DependencyCircuit`
 * do shared kernel (o mesmo do Gotenberg — US-067).
 */

export const ANTIVIRUS_CIRCUIT_POLICY = DEFAULT_CIRCUIT_POLICY;

export type AntivirusCircuitState = CircuitState;

@Injectable()
export class AntivirusCircuit extends DependencyCircuit {
  constructor(@Inject(FILES_CLOCK) clock: FilesClock) {
    super(clock, ANTIVIRUS_CIRCUIT_POLICY);
  }
}
