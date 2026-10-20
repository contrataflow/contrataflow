import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { InboxViewerResolver } from './inbox-viewer.resolver.js';
import { INBOX_READER } from './ports.js';
import type { InboxCounts, InboxReader } from './ports.js';
import { unitQueueApplies } from '../domain/task-inbox.js';
import type { InboxProcessRestriction } from '../domain/task-inbox.js';

export type { InboxCounts } from './ports.js';
export type { InboxProcessRestriction } from '../domain/task-inbox.js';

/** Contadores de TSK-02 para quem consulta, com o recorte pedido (US-076 · RN-DASH-03). */
export interface InboxCountersSnapshot {
  readonly counts: InboxCounts;
  /** FA-01 de US-056: a fila da unidade se aplica ao usuário. */
  readonly unitQueueApplies: boolean;
}

/**
 * API pública do módulo `inbox` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório.
 */
@Injectable()
export class InboxFacade {
  constructor(
    @Inject(INBOX_READER) private readonly reader: InboxReader,
    private readonly viewers: InboxViewerResolver,
  ) {}

  /**
   * Os contadores da caixa de tarefas (TSK-02) de quem consulta, no `tx` do chamador — os MESMOS
   * predicados e a mesma instrução (RN-INBOX-09), para o painel nunca divergir da caixa (US-076 ·
   * RN-DASH-03). `restriction` recorta pela unidade solicitante, dentro da visibilidade.
   */
  async countersIn(
    tx: TenantTx,
    now: Date,
    restriction: InboxProcessRestriction | null = null,
  ): Promise<InboxCountersSnapshot> {
    const viewer = await this.viewers.resolveIn(tx, now);
    const counts = await this.reader.counts(tx, viewer, now, restriction);
    return { counts, unitQueueApplies: unitQueueApplies(viewer) };
  }
}
