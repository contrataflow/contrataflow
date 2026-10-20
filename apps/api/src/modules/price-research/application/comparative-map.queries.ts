import {
  COMPARATIVE_MAP_LIMITS,
  COMPARATIVE_MAP_MESSAGES,
  comparativeMapFileName,
  exceedsComparativeMapExport,
} from '@contrataflow/validation';
import type { ComparativeMapDto, ComparativeMapExportFormat } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { failureCodeOf, isUnexpectedFailure } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { ProcessItemCatalogRegistry } from '#shared/process/process-item-catalog.js';
import { writeXlsx } from '#shared/spreadsheet/xlsx.js';

import { comparativeMapSheet } from './comparative-map.xlsx.js';
import {
  PRICE_RESEARCH_REPOSITORY,
  PRICE_RESEARCH_TRANSACTIONS,
  PRICE_SOURCE_REPOSITORY,
} from './ports.js';
import type {
  PriceResearchRepository,
  PriceResearchTransactions,
  PriceSourceRepository,
} from './ports.js';
import { PriceSourceRulesReader } from './price-source-rules.js';
import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import { SupplierFacade } from '../../supplier/application/supplier.facade.js';
import { buildComparativeMap, comparativeMapFor } from '../domain/comparative-map.js';
import type { ComparativeMapItemRef } from '../domain/comparative-map.js';
import type { PriceResearch } from '../domain/price-research.js';

/*
 * Mapa comparativo (US-031 · PRS-21/22 · RN-PRICE-53..57). Visão somente leitura sobre as linhas
 * vigentes de `PriceItem`/`PriceSource`/`Quotation`, lidas numa ÚNICA transação de leitura
 * (`READ COMMITTED`): um recálculo concorrente (US-026/027/029) aparece inteiro ou não aparece —
 * nunca pela metade (FA-05). Visibilidade pelo `PROCESS_VIEW` (DEC-024): pesquisa inexistente, de
 * outro tenant ou de processo não visível → 404 `PRICE_RESEARCH_NOT_FOUND`. POL-09 decidido uma vez
 * por leitura e aplicado por `comparativeMapFor` — a mesma máscara para a tela e o XLSX. O PDF é a
 * renderização do documento (`PriceResearchDocumentValidator.snapshotParts`).
 * Nunca em log: preços, estatísticas nem o conteúdo do arquivo.
 */

export function comparativeMapNotFound(): ApiError {
  return new ApiError('PRICE_RESEARCH_NOT_FOUND', { detail: COMPARATIVE_MAP_MESSAGES.notFound });
}

/** V-01 (RN-PRICE-54): 422 `EXPORT_TOO_LARGE` com as contagens. */
function exportTooLarge(itemsCount: number, sourcesCount: number): ApiError {
  return new ApiError('EXPORT_TOO_LARGE', {
    status: 422,
    title: 'Exportação muito grande',
    detail: COMPARATIVE_MAP_MESSAGES.tooLarge,
    extensions: {
      meta: {
        itemsCount,
        sourcesCount,
        maxItems: COMPARATIVE_MAP_LIMITS.maxExportItems,
        maxSources: COMPARATIVE_MAP_LIMITS.maxExportSources,
      },
    },
  });
}

/** Monta o mapa (sem máscara) a partir das linhas vigentes, no `tx` de quem chama. */
@Injectable()
export class ComparativeMapAssembler {
  constructor(
    @Inject(PRICE_RESEARCH_REPOSITORY) private readonly researches: PriceResearchRepository,
    @Inject(PRICE_SOURCE_REPOSITORY) private readonly sources: PriceSourceRepository,
    private readonly catalog: ProcessItemCatalogRegistry,
    private readonly catalogs: CatalogFacade,
    private readonly rules: PriceSourceRulesReader,
    private readonly suppliers: SupplierFacade,
  ) {}

  async assemble(
    tx: TenantTx,
    research: PriceResearch,
    document: { readonly code: string | null; readonly title: string },
  ): Promise<ComparativeMapDto> {
    const items = await this.researches.listItems(tx, research.id);
    const sources = await this.sources.listSources(tx, research.id);
    const quotations =
      items.length === 0 || sources.length === 0
        ? []
        : await this.sources.listQuotations(tx, research.id);
    const references =
      items.length === 0 ? [] : await this.catalog.listActive(tx, research.processId);
    const units = await this.catalogs.unitsOf(
      tx,
      references.map((reference) => reference.unitOfMeasureId),
    );
    const itemRefs = new Map<string, ComparativeMapItemRef>(
      references.map((reference) => [
        reference.id,
        {
          sequence: reference.sequence,
          lotNumber: reference.lotNumber ?? null,
          description: reference.description,
          unitLabel: units.get(reference.unitOfMeasureId)?.label ?? '',
        },
      ]),
    );
    const types: ReadonlyMap<string, { readonly code: string; readonly label: string }> =
      sources.length === 0
        ? new Map()
        : await this.rules.of(
            tx,
            sources.map((source) => source.sourceTypeId),
          );
    const suppliers = await this.suppliers.summariesOf(
      tx,
      sources.flatMap((source) => (source.supplierId === null ? [] : [source.supplierId])),
    );
    return buildComparativeMap({
      research,
      code: document.code,
      title: document.title,
      items,
      sources,
      quotations,
      itemRefs,
      sourceTypes: new Map(
        [...types.entries()].map(([id, type]) => [id, { code: type.code, label: type.label }]),
      ),
      supplierNames: new Map(
        [...suppliers.entries()].map(([id, supplier]) => [id, supplier.legalName]),
      ),
    });
  }
}

