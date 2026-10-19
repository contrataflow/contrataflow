import { createHash } from 'node:crypto';

import {
  PRICE_SOURCE_MESSAGES,
  QuotationExcluded,
  QuotationRestored,
} from '@contrataflow/validation';
import type { PriceSourceDto, QuotationDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditChange, AuditTrailPort } from '#shared/audit/audit-trail.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { PRICE_RESEARCH_REPOSITORY, PRICE_SOURCE_REPOSITORY } from './ports.js';
import type { PriceResearchRepository, PriceSourceRepository } from './ports.js';
import {
  priceResearchVersionConflict,
  priceSourceNotFound,
  priceSourceVersionConflict,
} from './price-research.errors.js';
import { PriceResearchGate, PriceResearchRecorder } from './price-research.support.js';
import type { PriceResearchReadContext, WritableOptions } from './price-research.support.js';
import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import type { PriceSourceTypeRef } from '../../catalog/application/catalog.facade.js';
import { SupplierFacade } from '../../supplier/application/supplier.facade.js';
import { recalculate } from '../domain/price-research.js';
import type { PriceResearch } from '../domain/price-research.js';
import { isSourceExpired, validQuotationCounts } from '../domain/price-source.js';
import type {
  PriceSource,
  PriceSourceEditableField,
  PriceSourceTypeRules,
  Quotation,
} from '../domain/price-source.js';

/*
 * Peças comuns dos casos de uso de fontes e cotações (US-026): a guarda (a fonte/cotação visível e a
 * pesquisa editável — POL-02 estendida + POL-09, linha da pesquisa travada), o recálculo disparado
 * por toda gravação (RN-PRICE-26/27: validade das cotações, cotações válidas, alertas, contadores e
 * `PriceResearchRecalculated`), o apresentador (POL-09 nos preços) e a auditoria. Nunca preços,
 * descrições, URLs nem justificativas nos logs; na auditoria o texto livre vai como impressão digital.
 */

const isNotFound = (error: unknown) => error instanceof ApiError && error.code === 'NOT_FOUND';

/** Regras do tipo para o domínio (sem o que é só exibição). */
export function rulesOf(type: PriceSourceTypeRef): PriceSourceTypeRules {
  return {
    id: type.id,
    code: type.code,
    requiredFields: type.requiredFields,
    maxAgeDays: type.maxAgeDays,
    ageReference: type.ageReference,
  };
}

@Injectable()
export class PriceSourceGate {
  constructor(
    @Inject(PRICE_SOURCE_REPOSITORY) private readonly sources: PriceSourceRepository,
    private readonly gate: PriceResearchGate,
  ) {}

  /**
   * A pesquisa editável (PRS-10/13/…): `PriceResearchGate.writable` com a mensagem de V-08 no 409
   * `DOCUMENT_NOT_EDITABLE`. `notFound` traduz o 404 para o recurso da rota.
   */
  async writable(
    tx: TenantTx,
    researchId: string,
    notFound: () => ApiError,
    options: WritableOptions = {},
  ): Promise<PriceResearchReadContext> {
    try {
      return await this.gate.writable(tx, researchId, options);
    } catch (error) {
      if (isNotFound(error)) throw notFound();
      if (error instanceof ApiError && error.code === 'DOCUMENT_NOT_EDITABLE') {
        throw new ApiError('DOCUMENT_NOT_EDITABLE', {
          detail: PRICE_SOURCE_MESSAGES.notEditable,
          extensions: error.extensions,
        });
      }
      throw error;
    }
  }

  /**
   * A fonte visível e a pesquisa dela editável e travada; a fonte é relida depois da trava (a versão
   * conferida pelo `If-Match` é a vigente) — 404 se sumiu, 412 se a versão mudou.
   */
  async writableSource(
    tx: TenantTx,
    sourceId: string,
    expectedVersion: number | null,
  ): Promise<{ readonly context: PriceResearchReadContext; readonly source: PriceSource }> {
    const found = await this.sources.findSource(tx, sourceId);
    if (found === null) throw priceSourceNotFound();
    const context = await this.writable(tx, found.priceResearchId, priceSourceNotFound);
    const source = await this.sources.findSource(tx, sourceId);
    if (source === null) throw priceSourceNotFound();
    if (expectedVersion !== null && source.version !== expectedVersion) {
      throw priceSourceVersionConflict(source.version);
    }
    return { context, source };
  }
}

