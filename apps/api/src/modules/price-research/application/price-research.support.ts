import type { PermissionCode } from '@contrataflow/types';
import {
  PRICE_RESEARCH_MESSAGES,
  PRICE_SOURCE_MESSAGES,
  PriceResearchRecalculated,
} from '@contrataflow/validation';
import type {
  PriceItemDto,
  PriceResearchAction,
  PriceResearchDto,
  PriceResearchLockReason,
  PriceResearchMeta,
  PriceResearchSummaryDto,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditChange, AuditTrailPort } from '#shared/audit/audit-trail.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';
import { ProcessItemCatalogRegistry } from '#shared/process/process-item-catalog.js';
import type { ProcessItemReference } from '#shared/process/process-item-catalog.js';

import { PRICE_RESEARCH_REPOSITORY, PRICE_SOURCE_REPOSITORY } from './ports.js';
import type { PriceResearchRepository, PriceSourceRepository } from './ports.js';
import { confidentialEditDenied, priceResearchNotFound } from './price-research.errors.js';
import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import type { Document, TypedDocumentView } from '../../document/application/document.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import {
  defaultQuantity,
  parametersSnapshot,
  PRICE_RESEARCH_SETTING_KEYS,
} from '../domain/price-research.js';
import type { PriceItem, PriceResearch, ResearchableItem } from '../domain/price-research.js';

/*
 * Peças comuns dos casos de uso da pesquisa de preços (US-024): a guarda (visibilidade — DEC-024 —,
 * POL-02 estendida pela fachada do `document`, que trava o documento dono, documento editável e
 * POL-09 para editar — RN-PRICE-12), os itens do processo pesquisáveis (RN-PRICE-04: quantidade do
 * processo → ETP → DFD, unidade inteira × decimal), o snapshot das configurações (RN-PRICE-05), o
 * apresentador (POL-09 nos valores) e a gravação dos efeitos na mesma transação (auditoria e
 * `PriceResearchRecalculated`).
 */

const COLLECTION = {
  systemModule: 'PRICE_RESEARCH',
  deniedDetail: PRICE_RESEARCH_MESSAGES.permissionDenied,
  lockedDetail: PRICE_RESEARCH_MESSAGES.locked,
} as const;

/** US-027: desconsiderar/restaurar cotação tem permissão própria (permissions.md — risco M). */
export const EXCLUDE_QUOTATION_PERMISSION: PermissionCode = 'PRICE_RESEARCH_EXCLUDE_QUOTATION';

/** Troca da permissão de edição pela de desconsiderar/restaurar cotação (PRS-16/17). */
export interface WritableOptions {
  readonly permission?: PermissionCode;
  readonly deniedDetail?: string;
}

/** US-032: concluir a pesquisa (PRS-23) tem permissão própria (permissions.md — risco M). */
export const COMPLETE_PERMISSION: PermissionCode = 'PRICE_RESEARCH_COMPLETE';

export const EXCLUDE_QUOTATION_OPTIONS: WritableOptions = {
  permission: EXCLUDE_QUOTATION_PERMISSION,
  deniedDetail: PRICE_SOURCE_MESSAGES.excludePermissionDenied,
};

const EDITABLE_STATUSES = new Set(['DRAFT', 'RETURNED']);

const isNotFound = (error: unknown) => error instanceof ApiError && error.code === 'NOT_FOUND';

/** A pesquisa visível ao usuário, com o documento (ações, sigilo e POL-09). */
export interface PriceResearchReadContext {
  readonly research: PriceResearch;
  readonly view: TypedDocumentView;
  readonly masked: boolean;
  readonly lockReason: PriceResearchLockReason | null;
  /** US-027: o usuário pode desconsiderar/restaurar cotações agora (permissão + travas de edição). */
  readonly canExcludeQuotation: boolean;
  /** US-032: o usuário pode concluir a pesquisa agora (`PRICE_RESEARCH_COMPLETE` + travas). */
  readonly canComplete: boolean;
}

@Injectable()
export class PriceResearchGate {
  constructor(
    @Inject(PRICE_RESEARCH_REPOSITORY) private readonly researches: PriceResearchRepository,
    private readonly documents: DocumentFacade,
  ) {}

