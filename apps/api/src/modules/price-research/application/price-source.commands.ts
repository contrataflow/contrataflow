import { localDateOf } from '@contrataflow/types';
import { unitPriceIssue } from '@contrataflow/validation';
import type {
  CreatePriceSource,
  ExcludeQuotation,
  PriceSourceDto,
  QuotationDto,
  UpdatePriceSource,
  UpdateQuotation,
  UpsertQuotations,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { validationError } from '#shared/errors/api-error.js';

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
import {
  priceResearchNotFound,
  priceSourceNotFound,
  priceSourceVersionConflict,
  quotationExcluded,
  quotationInvalidState,
  quotationNotFound,
  quotationRequiredFields,
  quotationVersionConflict,
  recordQuotationGridDuration,
} from './price-research.errors.js';
import { EXCLUDE_QUOTATION_OPTIONS } from './price-research.support.js';
import type { WritableOptions } from './price-research.support.js';
import {
  PriceSourceGate,
  PriceSourcePresenter,
  PriceSourceRecorder,
  PriceSourceRulesReader,
  QuotationRecalculator,
  rulesOf,
} from './price-source.support.js';
import type { PriceSourceTypeRef } from '../../catalog/application/catalog.facade.js';
import { NumberingFacade } from '../../catalog/application/numbering.facade.js';
import { SupplierFacade } from '../../supplier/application/supplier.facade.js';
import type { PriceResearch } from '../domain/price-research.js';
import {
  applySourcePatch,
  createPriceSource,
  createQuotation,
  excludeBlockedBy,
  excludeQuotation,
  isSourceExpired,
  missingRequiredFields,
  normalizeUnitPrice,
  planQuotationGrid,
  restoreBlockedBy,
  restoreQuotation,
  sourceDateErrors,
  withPrice,
  withSourceFields,
} from '../domain/price-source.js';
import type { PriceSource, PriceSourceFields, Quotation } from '../domain/price-source.js';

/*
 * Comandos de fontes e cotações (US-026 · PRS-10..15): o padrão `TransactionalCommandHandler`, cada
 * um UMA transação do tenant. Toda escrita passa pela guarda (POL-02 estendida + documento em
 * `DRAFT`/`RETURNED` + POL-09, com a linha da pesquisa travada — o que serializa as gravações
 * concorrentes e faz a segunda receber o 412) e termina no recálculo (RN-PRICE-27: cotações válidas,
 * alertas, contadores, `lastCalculatedAt` e `PriceResearchRecalculated`) e na auditoria. Logs sem
 * preços, descrições, URLs nem justificativas.
 */

interface Prepared {
  readonly now: Date;
}

function logContext() {
  const context = requireRequestContext();
  return { tenantId: context.tenantId, correlationId: context.correlationId };
}

abstract class PriceSourceCommand<I, O> extends TransactionalCommandHandler<I, Prepared, O> {
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

  protected stamp(now: Date) {
    return { now, userId: requireRequestContext().actor.userId };
  }
}

/** Corpo do PRS-10/11 nos campos do domínio (`accessedAt` como `Date`). */
function toFields(
  body: CreatePriceSource | UpdatePriceSource,
): Partial<Record<keyof PriceSourceFields, unknown>> {
  return {
    sourceTypeId: body.sourceTypeId,
    description: body.description,
    supplierId: body.supplierId,
    quoteDate: body.quoteDate,
    accessedAt:
      body.accessedAt === undefined
        ? undefined
        : body.accessedAt === null
          ? null
          : new Date(body.accessedAt),
    url: body.url,
    referenceOrganization: body.referenceOrganization,
    referenceDocument: body.referenceDocument,
    supplierChoiceJustification: body.supplierChoiceJustification,
    notes: body.notes,
  };
}

/**
 * Validação da fonte (RN-PRICE-21..23 · V-01..V-05), na ordem: datas não futuras (422
 * `VALIDATION_ERROR`) → campos exigidos pelo tipo (422 `QUOTATION_REQUIRED_FIELDS`) → fornecedor
 * ativo do tenant (422 `REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`).
 */
async function assertSourceValid(
  tx: TenantTx,
  input: {
    readonly fields: PriceSourceFields;
    readonly type: PriceSourceTypeRef;
    readonly checkSupplier: boolean;
    readonly suppliers: SupplierFacade;
    readonly clock: { readonly now: Date; readonly today: string };
    readonly logger: { warn: (message: unknown, context?: string) => void };
  },
): Promise<void> {
  const dateErrors = sourceDateErrors(input.fields, input.clock);
  if (dateErrors.length > 0) throw validationError(dateErrors);
  const missing = missingRequiredFields(input.fields, input.type);
  if (missing.length > 0) {
    input.logger.warn(
      {
        event: 'price_research.required_field_missing',
        sourceTypeCode: input.type.code,
        fields: missing,
        ...logContext(),
      },
      'price_research.required_field_missing',
    );
    throw quotationRequiredFields(missing);
  }
  if (input.checkSupplier && input.fields.supplierId !== null) {
    await input.suppliers.assertActive(tx, input.fields.supplierId, 'supplierId');
  }
}

// --- PRS-10 -------------------------------------------------------------------------------------

export interface CreatePriceSourceInput {
  readonly researchId: string;
  readonly body: CreatePriceSource;
}

export interface PriceSourceResult {
  readonly dto: PriceSourceDto;
}

/** `CreatePriceSourceCommand` — PRS-10 (fluxo principal 1–4 · FA-06). */
@Injectable()
export class CreatePriceSourceCommand extends PriceSourceCommand<
  CreatePriceSourceInput,
  PriceSourceResult
> {
  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) transactions: PriceResearchTransactions,
    @Inject(PRICE_RESEARCH_CLOCK) clock: PriceResearchClock,
    @Inject(PRICE_SOURCE_REPOSITORY) private readonly sources: PriceSourceRepository,
    private readonly gate: PriceSourceGate,
    private readonly rules: PriceSourceRulesReader,
    private readonly suppliers: SupplierFacade,
    private readonly numbering: NumberingFacade,
    private readonly recalculator: QuotationRecalculator,
    private readonly presenter: PriceSourcePresenter,
    private readonly recorder: PriceSourceRecorder,
  ) {
    // `<nome>_failed` = `price_research.source_save_failed` ("Logs").
    super('price_research.source_save', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { researchId, body }: CreatePriceSourceInput,
    { now }: Prepared,
  ): Promise<PriceSourceResult> {
    const { research, view } = await this.gate.writable(tx, researchId, priceResearchNotFound);
    const type = await this.rules.active(tx, body.sourceTypeId);
    const { timezone } = await this.numbering.settingsOf(tx);
    const complete: PriceSourceFields = {
      sourceTypeId: type.id,
      description: body.description,
      supplierId: body.supplierId ?? null,
      quoteDate: body.quoteDate ?? null,
      accessedAt:
        body.accessedAt === undefined || body.accessedAt === null
          ? null
          : new Date(body.accessedAt),
      url: body.url ?? null,
      referenceOrganization: body.referenceOrganization ?? null,
      referenceDocument: body.referenceDocument ?? null,
      supplierChoiceJustification: body.supplierChoiceJustification ?? null,
      notes: body.notes ?? null,
    };
    await assertSourceValid(tx, {
      fields: complete,
      type,
      checkSupplier: true,
      suppliers: this.suppliers,
      clock: { now, today: localDateOf(now, timezone) },
      logger: this.logger,
    });
    const stamp = this.stamp(now);
    const source = createPriceSource(complete, {
      id: newId(),
      tenantId: research.tenantId,
      priceResearchId: research.id,
      processId: research.processId,
      sortOrder: await this.sources.nextSortOrder(tx, research.id),
      ...stamp,
    });
    await this.sources.insertSource(tx, source);
    await this.recorder.sourceCreated(tx, source, view.document.code);
    await this.recalculator.recalculate(tx, research, stamp);
    const [dto] = await this.presenter.sources(tx, [source], [], { masked: false });
    if (dto === undefined) throw priceSourceNotFound();
    return { dto };
  }

  protected override committed({ dto }: PriceSourceResult): void {
    this.logger.log(
      {
        event: 'price_research.source_created',
        priceSourceId: dto.id,
        sourceTypeId: dto.sourceTypeId,
        priceResearchId: dto.priceResearchId,
        ...logContext(),
      },
      'price_research.source_created',
    );
  }
}