@Injectable()
export class PriceSourceRulesReader {
  constructor(private readonly catalogs: CatalogFacade) {}

  /** V-02: o tipo ativo do tenant (422 `REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`). */
  active(tx: TenantTx, sourceTypeId: string): Promise<PriceSourceTypeRef> {
    return this.catalogs.assertActivePriceSourceType(tx, sourceTypeId, 'sourceTypeId');
  }

  /** Tipos das fontes gravadas (mesmo inativos). Tipo ausente = catálogo corrompido (500). */
  async of(tx: TenantTx, ids: readonly string[]): Promise<ReadonlyMap<string, PriceSourceTypeRef>> {
    const types = await this.catalogs.priceSourceTypesOf(tx, ids);
    for (const id of ids) {
      if (!types.has(id)) throw new Error(`Tipo de fonte ${id} ausente do catálogo.`);
    }
    return types;
  }
}

@Injectable()
export class QuotationRecalculator {
  constructor(
    @Inject(PRICE_RESEARCH_REPOSITORY) private readonly researches: PriceResearchRepository,
    @Inject(PRICE_SOURCE_REPOSITORY) private readonly sources: PriceSourceRepository,
    private readonly rules: PriceSourceRulesReader,
    private readonly recorder: PriceResearchRecorder,
  ) {}

  /**
   * RN-PRICE-26: reavalia `isExpired` das cotações das fontes informadas (todas, sem `sourceIds`)
   * contra a data-base e a validade do tipo; grava só as que mudaram (`version + 1`).
   */
  async refreshExpiry(
    tx: TenantTx,
    research: PriceResearch,
    input: {
      readonly timezone: string;
      readonly stamp: { readonly now: Date; readonly userId: string | null };
      readonly sourceIds?: readonly string[];
    },
  ): Promise<number> {
    const wanted = input.sourceIds === undefined ? null : new Set(input.sourceIds);
    const sources = (await this.sources.listSources(tx, research.id)).filter(
      (source) => wanted === null || wanted.has(source.id),
    );
    if (sources.length === 0) return 0;
    const types = await this.rules.of(
      tx,
      sources.map((source) => source.sourceTypeId),
    );
    const byId = new Map(sources.map((source) => [source.id, source]));
    let changed = 0;
    for (const quotation of await this.sources.listQuotations(tx, research.id)) {
      const source = byId.get(quotation.priceSourceId);
      const type = source === undefined ? undefined : types.get(source.sourceTypeId);
      if (source === undefined || type === undefined) continue;
      const isExpired = isSourceExpired(source, rulesOf(type), research, input.timezone);
      if (isExpired === quotation.isExpired) continue;
      await this.sources.updateQuotation(
        tx,
        {
          ...quotation,
          isExpired,
          updatedAt: input.stamp.now,
          updatedById: input.stamp.userId,
        },
        quotation.version,
      );
      changed += 1;
    }
    return changed;
  }

  /**
   * RN-PRICE-27: depois de qualquer gravação de fonte/cotação, as cotações válidas e os alertas dos
   * itens, os contadores e `lastCalculatedAt` do cabeçalho (`version + 1` — a linha está travada) e
   * `PriceResearchRecalculated` (só ids e contadores). A estatística é da US-029.
   */
  async recalculate(
    tx: TenantTx,
    research: PriceResearch,
    stamp: { readonly now: Date; readonly userId: string | null },
  ): Promise<PriceResearch> {
    const items = await this.researches.listItems(tx, research.id);
    const quotations = await this.sources.listQuotations(tx, research.id);
    const result = recalculate(research, items, stamp, validQuotationCounts(quotations));
    await this.researches.updateItems(tx, result.changedItems);
    try {
      await this.researches.update(tx, result.research, research.version);
    } catch (error) {
      if (error instanceof VersionConflictError) {
        const latest = await this.researches.findById(tx, research.id);
        throw priceResearchVersionConflict(latest?.version ?? research.version + 1);
      }
      throw error;
    }
    const saved = { ...result.research, version: research.version + 1 };
    await this.recorder.recalculated(tx, saved);
    return saved;
  }
}

