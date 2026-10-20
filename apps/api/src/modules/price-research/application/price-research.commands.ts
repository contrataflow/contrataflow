import { createHash } from 'node:crypto';

import { localDateOf } from '@contrataflow/types';
import { PRICE_RESEARCH_MESSAGES, priceResearchDocumentTitle } from '@contrataflow/validation';
import type {
  AddPriceItems,
  CreatePriceResearch,
  FieldError,
  PriceItemDto,
  PriceResearchDto,
  PriceResearchMeta,
  PriceResearchRecalculationDto,
  UpdatePriceItem,
  UpdatePriceResearch,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { AuditChange } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import {
  PRICE_RESEARCH_CLOCK,
  PRICE_RESEARCH_REPOSITORY,
  PRICE_RESEARCH_TRANSACTIONS,
  PRICE_SOURCE_REPOSITORY,
} from './ports.js';
import type {
  PriceResearchClock,
  PriceResearchRepository,
  PriceResearchTransactions,
  PriceSourceRepository,
} from './ports.js';
import { PriceCalculationService } from './price-calculation.service.js';
import {
  countPriceResearchCreated,
  lastItemNotRemovable,
  priceItemNotFound,
  priceItemsRequired,
  priceItemVersionConflict,
  priceResearchNotFound,
  priceResearchVersionConflict,
} from './price-research.errors.js';
import {
  PriceParametersReader,
  PriceResearchGate,
  PriceResearchPresenter,
  PriceResearchRecorder,
  ResearchItemsReader,
} from './price-research.support.js';
import type { ResearchProcessItem } from './price-research.support.js';
import { QuotationRecalculator } from './price-source.support.js';
import { NumberingFacade } from '../../catalog/application/numbering.facade.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import {
  calculationParameterChanges,
  canRemoveItem,
  createPriceItem,
  createPriceResearch,
  NO_QUOTATIONS,
  outlierRangeErrors,
  planPriceItems,
  planPriceItemUpdate,
  recalculateItem,
  referenceDateErrors,
  withReferenceDate,
} from '../domain/price-research.js';
import type { PlannedPriceItem, PriceItem, PriceResearch } from '../domain/price-research.js';
import { quotationFactsByItem } from '../domain/price-source.js';

/*
 * Comandos da pesquisa de preços (US-024 · PRS-02/04/06/08): o padrão `TransactionalCommandHandler`.
 * A criação é UMA transação do tenant (RN-PRICE-13): validação do corpo e das referências → o
 * documento tipado pelo `document` (`createStructuredIn`: template publicado, `PRICE_RESEARCH_CREATE`
 * + custódia POL-01 + POL-02, singular 409, número na mesma transação, `document.create`,
 * `DocumentCreated` — `document.created.price_research` — e a timeline `DOCUMENT_CREATED`) → o
 * cabeçalho com o snapshot de `priceResearch.*` → os `PriceItem` em lote. Qualquer falha desfaz
 * tudo, inclusive o número. As mutações passam pela guarda (POL-02 estendida + POL-09) e travam a
 * linha da pesquisa. Logs sem títulos, descrições, quantidades nem valores.
 */

interface Prepared {
  readonly now: Date;
}

function logContext() {
  const context = requireRequestContext();
  return {
    tenantId: context.tenantId,
    userId: context.actor.userId,
    correlationId: context.correlationId,
  };
}

/** Impressão digital de texto livre na auditoria (o título nunca vai em claro — "Logs"). */
function fingerprint(text: string): { readonly sha256: string; readonly length: number } {
  return { sha256: createHash('sha256').update(text).digest('hex'), length: text.length };
}

abstract class PriceResearchCommand<I, O> extends TransactionalCommandHandler<I, Prepared, O> {
  protected constructor(
    name: string,
    transactions: PriceResearchTransactions,
    private readonly clock: PriceResearchClock,
  ) {
    super(name, transactions);
  }

  protected prepare(): Promise<Prepared> {
    return Promise.resolve({ now: this.clock() });
  }

  protected userId(): string | null {
    return requireRequestContext().actor.userId;
  }
}