// --- PRS-11 -------------------------------------------------------------------------------------

export interface UpdatePriceSourceInput {
  readonly sourceId: string;
  readonly patch: UpdatePriceSource;
  readonly expectedVersion: number;
}

/** `UpdatePriceSourceCommand` — PRS-11 (FA-01: trocar o tipo reavalia os obrigatórios). */
@Injectable()
export class UpdatePriceSourceCommand extends PriceSourceCommand<
  UpdatePriceSourceInput,
  PriceSourceResult
> {
  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) transactions: PriceResearchTransactions,
    @Inject(PRICE_RESEARCH_CLOCK) clock: PriceResearchClock,
    @Inject(PRICE_SOURCE_REPOSITORY) private readonly sources: PriceSourceRepository,
    private readonly gate: PriceSourceGate,
    private readonly rules: PriceSourceRulesReader,
    private readonly suppliers: SupplierFacade,
    private readonly numbering: NumberingFacade,
    private readonly recalculator: QuotationRecalculator,
    private readonly presenter: PriceSourcePresenter,
    private readonly recorder: PriceSourceRecorder,
  ) {
    super('price_research.source_save', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { sourceId, patch, expectedVersion }: UpdatePriceSourceInput,
    { now }: Prepared,
  ): Promise<PriceSourceResult> {
    const { context, source } = await this.gate.writableSource(tx, sourceId, expectedVersion);
    const { research } = context;
    const { fields, changed } = applySourcePatch(source, toFields(patch));
    if (changed.length === 0) return { dto: await this.present(tx, research, source) };

    const typeChanged = changed.includes('sourceTypeId');
    const type = typeChanged
      ? await this.rules.active(tx, fields.sourceTypeId)
      : (await this.rules.of(tx, [fields.sourceTypeId])).get(fields.sourceTypeId);
    if (type === undefined) throw priceSourceNotFound();
    const { timezone } = await this.numbering.settingsOf(tx);
    await assertSourceValid(tx, {
      fields,
      type,
      checkSupplier: changed.includes('supplierId'),
      suppliers: this.suppliers,
      clock: { now, today: localDateOf(now, timezone) },
      logger: this.logger,
    });
    const stamp = this.stamp(now);
    const next = withSourceFields(source, fields, stamp);
    try {
      await this.sources.updateSource(tx, next, expectedVersion);
    } catch (error) {
      if (error instanceof VersionConflictError) {
        const latest = await this.sources.findSource(tx, sourceId);
        throw priceSourceVersionConflict(latest?.version ?? expectedVersion + 1);
      }
      throw error;
    }
    const saved = { ...next, version: expectedVersion + 1 };
    await this.recorder.sourceUpdated(tx, source, saved, changed);
    // RN-PRICE-26: tipo e datas mudam a validade das cotações desta fonte.
    if (changed.some((field) => ['sourceTypeId', 'quoteDate', 'accessedAt'].includes(field))) {
      await this.recalculator.refreshExpiry(tx, research, {
        timezone,
        stamp,
        sourceIds: [saved.id],
      });
    }
    await this.recalculator.recalculate(tx, research, stamp);
    return { dto: await this.present(tx, research, saved) };
  }

  private async present(tx: TenantTx, research: PriceResearch, source: PriceSource) {
    const quotations = await this.sources.listQuotations(tx, research.id);
    const [dto] = await this.presenter.sources(tx, [source], quotations, { masked: false });
    if (dto === undefined) throw priceSourceNotFound();
    return dto;
  }
}

