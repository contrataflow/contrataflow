import type { Violation } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditChange, AuditTrailPort } from '#shared/audit/audit-trail.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { sha256Hex } from '#shared/integrity/canonical-json.js';
import { ProcessItemCatalogRegistry } from '#shared/process/process-item-catalog.js';

import { ComparativeMapAssembler } from './comparative-map.queries.js';
import { PRICE_RESEARCH_REPOSITORY } from './ports.js';
import type { PriceResearchRepository } from './ports.js';
import type {
  DocumentFinalizedFacts,
  DocumentValidationSubject,
  DocumentValidator,
  TypedSnapshotParts,
} from '../../document/application/document.facade.js';
import { ProcessFacade } from '../../process/application/process.facade.js';
import type { PriceResearchReferenceResult } from '../../process/application/process.facade.js';
import { comparativeMapSnapshot } from '../domain/comparative-map.js';
import {
  completedSummary,
  completeResearch,
  completionReference,
  completionViolations,
} from '../domain/price-research-completion.js';
import type { PriceItem, PriceResearch } from '../domain/price-research.js';

/*
 * `PriceResearchDocumentValidator` (porta `DocumentValidator` da US-065) do documento
 * `PRICE_RESEARCH`:
 * - US-031: o mapa comparativo no snapshot — as coleções `priceSummary*` que a seção computada
 *   `PRICE_SUMMARY` renderiza no PDF (sem máscara: o `document` aplica a POL-09 da rendition);
 * - US-032: as regras de completude da conclusão (RN-PRICE-58/59 — também no DOC-08/10), o
 *   `typedSummary` do `PriceResearchCompleted` (RN-PRICE-63), os textos de exceção de cada item na
 *   versão (FA-02) e, no gancho `finalized`, a conclusão na MESMA transação da finalização: cabeçalho
 *   concluído, `ProcessItem.referenceUnitPrice`, `Process.estimatedValue` (RN-PRICE-60..62) e a
 *   auditoria `price_research.complete`. Concluir pelo PRS-23 ou finalizar pelo DOC-10 dá no mesmo.
 */

/** Campos de exceção de cada item congelados na versão (FA-02 — RN-PRICE-60). */
type ItemExceptionFields = Pick<
  PriceItem,
  'methodOverride' | 'manualUnitPrice' | 'manualJustification' | 'belowMinimumJustification'
>;

@Injectable()
export class PriceResearchDocumentValidator implements DocumentValidator {
  readonly module = 'PRICE_RESEARCH' as const;

  constructor(
    @Inject(PRICE_RESEARCH_REPOSITORY) private readonly researches: PriceResearchRepository,
    private readonly assembler: ComparativeMapAssembler,
    private readonly catalog: ProcessItemCatalogRegistry,
    private readonly processes: ProcessFacade,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
  ) {}

  /** RN-PRICE-58/59: uma violação por item pendente (vazio = pesquisa completa). */
  async validate(tx: TenantTx, subject: DocumentValidationSubject): Promise<readonly Violation[]> {
    const research = await this.researches.findById(tx, subject.document.id);
    if (research === null) return [];
    return this.violationsOf(tx, research, await this.researches.listItems(tx, research.id));
  }

  /** As pendências da conclusão (PRS-23 confere antes de finalizar, com a pesquisa travada). */
  async violationsOf(
    tx: TenantTx,
    research: PriceResearch,
    items: readonly PriceItem[],
  ): Promise<Violation[]> {
    const references = await this.catalog.listActive(tx, research.processId);
    const sequences = new Map(references.map((item) => [item.id, item.sequence]));
    return completionViolations(items, sequences, research.parameters.minQuotations);
  }

  /** RN-PRICE-63: contadores e a marca de sigilo — nunca o valor (DEC-030). */
  async typedSummary(
    tx: TenantTx,
    subject: DocumentValidationSubject,
  ): Promise<Readonly<Record<string, unknown>> | null> {
    const research = await this.researches.findById(tx, subject.document.id);
    if (research === null) return null;
    const confidential = await this.processes.isBudgetConfidentialIn(tx, research.processId);
    return { ...completedSummary(research, confidential === true) };
  }