/** Linhas planejadas viram `PriceItem` (itens travados `FOR SHARE` — corrida com a exclusão). */
async function buildItems(
  tx: TenantTx,
  reader: ResearchItemsReader,
  input: {
    readonly research: Pick<PriceResearch, 'id' | 'tenantId' | 'processId' | 'parameters'>;
    readonly lines: readonly PlannedPriceItem[];
    readonly indexOf: (line: PlannedPriceItem) => number;
    readonly userId: string | null;
    readonly now: Date;
  },
): Promise<PriceItem[]> {
  const { research, lines } = input;
  const valid = await reader.lock(
    tx,
    research.processId,
    lines.map((line) => line.processItemId),
  );
  const gone: FieldError[] = lines
    .filter((line) => !valid.has(line.processItemId))
    .map((line) => ({
      field: `items[${String(input.indexOf(line))}].processItemId`,
      code: 'REFERENCE_NOT_FOUND',
      message: PRICE_RESEARCH_MESSAGES.itemInvalid,
    }));
  if (gone.length > 0) throw validationError(gone);
  return lines.map((line) =>
    createPriceItem(line, {
      id: newId(),
      tenantId: research.tenantId,
      priceResearchId: research.id,
      parameters: research.parameters,
      userId: input.userId,
      now: input.now,
    }),
  );
}

// --- PRS-02 -------------------------------------------------------------------------------------

export interface CreatePriceResearchInput {
  readonly processId: string;
  readonly body: CreatePriceResearch;
  readonly idempotencyKey: string | null;
}

export interface CreatedPriceResearch {
  readonly dto: PriceResearchDto;
  readonly meta: PriceResearchMeta;
  readonly startedAt: number;
}

/** `CreatePriceResearchCommand` — PRS-02 (fluxo principal 5.1–5.8). */
@Injectable()
export class CreatePriceResearchCommand extends PriceResearchCommand<
  CreatePriceResearchInput,
  CreatedPriceResearch