// --- PRS-12 -------------------------------------------------------------------------------------

export interface DeletePriceSourceInput {
  readonly sourceId: string;
  readonly expectedVersion: number;
}

interface DeletedPriceSource {
  readonly source: PriceSource;
  readonly quotationsRemoved: number;
}

/** `DeletePriceSourceCommand` — PRS-12 (FA-02 · RN-PRICE-29: cotações em cascata). */
@Injectable()
export class DeletePriceSourceCommand extends PriceSourceCommand<
  DeletePriceSourceInput,
  DeletedPriceSource
> {
  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) transactions: PriceResearchTransactions,
    @Inject(PRICE_RESEARCH_CLOCK) clock: PriceResearchClock,
    @Inject(PRICE_SOURCE_REPOSITORY) private readonly sources: PriceSourceRepository,
    private readonly gate: PriceSourceGate,
    private readonly recalculator: QuotationRecalculator,
    private readonly recorder: PriceSourceRecorder,
  ) {
    super('price_research.source_delete', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { sourceId, expectedVersion }: DeletePriceSourceInput,
    { now }: Prepared,
  ): Promise<DeletedPriceSource> {
    const { context, source } = await this.gate.writableSource(tx, sourceId, expectedVersion);
    const quotationsRemoved = (await this.sources.listQuotations(tx, context.research.id)).filter(
      (quotation) => quotation.priceSourceId === source.id,
    ).length;
    try {
      await this.sources.deleteSource(tx, source, expectedVersion);
    } catch (error) {
      if (error instanceof VersionConflictError) {
        const latest = await this.sources.findSource(tx, sourceId);
        if (latest === null) throw priceSourceNotFound();
        throw priceSourceVersionConflict(latest.version);
      }
      throw error;
    }
    await this.recorder.sourceDeleted(tx, source, quotationsRemoved);
    await this.recalculator.recalculate(tx, context.research, this.stamp(now));
    return { source, quotationsRemoved };
  }

  protected override committed({ source, quotationsRemoved }: DeletedPriceSource): void {
    this.logger.log(
      {
        event: 'price_research.source_deleted',
        priceSourceId: source.id,
        priceResearchId: source.priceResearchId,
        quotationsRemoved,
        ...logContext(),
      },
      'price_research.source_deleted',
    );
  }
}