/** O mapa como o usuário da requisição pode vê-lo, e se a POL-09 o mascarou. */
export interface VisibleComparativeMap {
  readonly map: ComparativeMapDto;
  readonly masked: boolean;
  readonly processId: string;
}

@Injectable()
export class ComparativeMapReader {
  constructor(
    @Inject(PRICE_RESEARCH_REPOSITORY) private readonly researches: PriceResearchRepository,
    private readonly documents: DocumentFacade,
    private readonly assembler: ComparativeMapAssembler,
  ) {}

  /** A pesquisa visível (senão 404 `PRICE_RESEARCH_NOT_FOUND`) e o mapa com a POL-09 aplicada. */
  async visible(tx: TenantTx, researchId: string): Promise<VisibleComparativeMap> {
    const research = await this.researches.findById(tx, researchId);
    if (research === null) throw comparativeMapNotFound();
    const view = await this.documents.typedDocumentIn(tx, research.documentId);
    if (view === null) throw comparativeMapNotFound();
    const masked = view.isBudgetConfidential && !view.canViewConfidentialBudget;
    const map = await this.assembler.assemble(tx, research, view.document);
    return { map: comparativeMapFor(map, masked), masked, processId: research.processId };
  }
}

/** `GetComparativeMapQuery` → PRS-21 (fluxo principal 2–3). Sem auditoria nem eventos. */
@Injectable()
export class GetComparativeMapQuery {
  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) private readonly transactions: PriceResearchTransactions,
    private readonly reader: ComparativeMapReader,
  ) {}

  async execute(researchId: string): Promise<ComparativeMapDto> {
    const { map } = await this.transactions.read((tx) => this.reader.visible(tx, researchId));
    return map;
  }
}

export interface ComparativeMapFile {
  readonly fileName: string;
  readonly data: Buffer;
}

/**
 * `ExportComparativeMapXlsxCommand` → PRS-22 (fluxo principal 4 · FA-01/03 · RN-PRICE-54/56). Lê o
 * mapa na mesma transação de leitura do PRS-21, recusa acima de 500 itens/50 fontes antes de montar
 * o arquivo, monta a planilha em memória (o teto limita o tamanho) e só então grava
 * `price_research.export`: banco fora no meio → 503 sem arquivo (nada é enviado antes do fim). O
 * conteúdo é determinístico — sem data de geração no arquivo: duas exportações sem recálculo entre
 * elas geram bytes idênticos, cada uma com a sua auditoria.
 */
@Injectable()
export class ExportComparativeMapXlsxCommand {
  private readonly logger = new Logger('price_research.export');

  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) private readonly transactions: PriceResearchTransactions,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    private readonly reader: ComparativeMapReader,
  ) {}

  async execute(
    researchId: string,
    format: ComparativeMapExportFormat,
  ): Promise<ComparativeMapFile> {
    const startedAt = performance.now();
    const { correlationId } = requireRequestContext();
    try {
      const { map, masked, processId } = await this.transactions.read((tx) =>
        this.reader.visible(tx, researchId),
      );
      const itemsCount = map.items.length;
      const sourcesCount = map.sources.length;
      if (exceedsComparativeMapExport(itemsCount, sourcesCount)) {
        throw exportTooLarge(itemsCount, sourcesCount);
      }
      if (
        itemsCount > COMPARATIVE_MAP_LIMITS.nearLimitItems ||
        sourcesCount > COMPARATIVE_MAP_LIMITS.nearLimitSources
      ) {
        this.logger.warn(
          {
            event: 'price_research.export_near_limit',
            priceResearchId: map.priceResearchId,
            itemsCount,
            sourcesCount,
            correlationId,
          },
          'price_research.export_near_limit',
        );
      }
      const data = writeXlsx(comparativeMapSheet(map));
      await this.transactions.run((tx) =>
        this.audit.record(tx, {
          action: 'price_research.export',
          entityType: 'PriceResearch',
          entityId: map.priceResearchId,
          processId,
          metadata: { format, itemsCount, sourcesCount, masked, documentCode: map.code },
        }),
      );
      this.logger.log(
        {
          event: 'price_research.map_exported',
          priceResearchId: map.priceResearchId,
          format,
          itemsCount,
          sourcesCount,
          durationMs: Math.round(performance.now() - startedAt),
          correlationId,
        },
        'price_research.map_exported',
      );
      return { fileName: comparativeMapFileName(map.code), data };
    } catch (error) {
      if (isUnexpectedFailure(error)) {
        const errorCode =
          error instanceof DatabaseUnavailableError
            ? 'DEPENDENCY_UNAVAILABLE'
            : failureCodeOf(error);
        this.logger.error(
          { event: 'price_research.export_failed', errorCode, correlationId },
          'price_research.export_failed',
        );
      }
      throw error;
    }
  }
}