> {
  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) transactions: PriceResearchTransactions,
    @Inject(PRICE_RESEARCH_CLOCK) clock: PriceResearchClock,
    @Inject(PRICE_RESEARCH_REPOSITORY) private readonly researches: PriceResearchRepository,
    private readonly gate: PriceResearchGate,
    private readonly items: ResearchItemsReader,
    private readonly parameters: PriceParametersReader,
    private readonly presenter: PriceResearchPresenter,
    private readonly documents: DocumentFacade,
    private readonly numbering: NumberingFacade,
  ) {
    super('price_research.create', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { processId, body, idempotencyKey }: CreatePriceResearchInput,
    { now }: Prepared,
  ): Promise<CreatedPriceResearch> {
    const startedAt = performance.now();
    // 404 se o processo não é visível (DEC-024) — antes de qualquer validação de referência.
    await this.gate.collection(tx, processId);

    // 5.1: corpo e referências (V-02/V-04/V-05). Sem itens no processo, vale o 422 de 5.3.
    const { timezone } = await this.numbering.settingsOf(tx);
    const today = localDateOf(now, timezone);
    const referenceDate = body.referenceDate ?? today;
    const available = await this.items.available(tx, processId);
    const plan =
      available.length === 0
        ? { lines: [], errors: [] }
        : planPriceItems({ requested: body.items, available });
    const errors = [...plan.errors, ...referenceDateErrors(referenceDate, today)];
    if (errors.length > 0) throw validationError(errors);
    const parameters = await this.parameters.current(tx);

    // 5.2–5.4 e 5.7: autorização, singular, número, documento, auditoria, evento e timeline.
    const created = await this.createDocument(tx, {
      processId,
      body,
      idempotencyKey,
      auditMetadata: { itemsCount: plan.lines.length, parameters },
      // 5.3 (RN-PRICE-02): depois da autorização (quem não pode criar recebe o 403) e antes de
      // qualquer gravação.
      hasItems: available.length > 0,
    });

    // 5.5–5.6: cabeçalho com o snapshot e os itens em lote.
    const { document } = created;
    const userId = document.createdById;
    const header = {
      id: document.id,
      tenantId: document.tenantId,
      processId,
      parameters,
    };
    const items = await buildItems(tx, this.items, {
      research: header,
      lines: plan.lines,
      indexOf: (line) => indexOfLine(body, available, line),
      userId,
      now,
    });
    const research = createPriceResearch(
      {
        documentId: document.id,
        tenantId: document.tenantId,
        processId,
        referenceDate,
        parameters,
        creatorId: userId,
        now,
      },
      items,
    );
    await this.researches.insert(tx, research);
    await this.researches.insertItems(tx, items);
    return {
      dto: this.presenter.research(research, document, { masked: false }),
      meta: this.presenter.meta(created.template, created.allowedActions, null),
      startedAt,
    };
  }

  /** O documento tipado; 409 com o id da pesquisa existente (FA-01 · V-09). */
  private async createDocument(
    tx: TenantTx,
    input: {
      readonly processId: string;
      readonly body: CreatePriceResearch;
      readonly idempotencyKey: string | null;
      readonly auditMetadata: Readonly<Record<string, unknown>>;
      readonly hasItems: boolean;
    },
  ) {
    try {
      return await this.documents.createStructuredIn(tx, {
        processId: input.processId,
        systemModule: 'PRICE_RESEARCH',
        templateId: input.body.templateId ?? null,
        titleOf: (process) => input.body.title ?? priceResearchDocumentTitle(process.code),
        // RN-PRICE-08: processo com orçamento sigiloso → RESTRICTED; senão o padrão do tipo.
        confidentialityOf: (process) => (process.isBudgetConfidential ? 'RESTRICTED' : undefined),
        messages: {
          templateInvalid: PRICE_RESEARCH_MESSAGES.templateInvalid,
          notCustodian: PRICE_RESEARCH_MESSAGES.notCustodian,
        },
        idempotencyKey: input.idempotencyKey,
        auditMetadata: input.auditMetadata,
        beforeCreate: () => {
          if (!input.hasItems) throw priceItemsRequired();
        },
      });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === 'DOCUMENT_ALREADY_EXISTS') throw await this.alreadyExists(tx, error);
      if (error.code === 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE') {
        throw new ApiError('DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE', {
          detail: PRICE_RESEARCH_MESSAGES.typeNotAllowedInStage,
        });
      }
      throw error;
    }
  }

  /**
   * A pesquisa que já ocupa a vaga (verificação prévia — com `meta.existingId` para o "Abrir
   * pesquisa existente"); na corrida decidida pelo índice único o `tx` já falhou no banco e o 409
   * vai sem o id.
   */
  private async alreadyExists(tx: TenantTx, error: ApiError): Promise<ApiError> {
    const meta = (error.extensions.meta ?? {}) as { existingDocumentId?: string };
    const existingId = meta.existingDocumentId ?? null;
    const existing =
      existingId === null
        ? undefined
        : (await this.documents.documentStatesIn(tx, [existingId])).get(existingId);
    return new ApiError('DOCUMENT_ALREADY_EXISTS', {
      detail: PRICE_RESEARCH_MESSAGES.alreadyExists,
      extensions:
        existing === undefined
          ? {}
          : {
              meta: {
                existingId: existing.id,
                existingDocumentId: existing.id,
                code: existing.code,
              },
            },
    });
  }

  protected override committed(result: CreatedPriceResearch, durationMs: number): void {
    countPriceResearchCreated();
    this.logger.log(
      {
        event: 'price_research.created',
        priceResearchId: result.dto.id,
        documentId: result.dto.documentId,
        processId: result.dto.processId,
        itemsCount: result.dto.itemsCount,
        durationMs,
        ...logContext(),
      },
      'price_research.created',
    );
  }
}

/** Posição da linha no corpo (`items[i]`), ou na lista padrão (todos os itens por `sequence`). */
function indexOfLine(
  body: CreatePriceResearch,
  available: readonly ResearchProcessItem[],
  line: PlannedPriceItem,
): number {
  if (body.items !== undefined) {
    return body.items.findIndex((item) => item.processItemId === line.processItemId);
  }
  return [...available]
    .sort((a, b) => a.sequence - b.sequence)
    .findIndex((item) => item.id === line.processItemId);
}

// --- PRS-04 -------------------------------------------------------------------------------------

export interface UpdatePriceResearchInput {
  readonly researchId: string;
  readonly patch: UpdatePriceResearch;
  /** Versão do `If-Match` (DEC-104). */
  readonly expectedVersion: number;
}

export interface PriceResearchResult {
  readonly dto: PriceResearchDto;
  readonly meta: PriceResearchMeta;
}

/**
 * `UpdatePriceResearchHeaderCommand` — PRS-04: data-base e título (US-024 · FA-07 · RN-PRICE-06/10)
 * e os parâmetros de cálculo (US-029 · FA-03 · RN-PRICE-47). Data-base ou parâmetro novos
 * recalculam todos os itens numa única gravação do cabeçalho (`version + 1`).
 */