// --- PRS-13 -------------------------------------------------------------------------------------

export interface UpsertQuotationsInput {
  readonly sourceId: string;
  readonly body: UpsertQuotations;
  /** Versão da FONTE no `If-Match`. */
  readonly expectedVersion: number;
}

export interface UpsertedQuotations {
  readonly quotations: QuotationDto[];
  readonly sourceVersion: number;
  readonly sourceId: string;
  readonly created: number;
  readonly updated: number;
  readonly lines: number;
}

/** `UpsertQuotationsCommand` — PRS-13 (fluxo principal 7–9 · RN-PRICE-24/25/26/27). */
@Injectable()
export class UpsertQuotationsCommand extends PriceSourceCommand<
  UpsertQuotationsInput,
  UpsertedQuotations
> {
  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) transactions: PriceResearchTransactions,
    @Inject(PRICE_RESEARCH_CLOCK) clock: PriceResearchClock,
    @Inject(PRICE_RESEARCH_REPOSITORY) private readonly researches: PriceResearchRepository,
    @Inject(PRICE_SOURCE_REPOSITORY) private readonly sources: PriceSourceRepository,
    private readonly gate: PriceSourceGate,
    private readonly rules: PriceSourceRulesReader,
    private readonly numbering: NumberingFacade,
    private readonly recalculator: QuotationRecalculator,
    private readonly presenter: PriceSourcePresenter,
    private readonly recorder: PriceSourceRecorder,
  ) {
    super('price_research.quotations_upsert', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { sourceId, body, expectedVersion }: UpsertQuotationsInput,
    { now }: Prepared,
  ): Promise<UpsertedQuotations> {
    const { context, source } = await this.gate.writableSource(tx, sourceId, expectedVersion);
    const { research } = context;
    const items = await this.researches.listItems(tx, research.id);
    const all = await this.sources.listQuotations(tx, research.id);
    const existing = new Map(
      all
        .filter((quotation) => quotation.priceSourceId === source.id)
        .map((quotation) => [quotation.priceItemId, quotation]),
    );
    const plan = planQuotationGrid({
      lines: body.items,
      itemIds: new Set(items.map((item) => item.id)),
      existing,
      unitPriceDecimals: research.parameters.unitPriceDecimals,
    });
    if (plan.errors.length > 0) throw validationError(plan.errors);
    if (plan.excluded.length > 0) {
      throw quotationExcluded(plan.excluded.map((index) => body.items[index]?.priceItemId ?? ''));
    }

    const stamp = this.stamp(now);
    let sourceVersion = source.version;
    const written: { quotation: Quotation; created: boolean }[] = [];
    if (plan.writes.length > 0) {
      const isExpired = await this.expiryOf(tx, research, source);
      const created: Quotation[] = [];
      for (const write of plan.writes) {
        if (write.existing === null) {
          created.push(
            createQuotation({
              id: newId(),
              tenantId: research.tenantId,
              priceResearchId: research.id,
              priceItemId: write.priceItemId,
              priceSourceId: source.id,
              unitPrice: write.unitPrice,
              brandModel: write.brandModel,
              isExpired,
              ...stamp,
            }),
          );
          continue;
        }
        const next = withPrice(write.existing, { ...write, isExpired }, stamp);
        // A pesquisa está travada: a versão lida é a vigente.
        await this.sources.updateQuotation(tx, next, write.existing.version);
        written.push({
          quotation: { ...next, version: write.existing.version + 1 },
          created: false,
        });
      }
      await this.sources.insertQuotations(tx, created);
      written.push(...created.map((quotation) => ({ quotation, created: true })));
      sourceVersion = await touchSource(this.sources, tx, source, stamp, expectedVersion);
      for (const { quotation, created: isNew } of written) {
        await this.recorder.quotation(
          tx,
          isNew ? 'price_research.quotation_create' : 'price_research.quotation_update',
          quotation,
          research.processId,
        );
      }
      await this.recalculator.recalculate(tx, research, stamp);
    }

    const current = (await this.sources.listQuotations(tx, research.id)).filter(
      (quotation) => quotation.priceSourceId === source.id,
    );
    return {
      quotations: current.map((quotation) =>
        this.presenter.quotation(quotation, { masked: false }),
      ),
      sourceVersion,
      sourceId: source.id,
      created: written.filter((entry) => entry.created).length,
      updated: written.filter((entry) => !entry.created).length,
      lines: body.items.length,
    };
  }

  private async expiryOf(tx: TenantTx, research: PriceResearch, source: PriceSource) {
    const { timezone } = await this.numbering.settingsOf(tx);
    const type = (await this.rules.of(tx, [source.sourceTypeId])).get(source.sourceTypeId);
    return type === undefined ? false : isSourceExpired(source, rulesOf(type), research, timezone);
  }

  protected override committed(result: UpsertedQuotations, durationMs: number): void {
    recordQuotationGridDuration(durationMs, result.lines);
    this.logger.log(
      {
        event: 'price_research.quotations_upserted',
        priceSourceId: result.sourceId,
        created: result.created,
        updated: result.updated,
        durationMs,
        ...logContext(),
      },
      'price_research.quotations_upserted',
    );
  }
}