  /**
   * PRS-03/05: a pesquisa e o documento visíveis (senão 404 indistinguível) e, sem lançar nem
   * auditar, por que o usuário não pode alterá-la agora (as ações exibidas na SCR-009).
   */
  async readable(tx: TenantTx, researchId: string): Promise<PriceResearchReadContext> {
    const research = await this.researches.findById(tx, researchId);
    if (research === null) throw priceResearchNotFound();
    const view = await this.documents.typedDocumentIn(tx, research.documentId);
    if (view === null) throw priceResearchNotFound();
    const masked = view.isBudgetConfidential && !view.canViewConfidentialBudget;
    return {
      research,
      view,
      masked,
      lockReason: await this.lockReasonOf(tx, research, view),
      canExcludeQuotation: await this.canExcludeQuotation(tx, research, view),
      canComplete: await this.canComplete(tx, research, view),
    };
  }

  /**
   * US-032: o usuário pode concluir a pesquisa agora — `PRICE_RESEARCH_COMPLETE` cobrindo o processo
   * + as travas da POL-02 (o botão "Concluir pesquisa" da SCR-009; a completude é do PRS-23).
   */
  async canComplete(
    tx: TenantTx,
    research: PriceResearch,
    view: TypedDocumentView,
  ): Promise<boolean> {
    return (await this.lockReasonOf(tx, research, view, COMPLETE_PERMISSION)) === null;
  }

  /**
   * US-027: o usuário pode desconsiderar/restaurar cotações agora — `PRICE_RESEARCH_EXCLUDE_QUOTATION`
   * cobrindo o processo + as travas de edição da POL-02 (a `meta.allowedActions` da SCR-009).
   */
  async canExcludeQuotation(
    tx: TenantTx,
    research: PriceResearch,
    view: TypedDocumentView,
  ): Promise<boolean> {
    return (
      (await this.lockReasonOf(tx, research, view, EXCLUDE_QUOTATION_OPTIONS.permission)) === null
    );
  }

  /**
   * PRS-04/06/08 (RN-PRICE-10/12): 404 como `readable`; POL-02 estendida (403
   * `PERMISSION_DENIED` com `access.denied`, 403 sem custódia/participação, 409
   * `INVALID_PROCESS_STATUS`, 422 de etapa — o documento dono fica travado); documento em
   * `DRAFT`/`RETURNED` (409 `DOCUMENT_NOT_EDITABLE`); POL-09 em processo sigiloso (403). Por fim
   * trava a linha da pesquisa (`FOR UPDATE`) e a devolve relida.
   */
  async writable(
    tx: TenantTx,
    researchId: string,
    options: WritableOptions = {},
  ): Promise<PriceResearchReadContext> {
    const found = await this.researches.findById(tx, researchId);
    if (found === null) throw priceResearchNotFound();
    try {
      await this.documents.assertTypedCollectionWritableIn(tx, {
        processId: found.processId,
        ...COLLECTION,
        ...options,
      });
    } catch (error) {
      if (isNotFound(error)) throw priceResearchNotFound();
      throw error;
    }
    const view = await this.documents.typedDocumentIn(tx, found.documentId);
    if (view === null) throw priceResearchNotFound();
    if (!EDITABLE_STATUSES.has(view.document.status)) {
      throw new ApiError('DOCUMENT_NOT_EDITABLE', {
        detail: PRICE_RESEARCH_MESSAGES.locked,
        extensions: { meta: { documentId: view.document.id, status: view.document.status } },
      });
    }
    if (view.isBudgetConfidential && !view.canViewConfidentialBudget) {
      throw confidentialEditDenied();
    }
    const research = await this.researches.lockById(tx, researchId);
    if (research === null) throw priceResearchNotFound();
    return {
      research,
      view,
      masked: false,
      lockReason: null,
      canExcludeQuotation: true,
      canComplete: true,
    };
  }

  /** O processo visível (404) e o estado da coleção — PRS-01. */
  collection(tx: TenantTx, processId: string) {
    return this.documents.typedCollectionStateIn(tx, { processId, ...COLLECTION });
  }

  private async lockReasonOf(
    tx: TenantTx,
    research: PriceResearch,
    view: TypedDocumentView,
    permission?: PermissionCode,
  ): Promise<PriceResearchLockReason | null> {
    const state = await this.documents.typedCollectionStateIn(tx, {
      processId: research.processId,
      ...COLLECTION,
      ...(permission === undefined ? {} : { permission }),
    });
    if (state.lockReason !== null && state.lockReason !== 'DOCUMENT_NOT_EDITABLE') {
      return state.lockReason;
    }
    if (!EDITABLE_STATUSES.has(view.document.status)) return 'DOCUMENT_NOT_EDITABLE';
    if (view.isBudgetConfidential && !view.canViewConfidentialBudget) return 'CONFIDENTIAL_BUDGET';
    return null;
  }
}