@Injectable()
export class UpdatePriceResearchHeaderCommand extends PriceResearchCommand<
  UpdatePriceResearchInput,
  PriceResearchResult
> {
  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) transactions: PriceResearchTransactions,
    @Inject(PRICE_RESEARCH_CLOCK) clock: PriceResearchClock,
    @Inject(PRICE_RESEARCH_REPOSITORY) private readonly researches: PriceResearchRepository,
    private readonly gate: PriceResearchGate,
    private readonly presenter: PriceResearchPresenter,
    private readonly recorder: PriceResearchRecorder,
    private readonly documents: DocumentFacade,
    private readonly numbering: NumberingFacade,
    private readonly quotations: QuotationRecalculator,
    private readonly calculation: PriceCalculationService,
  ) {
    super('price_research.update', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { researchId, patch, expectedVersion }: UpdatePriceResearchInput,
    { now }: Prepared,
  ): Promise<PriceResearchResult> {
    const { research } = await this.gate.writable(tx, researchId);
    if (research.version !== expectedVersion) {
      throw priceResearchVersionConflict(research.version);
    }
    if (patch.referenceDate !== undefined) {
      const { timezone } = await this.numbering.settingsOf(tx);
      const errors = referenceDateErrors(patch.referenceDate, localDateOf(now, timezone));
      if (errors.length > 0) throw validationError(errors);
    }
    // FA-03 (RN-PRICE-47): parâmetros de cálculo alterados de fato recalculam todos os itens; V-02
    // (US-030): o limite inferior de destaque menor que o superior, antes de qualquer gravação.
    const parameters = calculationParameterChanges(research.parameters, patch);
    const rangeErrors = outlierRangeErrors(parameters.parameters);
    if (rangeErrors.length > 0) throw validationError(rangeErrors);

    const stamp = { now, userId: this.userId() };
    const changes: AuditChange[] = [];
    if (patch.title !== undefined) {
      const renamed = await this.documents.renameDraftIn(tx, research.documentId, patch.title);
      if (renamed !== null) {
        changes.push({
          path: 'title',
          old: fingerprint(renamed.previous),
          new: fingerprint(patch.title),
        });
      }
    }
    const dateChanged =
      patch.referenceDate !== undefined && patch.referenceDate !== research.referenceDate;
    let next: PriceResearch = { ...research, updatedAt: now, updatedById: stamp.userId };
    if (dateChanged) {
      changes.push({
        path: 'referenceDate',
        old: research.referenceDate,
        new: patch.referenceDate,
      });
      // FA-07: a validade das cotações é reavaliada (RN-PRICE-26) e os alertas recalculados.
      next = withReferenceDate(next, patch.referenceDate ?? research.referenceDate);
      const { timezone } = await this.numbering.settingsOf(tx);
      await this.quotations.refreshExpiry(tx, next, { timezone, stamp });
    }
    if (parameters.changed.length > 0) next = { ...next, parameters: parameters.parameters };

    const view = await this.documents.typedDocumentIn(tx, research.documentId);
    if (changes.length > 0) {
      await this.recorder.headerUpdated(tx, next, changes, view?.document.code ?? null);
    }
    if (parameters.changed.length > 0) {
      await this.recorder.methodChanged(tx, next, {
        entityType: 'PriceResearch',
        entityId: research.id,
        changes: parameters.changed.map((field) => ({
          path: `parameters.${field}`,
          old: research.parameters[field],
          new: parameters.parameters[field],
        })),
      });
    }
    if (dateChanged || parameters.changed.length > 0) {
      next = await this.calculation.recalculateResearch(tx, next, {
        stamp,
        trigger: parameters.changed.length > 0 ? 'PARAMETERS' : 'REFERENCE_DATE',
      });
    } else if (changes.length > 0) {
      next = await saveResearch(this.researches, tx, next, expectedVersion);
    } else {
      next = research;
    }
    if (view === null) throw priceResearchNotFound();
    return {
      dto: this.presenter.research(next, view.document, { masked: false }),
      meta: this.presenter.meta(
        view.template,
        view.allowedActions,
        null,
        await this.gate.canExcludeQuotation(tx, next, view),
        await this.gate.canComplete(tx, next, view),
      ),
    };
  }
}