/**
 * A fonte ganha versão nova quando as cotações dela mudam: o `If-Match` da grade (PRS-13) é a
 * versão da fonte, e a edição/remoção unitária (PRS-14/15) também a invalida.
 */
async function touchSource(
  sources: PriceSourceRepository,
  tx: TenantTx,
  source: PriceSource,
  stamp: { readonly now: Date; readonly userId: string | null },
  expectedVersion: number,
): Promise<number> {
  try {
    await sources.updateSource(
      tx,
      { ...source, updatedAt: stamp.now, updatedById: stamp.userId },
      expectedVersion,
    );
  } catch (error) {
    if (error instanceof VersionConflictError) {
      const latest = await sources.findSource(tx, source.id);
      throw priceSourceVersionConflict(latest?.version ?? expectedVersion + 1);
    }
    throw error;
  }
  return expectedVersion + 1;
}

// --- PRS-14/15 ----------------------------------------------------------------------------------

/** A cotação visível e a pesquisa dela editável e travada; relida depois da trava. */
async function writableQuotation(
  tx: TenantTx,
  sources: PriceSourceRepository,
  gate: PriceSourceGate,
  quotationId: string,
  expectedVersion: number,
  options: WritableOptions = {},
) {
  const found = await sources.findQuotation(tx, quotationId);
  if (found === null) throw quotationNotFound();
  const context = await gate.writable(tx, found.priceResearchId, quotationNotFound, options);
  const quotation = await sources.findQuotation(tx, quotationId);
  if (quotation === null) throw quotationNotFound();
  if (quotation.version !== expectedVersion) throw quotationVersionConflict(quotation.version);
  const source = await sources.findSource(tx, quotation.priceSourceId);
  if (source === null) throw quotationNotFound();
  return { context, quotation, source };
}