@Injectable()
export class PriceSourcePresenter {
  constructor(
    private readonly rules: PriceSourceRulesReader,
    private readonly suppliers: SupplierFacade,
  ) {}

  /** `Quotation` (PRS-09/13/14): POL-09 no preço (RN-PRICE-12). */
  quotation(quotation: Quotation, options: { readonly masked: boolean }): QuotationDto {
    return {
      id: quotation.id,
      priceResearchId: quotation.priceResearchId,
      priceItemId: quotation.priceItemId,
      priceSourceId: quotation.priceSourceId,
      unitPrice: options.masked ? null : quotation.unitPrice,
      unitPriceMasked: options.masked,
      brandModel: quotation.brandModel,
      status: quotation.status,
      exclusionReason: quotation.exclusionReason,
      exclusionJustification: quotation.exclusionJustification,
      outlierFlag: quotation.outlierFlag,
      isExpired: quotation.isExpired,
      createdAt: quotation.createdAt.toISOString(),
      updatedAt: quotation.updatedAt.toISOString(),
      version: quotation.version,
    };
  }

  /** `PriceSource` (PRS-09/10/11): tipo, fornecedor e as cotações da fonte. */
  async sources(
    tx: TenantTx,
    sources: readonly PriceSource[],
    quotations: readonly Quotation[],
    options: { readonly masked: boolean },
  ): Promise<PriceSourceDto[]> {
    if (sources.length === 0) return [];
    const types = await this.rules.of(
      tx,
      sources.map((source) => source.sourceTypeId),
    );
    const suppliers = await this.suppliers.summariesOf(
      tx,
      sources.flatMap((source) => (source.supplierId === null ? [] : [source.supplierId])),
    );
    return sources.map((source) => {
      const type = types.get(source.sourceTypeId);
      const supplier = source.supplierId === null ? undefined : suppliers.get(source.supplierId);
      return {
        id: source.id,
        priceResearchId: source.priceResearchId,
        sourceTypeId: source.sourceTypeId,
        sourceType: {
          id: source.sourceTypeId,
          code: type?.code ?? '',
          label: type?.label ?? '',
          isActive: type?.isActive ?? false,
          requiredFields: [...(type?.requiredFields ?? [])],
          maxAgeDays: type?.maxAgeDays ?? null,
        },
        description: source.description,
        supplierId: source.supplierId,
        supplier:
          supplier === undefined
            ? null
            : {
                id: supplier.id,
                legalName: supplier.legalName,
                documentNumber: supplier.documentNumber,
              },
        quoteDate: source.quoteDate,
        accessedAt: source.accessedAt?.toISOString() ?? null,
        url: source.url,
        referenceOrganization: source.referenceOrganization,
        referenceDocument: source.referenceDocument,
        supplierChoiceJustification: source.supplierChoiceJustification,
        notes: source.notes,
        sortOrder: source.sortOrder,
        quotations: quotations
          .filter((quotation) => quotation.priceSourceId === source.id)
          .map((quotation) => this.quotation(quotation, options)),
        createdAt: source.createdAt.toISOString(),
        updatedAt: source.updatedAt.toISOString(),
        version: source.version,
      };
    });
  }
}

/** Impressão digital de texto livre na auditoria (nunca o texto em claro — "Logs"). */
function fingerprint(
  text: string | null,
): { readonly sha256: string; readonly length: number } | null {
  return text === null
    ? null
    : { sha256: createHash('sha256').update(text).digest('hex'), length: text.length };
}

/** Campos cujo valor vai como impressão digital na auditoria (texto livre e URL). */
const FINGERPRINTED: ReadonlySet<PriceSourceEditableField> = new Set([
  'description',
  'url',
  'referenceOrganization',
  'referenceDocument',
  'supplierChoiceJustification',
  'notes',
]);

const auditValue = (field: PriceSourceEditableField, value: unknown) => {
  if (value instanceof Date) return value.toISOString();
  if (FINGERPRINTED.has(field)) return fingerprint(value as string | null);
  return value ?? null;
};

/**
 * Auditoria da US-026 ("Auditoria" — categoria `DATA_CHANGE`), na mesma transação. Nunca preços nem
 * texto livre em claro.
 */
@Injectable()
export class PriceSourceRecorder {
  constructor(
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
  ) {}