/** O item do processo pesquisável, com o que a SCR-009 exibe. */
export interface ResearchProcessItem extends ResearchableItem {
  readonly reference: ProcessItemReference;
  readonly unitLabel: string;
}

@Injectable()
export class ResearchItemsReader {
  constructor(
    private readonly catalog: ProcessItemCatalogRegistry,
    private readonly catalogs: CatalogFacade,
    private readonly documents: DocumentFacade,
  ) {}

  /**
   * Itens não excluídos do processo por `sequence`, com a unidade (`allowsDecimal`) e a quantidade
   * padrão (RN-PRICE-04: processo → ETP não cancelado → DFD).
   */
  async available(tx: TenantTx, processId: string): Promise<ResearchProcessItem[]> {
    const references = await this.catalog.listActive(tx, processId);
    if (references.length === 0) return [];
    const units = await this.catalogs.unitsOf(
      tx,
      references.map((item) => item.unitOfMeasureId),
    );
    const fromDocuments = await this.documents.itemQuantitiesIn(tx, processId, ['ETP', 'DFD']);
    return references.map((reference) => {
      const unit = units.get(reference.unitOfMeasureId);
      return {
        id: reference.id,
        sequence: reference.sequence,
        allowsDecimal: unit?.allowsDecimal ?? true,
        defaultQuantity: defaultQuantity(
          reference.referenceQuantity,
          fromDocuments.get(reference.id),
        ),
        reference,
        unitLabel: unit?.label ?? '',
      };
    });
  }

  /**
   * Trava com `FOR SHARE` os itens que vão entrar na pesquisa (corrida com a exclusão do item —
   * US-006): devolve os ids que continuam válidos (do processo e não excluídos).
   */
  async lock(tx: TenantTx, processId: string, itemIds: readonly string[]): Promise<Set<string>> {
    return new Set(
      (await this.catalog.lockForShare(tx, processId, itemIds)).map((item) => item.id),
    );
  }
}

@Injectable()
export class PriceParametersReader {
  constructor(private readonly tenancy: TenancyFacade) {}

  /** RN-PRICE-05: os valores vigentes de `priceResearch.*` no tenant da transação (sem cache). */
  async current(tx: TenantTx) {
    return parametersSnapshot(await this.tenancy.settingValues(tx, PRICE_RESEARCH_SETTING_KEYS));
  }
}

type DocumentSummary = Pick<
  Document,
  | 'code'
  | 'title'
  | 'status'
  | 'confidentiality'
  | 'templateVersionId'
  | 'version'
  | 'draftRevision'
  | 'pendingApprovalId'
>;

const EDIT_ACTIONS: readonly PriceResearchAction[] = ['UPDATE', 'ADD_ITEMS', 'REMOVE_ITEMS'];

@Injectable()
export class PriceResearchPresenter {
  constructor(
    @Inject(PRICE_SOURCE_REPOSITORY) private readonly sources: PriceSourceRepository,
    private readonly catalog: ProcessItemCatalogRegistry,
    private readonly catalogs: CatalogFacade,
  ) {}

  /** `PriceResearch` (PRS-02/03/04): POL-09 no total estimado (RN-PRICE-12). */
  research(
    research: PriceResearch,
    document: DocumentSummary,
    options: { readonly masked: boolean },
  ): PriceResearchDto {
    return {
      id: research.id,
      documentId: research.documentId,
      processId: research.processId,
      code: document.code,
      title: document.title,
      status: document.status,
      confidentiality: document.confidentiality,
      templateVersionId: document.templateVersionId,
      documentVersion: document.version,
      draftRevision: document.draftRevision,
      referenceDate: research.referenceDate,
      parameters: { ...research.parameters },
      itemsCount: research.itemsCount,
      itemsWithAlertsCount: research.itemsWithAlertsCount,
      totalEstimatedValue: options.masked ? null : research.totalEstimatedValue,
      totalEstimatedValueMasked: options.masked,
      lastCalculatedAt: research.lastCalculatedAt?.toISOString() ?? null,
      completedAt: research.completedAt?.toISOString() ?? null,
      pendingApprovalId: document.pendingApprovalId,
      createdAt: research.createdAt.toISOString(),
      updatedAt: research.updatedAt.toISOString(),
      version: research.version,
    };
  }

