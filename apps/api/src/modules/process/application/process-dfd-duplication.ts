import { Inject, Injectable } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { CreateProcessCommand } from './create-process.command.js';
import { PROCESS_CLOCK, PROCESS_ITEM_REPOSITORY, PROCESS_REPOSITORY } from './ports.js';
import type { ProcessClock, ProcessItemRepository, ProcessRepository } from './ports.js';
import { ProcessItemsChangeRecorder } from './process-items.support.js';
import { ProcessPanelReader } from './process-panel.queries.js';
import { processNotFoundError, processValidationError } from './process.errors.js';
import {
  cloneItemsAsNext,
  diffItem,
  duplicateItems,
  itemLimitIssues,
} from '../domain/process-items.js';
import { draftIssues, duplicateDraft } from '../domain/process.js';

export interface DuplicateProcessForDfdInput {
  readonly sourceProcessId: string;
  readonly idempotencyKey: string | null;
  /** Mensagem do 403 quando o `PROCESS_CREATE` não cobre o setor do novo processo. */
  readonly permissionDetail: string;
}

/** O processo criado para receber o DFD duplicado (US-018 · RN-DFD-74). */
export interface ProcessCreatedForDfd {
  readonly processId: string;
  /** Item do processo de origem → item equivalente do novo processo (mesma ordem de `sequence`). */
  readonly itemMap: ReadonlyMap<string, string>;
}

export interface CloneItemsForDfdInput {
  readonly sourceProcessId: string;
  readonly targetProcessId: string;
  /** Itens do processo de origem a clonar, na ordem em que entram no destino. */
  readonly sourceItemIds: readonly string[];
}

/**
 * Peças do processo que a duplicação do DFD (US-018) usa, no `tx` do comando do `dfd`: a autorização
 * do destino é de quem chama (`DFD_CREATE` + custódia na criação do documento; `PROCESS_CREATE` na
 * criação do processo).
 */
@Injectable()
export class ProcessDfdDuplication {
  constructor(
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(PROCESS_ITEM_REPOSITORY) private readonly items: ProcessItemRepository,
    private readonly panel: ProcessPanelReader,
    private readonly creator: CreateProcessCommand,
    private readonly recorder: ProcessItemsChangeRecorder,
  ) {}

  /**
   * RN-DFD-74: "novo processo" pela mecânica da US-011 — rascunho copiado do processo de origem
   * (visível ao usuário; senão 404), criação com `PROCESS_CREATE` no setor (403), workflow, número,
   * custódia de quem duplica, `process.create` e `ProcessCreated` — e os itens ativos da origem
   * renumerados a partir de 1.
   */
  async createProcessIn(
    tx: TenantTx,
    input: DuplicateProcessForDfdInput,
  ): Promise<ProcessCreatedForDfd> {
    const userId = requireRequestContext().actor.userId ?? '';
    const now = this.clock();
    const source = (await this.panel.load(tx, input.sourceProcessId)).rows.process;
    const context = await this.creator.creationContext(tx, now);
    const draft = duplicateDraft(source, {});
    const issues = draftIssues(draft, context);
    if (issues.length > 0) throw processValidationError(issues);
    const created = await this.creator.createIn(tx, draft, context, {
      idempotencyKey: input.idempotencyKey,
      duplicatedFromId: source.id,
      permissionDetail: input.permissionDetail,
    });
    const target = created.process;
    const active = [...(await this.items.listActive(tx, source.id))].sort(
      (a, b) => a.sequence - b.sequence,
    );
    const copies = duplicateItems(active, {
      tenantId: target.tenantId,
      processId: target.id,
      now,
      userId,
      newId,
    });
    const itemMap = new Map<string, string>();
    for (const [index, copy] of copies.entries()) {
      await this.items.insert(tx, copy);
      itemMap.set(active[index]?.id ?? '', copy.id);
    }
    return { processId: target.id, itemMap };
  }

  /**
   * RN-DFD-75: um `ProcessItem` no processo de destino para cada item do DFD de origem (natureza,
   * descrição, unidade e catálogo; `sequence` a partir do próximo disponível; sem lote nem valores
   * de referência). Trava o processo (serializa a numeração), respeita o limite de itens (422) e
   * registra `process.items_update` e `ProcessItemsChanged`. Item de origem que não está mais ativo
   * fica de fora do mapa devolvido.
   */
  async cloneItemsIn(
    tx: TenantTx,
    input: CloneItemsForDfdInput,
  ): Promise<ReadonlyMap<string, string>> {
    const cloned = new Map<string, string>();
    if (input.sourceItemIds.length === 0) return cloned;
    if (!(await this.processes.lockForUpdate(tx, input.targetProcessId))) {
      throw processNotFoundError();
    }
    const userId = requireRequestContext().actor.userId ?? '';
    const now = this.clock();
    const available = new Map(
      (await this.items.listActive(tx, input.sourceProcessId)).map((item) => [item.id, item]),
    );
    const wanted = input.sourceItemIds.flatMap((id) => available.get(id) ?? []);
    if (wanted.length === 0) return cloned;
    const active = await this.items.listActive(tx, input.targetProcessId);
    const limit = itemLimitIssues(active.length + wanted.length - 1);
    if (limit.length > 0) throw processValidationError(limit);

    const copies = cloneItemsAsNext(wanted, active, {
      tenantId: wanted[0]?.tenantId ?? '',
      processId: input.targetProcessId,
      now,
      userId,
      newId,
    });
    for (const [index, copy] of copies.entries()) {
      await this.items.insert(tx, copy);
      cloned.set(wanted[index]?.id ?? '', copy.id);
    }
    const processVersion = await this.processes.touchProcess(
      tx,
      input.targetProcessId,
      now,
      userId,
    );
    const code = (await this.processes.codes(tx, [input.targetProcessId])).get(
      input.targetProcessId,
    )?.code;
    await this.recorder.record(tx, {
      processId: input.targetProcessId,
      processCode: code ?? null,
      operation: 'ADD',
      itemsCount: active.length + copies.length,
      processVersion,
      changes: copies.flatMap((copy) =>
        diffItem(null, copy).map((change) => ({ itemId: copy.id, ...change })),
      ),
      added: copies.map((copy) => copy.id),
      updated: [],
      removed: [],
    });
    return cloned;
  }
}