/** Grava o cabeçalho; corrida com outra transação vira 412 com a versão vencedora. */
async function saveResearch(
  researches: PriceResearchRepository,
  tx: TenantTx,
  research: PriceResearch,
  expectedVersion: number,
): Promise<PriceResearch> {
  try {
    await researches.update(tx, research, expectedVersion);
  } catch (error) {
    if (error instanceof VersionConflictError) {
      const latest = await researches.findById(tx, research.id);
      throw priceResearchVersionConflict(latest?.version ?? expectedVersion + 1);
    }
    throw error;
  }
  return { ...research, version: expectedVersion + 1 };
}

// --- PRS-06 -------------------------------------------------------------------------------------

export interface AddPriceItemsInput {
  readonly researchId: string;
  readonly body: AddPriceItems;
}

export interface AddedPriceItems {
  readonly items: PriceItemDto[];
  readonly research: PriceResearch;
}

/** `AddPriceItemsCommand` — PRS-06 (FA-04 · RN-PRICE-11). */
@Injectable()
export class AddPriceItemsCommand extends PriceResearchCommand<
  AddPriceItemsInput,
  AddedPriceItems
> {
  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) transactions: PriceResearchTransactions,
    @Inject(PRICE_RESEARCH_CLOCK) clock: PriceResearchClock,
    @Inject(PRICE_RESEARCH_REPOSITORY) private readonly researches: PriceResearchRepository,
    private readonly gate: PriceResearchGate,
    private readonly items: ResearchItemsReader,
    private readonly presenter: PriceResearchPresenter,
    private readonly recorder: PriceResearchRecorder,
    private readonly calculation: PriceCalculationService,
  ) {
    super('price_research.add_items', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { researchId, body }: AddPriceItemsInput,
    { now }: Prepared,
  ): Promise<AddedPriceItems> {
    const { research, view } = await this.gate.writable(tx, researchId);
    const current = await this.researches.listItems(tx, research.id);
    const available = await this.items.available(tx, research.processId);
    const plan = planPriceItems({
      requested: body.items,
      available,
      alreadyIncluded: new Set(current.map((item) => item.processItemId)),
    });
    if (plan.errors.length > 0) throw validationError(plan.errors);
    const userId = this.userId();
    const added = await buildItems(tx, this.items, {
      research,
      lines: plan.lines,
      indexOf: (line) => body.items.findIndex((item) => item.processItemId === line.processItemId),
      userId,
      now,
    });
    await this.researches.insertItems(tx, added);
    await this.recorder.itemsUpdated(tx, research, {
      added,
      removed: [],
      quotationsRemoved: 0,
      documentCode: view.document.code,
    });
    // PRS-06 recalcula e emite o evento em todo commit, mesmo sem cotações (api/07 · Notas).
    const saved = await this.calculation.recalculateResearch(tx, research, {
      stamp: { now, userId },
      trigger: 'ITEMS',
    });
    return {
      items: await this.presenter.items(
        tx,
        research.processId,
        await this.researches
          .listItems(tx, research.id)
          .then((items) =>
            items.filter((item) => added.some((candidate) => candidate.id === item.id)),
          ),
        { masked: false },
      ),
      research: saved,
    };
  }

  protected override committed({ items, research }: AddedPriceItems): void {
    this.logger.log(
      {
        event: 'price_research.items_changed',
        priceResearchId: research.id,
        added: items.length,
        removed: 0,
        ...logContext(),
      },
      'price_research.items_changed',
    );
  }
}

// --- PRS-08 -------------------------------------------------------------------------------------

export interface RemovePriceItemInput {
  readonly itemId: string;
  readonly expectedVersion: number;
}

interface RemovedPriceItem {
  readonly research: PriceResearch;
  readonly quotationsRemoved: number;
}

/** `RemovePriceItemCommand` — PRS-08 (FA-05 · RN-PRICE-11). */
@Injectable()
export class RemovePriceItemCommand extends PriceResearchCommand<
  RemovePriceItemInput,
  RemovedPriceItem