export interface UpdateQuotationInput {
  readonly quotationId: string;
  readonly patch: UpdateQuotation;
  readonly expectedVersion: number;
}

/** `UpdateQuotationCommand` — PRS-14 (FA-03 · V-06/V-07). */
@Injectable()
export class UpdateQuotationCommand extends PriceSourceCommand<UpdateQuotationInput, QuotationDto> {
  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) transactions: PriceResearchTransactions,
    @Inject(PRICE_RESEARCH_CLOCK) clock: PriceResearchClock,
    @Inject(PRICE_SOURCE_REPOSITORY) private readonly sources: PriceSourceRepository,
    private readonly gate: PriceSourceGate,
    private readonly rules: PriceSourceRulesReader,
    private readonly numbering: NumberingFacade,
    private readonly recalculator: QuotationRecalculator,
    private readonly presenter: PriceSourcePresenter,
    private readonly recorder: PriceSourceRecorder,
  ) {
    super('price_research.quotation_update', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { quotationId, patch, expectedVersion }: UpdateQuotationInput,
    { now }: Prepared,
  ): Promise<QuotationDto> {
    const { context, quotation, source } = await writableQuotation(
      tx,
      this.sources,
      this.gate,
      quotationId,
      expectedVersion,
    );
    const { research } = context;
    if (quotation.status === 'EXCLUDED') throw quotationExcluded([quotation.priceItemId]);
    if (patch.unitPrice !== undefined) {
      const issue = unitPriceIssue(patch.unitPrice, research.parameters.unitPriceDecimals);
      if (issue !== null) throw validationError([{ field: 'unitPrice', ...issue }]);
    }
    const unitPrice =
      patch.unitPrice === undefined ? quotation.unitPrice : normalizeUnitPrice(patch.unitPrice);
    const brandModel = patch.brandModel === undefined ? quotation.brandModel : patch.brandModel;
    if (unitPrice === quotation.unitPrice && brandModel === quotation.brandModel) {
      return this.presenter.quotation(quotation, { masked: false });
    }
    const { timezone } = await this.numbering.settingsOf(tx);
    const type = (await this.rules.of(tx, [source.sourceTypeId])).get(source.sourceTypeId);
    const isExpired =
      type === undefined
        ? quotation.isExpired
        : isSourceExpired(source, rulesOf(type), research, timezone);
    const stamp = this.stamp(now);
    const next = withPrice(quotation, { unitPrice, brandModel, isExpired }, stamp);
    try {
      await this.sources.updateQuotation(tx, next, expectedVersion);
    } catch (error) {
      if (error instanceof VersionConflictError) {
        const latest = await this.sources.findQuotation(tx, quotationId);
        if (latest === null) throw quotationNotFound();
        throw quotationVersionConflict(latest.version);
      }
      throw error;
    }
    const saved = { ...next, version: expectedVersion + 1 };
    await touchSource(this.sources, tx, source, stamp, source.version);
    await this.recorder.quotation(tx, 'price_research.quotation_update', saved, research.processId);
    await this.recalculator.recalculate(tx, research, stamp);
    return this.presenter.quotation(saved, { masked: false });
  }
}

export interface DeleteQuotationInput {
  readonly quotationId: string;
  readonly expectedVersion: number;
}