  summary(
    research: PriceResearch,
    document: { readonly code: string | null; readonly status: Document['status'] },
    title: string,
  ): PriceResearchSummaryDto {
    return {
      id: research.id,
      documentId: research.documentId,
      code: document.code,
      title,
      status: document.status,
      referenceDate: research.referenceDate,
      itemsCount: research.itemsCount,
      itemsWithAlertsCount: research.itemsWithAlertsCount,
      version: research.version,
    };
  }

  /** `meta`: ações da pesquisa, do documento, motivo do bloqueio e o template fixado. */
  meta(
    template: TypedDocumentView['template'],
    documentActions: TypedDocumentView['allowedActions'],
    lockReason: PriceResearchLockReason | null,
    canExcludeQuotation = false,
    canComplete = false,
  ): PriceResearchMeta {
    return {
      // `lockReason` explica só a edição; desconsiderar cotação (US-027) e concluir (US-032) têm
      // permissão própria.
      allowedActions: [
        ...(lockReason === null ? EDIT_ACTIONS : []),
        ...(canExcludeQuotation ? (['EXCLUDE_QUOTATION'] as const) : []),
        ...(canComplete ? (['COMPLETE'] as const) : []),
      ],
      documentActions: [...documentActions],
      lockReason,
      template:
        template === null
          ? null
          : {
              versionId: template.id,
              versionNumber: template.versionNumber,
              sections: [...template.sections]
                .sort((a, b) => a.order - b.order)
                .map((section) => ({
                  key: section.key,
                  title: section.title,
                  order: section.order,
                  requirement: section.requirement,
                  helpText: section.helpText ?? null,
                  legalBasis: section.legalBasis ?? null,
                  minChars: section.minChars ?? null,
                  maxChars: section.maxChars,
                })),
            },
    };
  }

  /** `PriceItem` (PRS-05/06): o item do processo para exibição e POL-09 nos valores. */
  async items(
    tx: TenantTx,
    processId: string,
    items: readonly PriceItem[],
    options: { readonly masked: boolean },
  ): Promise<PriceItemDto[]> {
    if (items.length === 0) return [];
    const references = new Map(
      (await this.catalog.listActive(tx, processId)).map((item) => [item.id, item]),
    );
    const units = await this.catalogs.unitsOf(
      tx,
      [...references.values()].map((item) => item.unitOfMeasureId),
    );
    const quotations = await this.sources.quotationCounts(
      tx,
      items.map((item) => item.id),
    );
    const money = (value: string | null) => (options.masked ? null : value);
    return items.map((item) => {
      const reference = references.get(item.processItemId);
      const unit = reference === undefined ? undefined : units.get(reference.unitOfMeasureId);
      return {
        id: item.id,
        priceResearchId: item.priceResearchId,
        processItemId: item.processItemId,
        sequence: reference?.sequence ?? item.sortOrder,
        lotNumber: reference?.lotNumber ?? null,
        lotName: reference?.lotName ?? null,
        description: reference?.description ?? '',
        unit: {
          id: reference?.unitOfMeasureId ?? item.processItemId,
          label: unit?.label ?? '',
          allowsDecimal: unit?.allowsDecimal ?? true,
        },
        quantity: item.quantity,
        methodOverride: item.methodOverride,
        effectiveMethod: item.effectiveMethod,
        validQuotationsCount: item.validQuotationsCount,
        quotationsCount: quotations.get(item.id) ?? 0,
        meanPrice: money(item.meanPrice),
        medianPrice: money(item.medianPrice),
        lowestPrice: money(item.lowestPrice),
        highestPrice: money(item.highestPrice),
        stdDeviation: money(item.stdDeviation),
        // O CV é adimensional (%), mas revela a dispersão dos preços sigilosos: mascarado também.
        coefficientOfVariation: money(item.coefficientOfVariation),
        manualUnitPrice: money(item.manualUnitPrice),
        manualJustification: item.manualJustification,
        recommendedUnitPrice: money(item.recommendedUnitPrice),
        recommendedUnitPriceMasked: options.masked,
        totalPrice: money(item.totalPrice),
        valuesMasked: options.masked,
        belowMinimumJustification: item.belowMinimumJustification,
        alerts: item.alerts.map((alert) => ({ code: alert.code })),
        calculatedAt: item.calculatedAt?.toISOString() ?? null,
        sortOrder: item.sortOrder,
        version: item.version,
      };
    });
  }
}