> {
  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) transactions: PriceResearchTransactions,
    @Inject(PRICE_RESEARCH_CLOCK) clock: PriceResearchClock,
    @Inject(PRICE_RESEARCH_REPOSITORY) private readonly researches: PriceResearchRepository,
    @Inject(PRICE_SOURCE_REPOSITORY) private readonly sources: PriceSourceRepository,
    private readonly gate: PriceResearchGate,
    private readonly recorder: PriceResearchRecorder,
    private readonly calculation: PriceCalculationService,
  ) {
    super('price_research.remove_item', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { itemId, expectedVersion }: RemovePriceItemInput,
    { now }: Prepared,
  ): Promise<RemovedPriceItem> {
    const found = await this.researches.findItem(tx, itemId);
    if (found === null) throw priceItemNotFound();
    let context;
    try {
      context = await this.gate.writable(tx, found.priceResearchId);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NOT_FOUND') throw priceItemNotFound();
      throw error;
    }
    const { research, view } = context;
    // Relido depois da trava da pesquisa: a versão conferida pelo `If-Match` é a vigente.
    const item = await this.researches.findItem(tx, itemId);
    if (item === null) throw priceItemNotFound();
    if (item.version !== expectedVersion) throw priceResearchVersionConflict(item.version);
    const current = await this.researches.listItems(tx, research.id);
    if (!canRemoveItem(current.length)) throw lastItemNotRemovable();
    const quotationsRemoved = (await this.sources.quotationCounts(tx, [item.id])).get(item.id) ?? 0;
    try {
      await this.researches.deleteItem(tx, item, expectedVersion);
    } catch (error) {
      if (error instanceof VersionConflictError) {
        const latest = await this.researches.findItem(tx, itemId);
        if (latest === null) throw priceItemNotFound();
        throw priceResearchVersionConflict(latest.version);
      }
      throw error;
    }
    await this.recorder.itemsUpdated(tx, research, {
      added: [],
      removed: [item],
      quotationsRemoved,
      documentCode: view.document.code,
    });
    const saved = await this.calculation.recalculateResearch(tx, research, {
      stamp: { now, userId: this.userId() },
      trigger: 'ITEMS',
    });
    return { research: saved, quotationsRemoved };
  }

  protected override committed({ research }: RemovedPriceItem): void {
    this.logger.log(
      {
        event: 'price_research.items_changed',
        priceResearchId: research.id,
        added: 0,
        removed: 1,
        ...logContext(),
      },
      'price_research.items_changed',
    );
  }
}

// --- PRS-07 (US-029) ----------------------------------------------------------------------------

export interface UpdatePriceItemInput {
  readonly itemId: string;
  readonly patch: UpdatePriceItem;
  /** Versão do item no `If-Match` (DEC-104). */
  readonly expectedVersion: number;
}

export interface UpdatedPriceItem {
  readonly dto: PriceItemDto;
  readonly research: PriceResearch;
  /** Algo mudou (reenvio idêntico responde 200 sem gravar — cenário [Duplicidade]). */
  readonly changed: boolean;
}

/**
 * `UpdatePriceItemMethodCommand` — PRS-07 (RN-PRICE-42/43 · FA-01/FA-02): quantidade, método e valor
 * manual do item. Guarda da pesquisa (POL-02 estendida + POL-09 + linha travada), o item relido
 * depois da trava (`If-Match` → 412 com `currentVersion`), o item gravado já recalculado
 * (`version + 1`), `price_research.method_change` quando o método muda e o recálculo da pesquisa
 * (`price_research.recalculate` + `PriceResearchRecalculated`) — tudo na mesma transação.
 */
@Injectable()
export class UpdatePriceItemCommand extends PriceResearchCommand<
  UpdatePriceItemInput,
  UpdatedPriceItem