/** `DeleteQuotationCommand` — PRS-15 (FA-04: remoção física, sem motivo — ≠ US-027). */
@Injectable()
export class DeleteQuotationCommand extends PriceSourceCommand<DeleteQuotationInput, Quotation> {
  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) transactions: PriceResearchTransactions,
    @Inject(PRICE_RESEARCH_CLOCK) clock: PriceResearchClock,
    @Inject(PRICE_SOURCE_REPOSITORY) private readonly sources: PriceSourceRepository,
    private readonly gate: PriceSourceGate,
    private readonly recalculator: QuotationRecalculator,
    private readonly recorder: PriceSourceRecorder,
  ) {
    super('price_research.quotation_delete', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { quotationId, expectedVersion }: DeleteQuotationInput,
    { now }: Prepared,
  ): Promise<Quotation> {
    const { context, quotation, source } = await writableQuotation(
      tx,
      this.sources,
      this.gate,
      quotationId,
      expectedVersion,
    );
    try {
      await this.sources.deleteQuotation(tx, quotation, expectedVersion);
    } catch (error) {
      if (error instanceof VersionConflictError) {
        const latest = await this.sources.findQuotation(tx, quotationId);
        if (latest === null) throw quotationNotFound();
        throw quotationVersionConflict(latest.version);
      }
      throw error;
    }
    const stamp = this.stamp(now);
    await touchSource(this.sources, tx, source, stamp, source.version);
    await this.recorder.quotation(
      tx,
      'price_research.quotation_delete',
      quotation,
      context.research.processId,
    );
    await this.recalculator.recalculate(tx, context.research, stamp);
    return quotation;
  }
}

// --- PRS-16/17 (US-027) ------------------------------------------------------------------------

export interface ExcludeQuotationInput {
  readonly quotationId: string;
  readonly body: ExcludeQuotation;
  /** Versão da COTAÇÃO no `If-Match`. */
  readonly expectedVersion: number;
}

export interface RestoreQuotationInput {
  readonly quotationId: string;
  readonly expectedVersion: number;
}

/** Cotação gravada na transação, com o que os logs pós-commit precisam. */
interface QuotationChange {
  readonly dto: QuotationDto;
  readonly quotation: Quotation;
}

/**
 * Efeito comum das duas transições (RN-PRICE-33/34): a cotação gravada com `If-Match` da cotação, a
 * fonte com versão nova (a grade em tela deixa de valer — PRS-13), auditoria + evento da transição
 * e o recálculo da pesquisa (`PriceResearchRecalculated` logo depois). Tudo na transação do comando.
 */
async function persistTransition(
  deps: {
    readonly sources: PriceSourceRepository;
    readonly recalculator: QuotationRecalculator;
    readonly presenter: PriceSourcePresenter;
  },
  tx: TenantTx,
  input: {
    readonly before: Quotation;
    readonly next: Quotation;
    readonly source: PriceSource;
    readonly research: PriceResearch;
    readonly expectedVersion: number;
    readonly stamp: { readonly now: Date; readonly userId: string | null };
    readonly record: (saved: Quotation) => Promise<void>;
  },
): Promise<QuotationChange> {
  try {
    await deps.sources.updateQuotation(tx, input.next, input.expectedVersion);
  } catch (error) {
    if (error instanceof VersionConflictError) {
      const latest = await deps.sources.findQuotation(tx, input.before.id);
      if (latest === null) throw quotationNotFound();
      throw quotationVersionConflict(latest.version);
    }
    throw error;
  }
  const saved = { ...input.next, version: input.expectedVersion + 1 };
  await touchSource(deps.sources, tx, input.source, input.stamp, input.source.version);
  await input.record(saved);
  await deps.recalculator.recalculate(tx, input.research, input.stamp);
  return { dto: deps.presenter.quotation(saved, { masked: false }), quotation: saved };
}

/** `ExcludeQuotationCommand` — PRS-16 (fluxo principal 3 · FA-01/02/03 · RN-PRICE-30..34). */
@Injectable()
export class ExcludeQuotationCommand extends PriceSourceCommand<
  ExcludeQuotationInput,
  QuotationChange