  async sourceCreated(
    tx: TenantTx,
    source: PriceSource,
    documentCode: string | null,
  ): Promise<void> {
    await this.audit.record(tx, {
      action: 'price_research.source_create',
      entityType: 'PriceSource',
      entityId: source.id,
      processId: source.processId,
      metadata: {
        sourceTypeId: source.sourceTypeId,
        priceResearchId: source.priceResearchId,
        documentCode,
      },
    });
  }

  async sourceUpdated(
    tx: TenantTx,
    before: PriceSource,
    after: PriceSource,
    changed: readonly PriceSourceEditableField[],
  ): Promise<void> {
    const changes: AuditChange[] = changed.map((field) => ({
      path: field,
      old: auditValue(field, before[field]),
      new: auditValue(field, after[field]),
    }));
    await this.audit.record(tx, {
      action: 'price_research.source_update',
      entityType: 'PriceSource',
      entityId: after.id,
      processId: after.processId,
      changes,
      metadata: { sourceTypeId: after.sourceTypeId, priceResearchId: after.priceResearchId },
    });
  }

  async sourceDeleted(tx: TenantTx, source: PriceSource, quotationsRemoved: number): Promise<void> {
    await this.audit.record(tx, {
      action: 'price_research.source_delete',
      entityType: 'PriceSource',
      entityId: source.id,
      processId: source.processId,
      metadata: {
        sourceTypeId: source.sourceTypeId,
        priceResearchId: source.priceResearchId,
        quotationsRemoved,
      },
    });
  }

  async quotation(
    tx: TenantTx,
    action:
      | 'price_research.quotation_create'
      | 'price_research.quotation_update'
      | 'price_research.quotation_delete',
    quotation: Quotation,
    processId: string,
  ): Promise<void> {
    await this.audit.record(tx, {
      action,
      entityType: 'Quotation',
      entityId: quotation.id,
      processId,
      metadata: {
        priceItemId: quotation.priceItemId,
        priceSourceId: quotation.priceSourceId,
        priceResearchId: quotation.priceResearchId,
      },
    });
  }

  /**
   * PRS-16 (US-027): `price_research.quotation_exclude` (motivo em `metadata`; a justificativa só
   * como impressão digital) e `QuotationExcluded` — ids e código do motivo, nunca o texto.
   */
  async quotationExcluded(tx: TenantTx, quotation: Quotation, processId: string): Promise<void> {
    await this.audit.record(tx, {
      action: 'price_research.quotation_exclude',
      entityType: 'Quotation',
      entityId: quotation.id,
      processId,
      changes: [
        { path: 'status', old: 'VALID', new: 'EXCLUDED' },
        {
          path: 'exclusionJustification',
          old: null,
          new: fingerprint(quotation.exclusionJustification),
        },
      ],
      metadata: {
        reason: quotation.exclusionReason,
        priceItemId: quotation.priceItemId,
        priceSourceId: quotation.priceSourceId,
        priceResearchId: quotation.priceResearchId,
      },
    });
    if (quotation.exclusionReason === null) return;
    await this.outbox.record(
      tx,
      QuotationExcluded.of({
        aggregateId: quotation.id,
        processId,
        payload: {
          priceResearchId: quotation.priceResearchId,
          quotationId: quotation.id,
          priceItemId: quotation.priceItemId,
          reason: quotation.exclusionReason,
        },
      }),
    );
  }

  /** PRS-17 (US-027): `price_research.quotation_restore` e `QuotationRestored`. */
  async quotationRestored(tx: TenantTx, quotation: Quotation, processId: string): Promise<void> {
    await this.audit.record(tx, {
      action: 'price_research.quotation_restore',
      entityType: 'Quotation',
      entityId: quotation.id,
      processId,
      changes: [{ path: 'status', old: 'EXCLUDED', new: 'VALID' }],
      metadata: {
        priceItemId: quotation.priceItemId,
        priceSourceId: quotation.priceSourceId,
        priceResearchId: quotation.priceResearchId,
      },
    });
    await this.outbox.record(
      tx,
      QuotationRestored.of({
        aggregateId: quotation.id,
        processId,
        payload: {
          priceResearchId: quotation.priceResearchId,
          quotationId: quotation.id,
          priceItemId: quotation.priceItemId,
        },
      }),
    );
  }
}