/**
 * Efeitos gravados na mesma transação (US-024 · "Auditoria"/"Eventos gerados"): nunca preços,
 * totais, títulos nem descrições — o título vai como impressão digital.
 */
@Injectable()
export class PriceResearchRecorder {
  constructor(
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
  ) {}

  /** `PriceResearchRecalculated` (PRS-04/06/08): ids e contadores. */
  async recalculated(tx: TenantTx, research: PriceResearch): Promise<void> {
    await this.outbox.record(
      tx,
      PriceResearchRecalculated.of({
        aggregateId: research.id,
        processId: research.processId,
        payload: {
          priceResearchId: research.id,
          itemsCount: research.itemsCount,
          itemsWithAlertsCount: research.itemsWithAlertsCount,
        },
      }),
    );
  }

  /**
   * `price_research.recalculate` (US-029 · RN-PRICE-45): a cada recálculo concluído — contadores e o
   * gatilho, nunca valores.
   */
  async recalculationAudited(
    tx: TenantTx,
    research: PriceResearch,
    trigger: string,
    alertsChanged: boolean,
  ): Promise<void> {
    await this.audit.record(tx, {
      action: 'price_research.recalculate',
      entityType: 'PriceResearch',
      entityId: research.id,
      processId: research.processId,
      metadata: {
        priceResearchId: research.id,
        itemsCount: research.itemsCount,
        itemsWithAlertsCount: research.itemsWithAlertsCount,
        trigger,
        // US-030 ("Auditoria"): o conjunto de alertas de algum item mudou neste recálculo.
        alertsChanged,
      },
    });
  }

  /**
   * `price_research.method_change` (US-029): o `methodOverride` do item (PRS-07) ou os parâmetros de
   * cálculo da pesquisa (PRS-04), antigos e novos. Sem preço manual nem justificativa em claro.
   */
  async methodChanged(
    tx: TenantTx,
    research: PriceResearch,
    input: {
      readonly entityType: 'PriceItem' | 'PriceResearch';
      readonly entityId: string;
      readonly changes: readonly AuditChange[];
      readonly priceItemId?: string;
    },
  ): Promise<void> {
    await this.audit.record(tx, {
      action: 'price_research.method_change',
      entityType: input.entityType,
      entityId: input.entityId,
      processId: research.processId,
      changes: input.changes,
      metadata: {
        priceResearchId: research.id,
        ...(input.priceItemId === undefined ? {} : { priceItemId: input.priceItemId }),
      },
    });
  }

  /** `document.draft_update` (PRS-04): data-base/título antigos e novos. */
  async headerUpdated(
    tx: TenantTx,
    research: PriceResearch,
    changes: readonly AuditChange[],
    documentCode: string | null,
  ): Promise<void> {
    await this.audit.record(tx, {
      action: 'document.draft_update',
      entityType: 'Document',
      entityId: research.documentId,
      processId: research.processId,
      changes,
      metadata: {
        documentTypeCode: 'PRICE_RESEARCH',
        documentCode,
        field: changes.map((change) => change.path).join(','),
        priceResearchId: research.id,
      },
    });
  }

  /** `document.items_update` (PRS-06/08): itens incluídos/removidos com a quantidade. */
  async itemsUpdated(
    tx: TenantTx,
    research: PriceResearch,
    input: {
      readonly added: readonly PriceItem[];
      readonly removed: readonly PriceItem[];
      readonly quotationsRemoved: number;
      readonly documentCode: string | null;
    },
  ): Promise<void> {
    const line = (item: PriceItem) => ({
      priceItemId: item.id,
      processItemId: item.processItemId,
      quantity: item.quantity,
    });
    await this.audit.record(tx, {
      action: 'document.items_update',
      entityType: 'Document',
      entityId: research.documentId,
      processId: research.processId,
      changes: [
        ...(input.added.length === 0
          ? []
          : [{ path: 'items.added', old: null, new: input.added.map(line) }]),
        ...(input.removed.length === 0
          ? []
          : [{ path: 'items.removed', old: input.removed.map(line), new: null }]),
      ],
      metadata: {
        documentTypeCode: 'PRICE_RESEARCH',
        documentCode: input.documentCode,
        priceResearchId: research.id,
        quotationsRemoved: input.quotationsRemoved,
      },
    });
  }
}