  async snapshotParts(
    tx: TenantTx,
    subject: DocumentValidationSubject,
  ): Promise<TypedSnapshotParts> {
    const research = await this.researches.findById(tx, subject.document.id);
    if (research === null) return { header: {}, collections: {} };
    const map = await this.assembler.assemble(tx, research, subject.document);
    const collections = comparativeMapSnapshot(map);
    const exceptions = new Map<string, ItemExceptionFields>(
      (await this.researches.listItems(tx, research.id)).map((item) => [
        item.id,
        {
          methodOverride: item.methodOverride,
          manualUnitPrice: item.manualUnitPrice,
          manualJustification: item.manualJustification,
          belowMinimumJustification: item.belowMinimumJustification,
        },
      ]),
    );
    return {
      header: {},
      collections: Object.fromEntries(
        Object.entries(collections).map(([key, rows]) => [
          key,
          rows.map((row) => withExceptions(row, exceptions)),
        ]),
      ),
    };
  }

  /**
   * RN-PRICE-60..62: a conclusão dentro da finalização do documento (trava a pesquisa — no PRS-23
   * ela já está travada pela guarda). Falha aqui desfaz tudo, inclusive o documento `FINALIZED`.
   */
  async finalized(
    tx: TenantTx,
    subject: DocumentValidationSubject,
    facts: DocumentFinalizedFacts,
  ): Promise<void> {
    const research = await this.researches.lockById(tx, subject.document.id);
    if (research === null) throw new Error('Pesquisa de preços ausente na finalização.');
    const items = await this.researches.listItems(tx, research.id);
    const completed = completeResearch(research, { actorId: facts.actorId, now: facts.now });
    await this.researches.update(tx, completed, research.version);
    const reference = completionReference(items);
    const result = await this.processes.applyPriceResearchReferenceIn(tx, {
      processId: research.processId,
      sourceDocumentId: research.documentId,
      unitPrices: reference.unitPrices,
      estimatedValue: reference.estimatedValue,
      at: facts.now,
      userId: facts.actorId,
    });
    await this.audit.record(tx, {
      action: 'price_research.complete',
      entityType: 'PriceResearch',
      entityId: research.id,
      processId: research.processId,
      changes: estimatedValueChanges(result),
      metadata: {
        priceResearchId: research.id,
        documentVersionId: facts.documentVersionId,
        itemsCount: research.itemsCount,
        itemsWithAlertsCount: research.itemsWithAlertsCount,
        processItemsUpdated: result.itemsUpdated,
        estimatedValueSource: result.estimatedValueSource,
        estimatedValueApplied: result.estimatedValueApplied,
        idempotencyKey: facts.idempotencyKey,
      },
    });
  }
}

/** A linha de item do snapshot com os campos de exceção do `PriceItem` (as demais, intactas). */
function withExceptions(
  row: unknown,
  exceptions: ReadonlyMap<string, ItemExceptionFields>,
): unknown {
  if (row === null || typeof row !== 'object') return row;
  const id = (row as { readonly id?: unknown }).id;
  const fields = typeof id === 'string' ? exceptions.get(id) : undefined;
  return fields === undefined ? row : { ...row, ...fields };
}

/** Valor sigiloso na auditoria: hash + marca de mascarado (POL-09 · "Auditoria" da US-032). */
function auditValue(value: string | null, confidential: boolean): unknown {
  if (value === null || !confidential) return value;
  return { masked: true, sha256: sha256Hex(value) };
}

function estimatedValueChanges(result: PriceResearchReferenceResult): AuditChange[] {
  const changes: AuditChange[] = [];
  if (result.previousEstimatedValue !== result.estimatedValue) {
    changes.push({
      path: 'estimatedValue',
      old: auditValue(result.previousEstimatedValue, result.isBudgetConfidential),
      new: auditValue(result.estimatedValue, result.isBudgetConfidential),
    });
  }
  if (result.previousSource !== result.estimatedValueSource) {
    changes.push({
      path: 'estimatedValueSource',
      old: result.previousSource,
      new: result.estimatedValueSource,
    });
  }
  return changes;
}