> {
  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) transactions: PriceResearchTransactions,
    @Inject(PRICE_RESEARCH_CLOCK) clock: PriceResearchClock,
    @Inject(PRICE_RESEARCH_REPOSITORY) private readonly researches: PriceResearchRepository,
    @Inject(PRICE_SOURCE_REPOSITORY) private readonly sources: PriceSourceRepository,
    private readonly gate: PriceResearchGate,
    private readonly items: ResearchItemsReader,
    private readonly presenter: PriceResearchPresenter,
    private readonly recorder: PriceResearchRecorder,
    private readonly calculation: PriceCalculationService,
  ) {
    super('price_research.update_item', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { itemId, patch, expectedVersion }: UpdatePriceItemInput,
    { now }: Prepared,
  ): Promise<UpdatedPriceItem> {
    const found = await this.researches.findItem(tx, itemId);
    if (found === null) throw priceItemNotFound();
    let context;
    try {
      context = await this.gate.writable(tx, found.priceResearchId);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NOT_FOUND') throw priceItemNotFound();
      throw error;
    }
    const { research } = context;
    // Relido depois da trava da pesquisa: a versão conferida pelo `If-Match` é a vigente.
    const item = await this.researches.findItem(tx, itemId);
    if (item === null) throw priceItemNotFound();
    if (item.version !== expectedVersion) throw priceItemVersionConflict(item.version);

    const plan = planPriceItemUpdate(item, patch, {
      allowsDecimal:
        patch.quantity === undefined
          ? true
          : await this.allowsDecimal(tx, research.processId, item.processItemId),
      unitPriceDecimals: research.parameters.unitPriceDecimals,
    });
    if (plan.errors.length > 0 || plan.next === null) throw validationError(plan.errors);
    if (!plan.changed) {
      return { dto: await this.present(tx, research, item), research, changed: false };
    }

    const stamp = { now, userId: this.userId() };
    const quotations =
      quotationFactsByItem(await this.sources.listQuotations(tx, research.id)).get(item.id) ??
      NO_QUOTATIONS;
    const edited = { ...item, ...plan.next, updatedAt: now, updatedById: stamp.userId };
    const calculated = recalculateItem(edited, quotations, research.parameters, stamp);
    try {
      await this.researches.updateItem(tx, { ...calculated, calculatedAt: now }, expectedVersion);
    } catch (error) {
      if (error instanceof VersionConflictError) {
        const latest = await this.researches.findItem(tx, itemId);
        if (latest === null) throw priceItemNotFound();
        throw priceItemVersionConflict(latest.version);
      }
      throw error;
    }
    if (plan.methodChanged) {
      await this.recorder.methodChanged(tx, research, {
        entityType: 'PriceItem',
        entityId: item.id,
        priceItemId: item.id,
        changes: [
          { path: 'methodOverride', old: item.methodOverride, new: plan.next.methodOverride },
        ],
      });
    }
    const saved = await this.calculation.recalculateResearch(tx, research, {
      stamp,
      trigger: 'ITEM_UPDATE',
    });
    const updated = await this.researches.findItem(tx, itemId);
    if (updated === null) throw priceItemNotFound();
    return { dto: await this.present(tx, saved, updated), research: saved, changed: true };
  }

  /** V-04 da criação (RN-PRICE-04): a unidade do item do processo admite decimais? */
  private async allowsDecimal(
    tx: TenantTx,
    processId: string,
    processItemId: string,
  ): Promise<boolean> {
    const available = await this.items.available(tx, processId);
    return available.find((candidate) => candidate.id === processItemId)?.allowsDecimal ?? true;
  }

  private async present(
    tx: TenantTx,
    research: PriceResearch,
    item: PriceItem,
  ): Promise<PriceItemDto> {
    const [dto] = await this.presenter.items(tx, research.processId, [item], { masked: false });
    if (dto === undefined) throw priceItemNotFound();
    return dto;
  }

  protected override committed({ dto, research, changed }: UpdatedPriceItem): void {
    this.logger.log(
      {
        event: 'price_research.item_updated',
        priceResearchId: research.id,
        priceItemId: dto.id,
        changed,
        ...logContext(),
      },
      'price_research.item_updated',
    );
  }
}

// --- PRS-20 (US-029) ----------------------------------------------------------------------------

export interface RecalculatedPriceResearch {
  readonly dto: PriceResearchRecalculationDto;
  readonly version: number;
}

/**
 * `RecalculatePriceResearchCommand` — PRS-20 (FA-04 · RN-PRICE-45): recálculo sob demanda numa
 * transação dedicada ao lote, com a guarda das demais mutações. Banco fora → 503 e nada muda.
 */
@Injectable()
export class RecalculatePriceResearchCommand extends PriceResearchCommand<
  { readonly researchId: string },
  RecalculatedPriceResearch
> {
  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) transactions: PriceResearchTransactions,
    @Inject(PRICE_RESEARCH_CLOCK) clock: PriceResearchClock,
    private readonly gate: PriceResearchGate,
    private readonly calculation: PriceCalculationService,
  ) {
    super('price_research.recalculate', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { researchId }: { readonly researchId: string },
    { now }: Prepared,
  ): Promise<RecalculatedPriceResearch> {
    const { research } = await this.gate.writable(tx, researchId);
    const saved = await this.calculation.recalculateResearch(tx, research, {
      stamp: { now, userId: this.userId() },
      trigger: 'MANUAL',
    });
    return {
      dto: {
        itemsCount: saved.itemsCount,
        itemsWithAlertsCount: saved.itemsWithAlertsCount,
        lastCalculatedAt: now.toISOString(),
      },
      version: saved.version,
    };
  }
}