> {
  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) transactions: PriceResearchTransactions,
    @Inject(PRICE_RESEARCH_CLOCK) clock: PriceResearchClock,
    @Inject(PRICE_SOURCE_REPOSITORY) private readonly sources: PriceSourceRepository,
    private readonly gate: PriceSourceGate,
    private readonly recalculator: QuotationRecalculator,
    private readonly presenter: PriceSourcePresenter,
    private readonly recorder: PriceSourceRecorder,
  ) {
    // `<nome>_failed` = `price_research.exclude_failed` ("Logs").
    super('price_research.exclude', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { quotationId, body, expectedVersion }: ExcludeQuotationInput,
    { now }: Prepared,
  ): Promise<QuotationChange> {
    const { context, quotation, source } = await writableQuotation(
      tx,
      this.sources,
      this.gate,
      quotationId,
      expectedVersion,
      EXCLUDE_QUOTATION_OPTIONS,
    );
    const blocked = excludeBlockedBy(quotation);
    if (blocked !== null) throw quotationInvalidState(blocked);
    const stamp = this.stamp(now);
    const next = excludeQuotation(quotation, {
      reason: body.exclusionReason,
      justification: body.exclusionJustification,
      ...stamp,
    });
    return persistTransition(
      { sources: this.sources, recalculator: this.recalculator, presenter: this.presenter },
      tx,
      {
        before: quotation,
        next,
        source,
        research: context.research,
        expectedVersion,
        stamp,
        record: (saved) => this.recorder.quotationExcluded(tx, saved, context.research.processId),
      },
    );
  }

  protected override committed({ quotation }: QuotationChange): void {
    // Nunca a justificativa (texto livre — "Logs").
    this.logger.log(
      {
        event: 'price_research.quotation_excluded',
        quotationId: quotation.id,
        priceItemId: quotation.priceItemId,
        reason: quotation.exclusionReason,
        ...logContext(),
      },
      'price_research.quotation_excluded',
    );
  }
}

/** `RestoreQuotationCommand` — PRS-17 (fluxo principal 5 · RN-PRICE-32). */
@Injectable()
export class RestoreQuotationCommand extends PriceSourceCommand<
  RestoreQuotationInput,
  QuotationChange
> {
  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) transactions: PriceResearchTransactions,
    @Inject(PRICE_RESEARCH_CLOCK) clock: PriceResearchClock,
    @Inject(PRICE_SOURCE_REPOSITORY) private readonly sources: PriceSourceRepository,
    private readonly gate: PriceSourceGate,
    private readonly recalculator: QuotationRecalculator,
    private readonly presenter: PriceSourcePresenter,
    private readonly recorder: PriceSourceRecorder,
  ) {
    super('price_research.restore', transactions, clock);
  }

  protected async handle(
    tx: TenantTx,
    { quotationId, expectedVersion }: RestoreQuotationInput,
    { now }: Prepared,
  ): Promise<QuotationChange> {
    const { context, quotation, source } = await writableQuotation(
      tx,
      this.sources,
      this.gate,
      quotationId,
      expectedVersion,
      EXCLUDE_QUOTATION_OPTIONS,
    );
    const blocked = restoreBlockedBy(quotation);
    if (blocked !== null) throw quotationInvalidState(blocked);
    const stamp = this.stamp(now);
    const next = restoreQuotation(quotation, stamp);
    return persistTransition(
      { sources: this.sources, recalculator: this.recalculator, presenter: this.presenter },
      tx,
      {
        before: quotation,
        next,
        source,
        research: context.research,
        expectedVersion,
        stamp,
        record: (saved) => this.recorder.quotationRestored(tx, saved, context.research.processId),
      },
    );
  }

  protected override committed({ quotation }: QuotationChange): void {
    this.logger.log(
      {
        event: 'price_research.quotation_restored',
        quotationId: quotation.id,
        priceItemId: quotation.priceItemId,
        ...logContext(),
      },
      'price_research.quotation_restored',
    );
  }
}
