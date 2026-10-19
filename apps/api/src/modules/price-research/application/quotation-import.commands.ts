import {
  importTemplateFileName,
  isXlsxFileName,
  QUOTATION_IMPORT_LIMITS,
  QUOTATION_IMPORT_MESSAGES,
} from '@contrataflow/validation';
import type { QuotationImportPreview, QuotationImportResult } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import {
  failureCodeOf,
  isUnexpectedFailure,
  TransactionalCommandHandler,
} from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import type { UploadedFile } from '#shared/http/multipart.js';
import { ProcessItemCatalogRegistry } from '#shared/process/process-item-catalog.js';
import {
  readXlsx,
  writeXlsx,
  XlsxFormatError,
  XlsxTooLargeError,
} from '#shared/spreadsheet/xlsx.js';
import type { XlsxCellValue } from '#shared/spreadsheet/xlsx.js';

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
import { priceResearchNotFound, priceSourceVersionConflict } from './price-research.errors.js';
import {
  PriceSourceGate,
  PriceSourceRulesReader,
  QuotationRecalculator,
  rulesOf,
} from './price-source.support.js';
import { QuotationImportStore } from './quotation-import.store.js';
import type { ImportPreviewLookup } from './quotation-import.store.js';
import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import { NumberingFacade } from '../../catalog/application/numbering.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import type { PriceResearch } from '../domain/price-research.js';
import { createQuotation, isSourceExpired, withPrice } from '../domain/price-source.js';
import type { PriceSource, Quotation } from '../domain/price-source.js';
import {
  importTemplateMatrix,
  planImportApplication,
  planQuotationImport,
} from '../domain/quotation-import.js';
import type { ImportItemRef, ImportStructureProblem } from '../domain/quotation-import.js';

/*
 * Importação de cotações por planilha (US-028 · PRS-18/19/24). Todas exigem a pesquisa editável
 * (`PriceSourceGate.writable`: `PRICE_RESEARCH_UPDATE` + POL-02 estendida + documento em
 * `DRAFT`/`RETURNED` + POL-09, linha da pesquisa travada). A prévia lê e valida a planilha sem gravar
 * nada e guarda as células válidas no Redis (`QuotationImportStore`, 15 min); a aplicação grava essas
 * células numa transação só, com um único recálculo (`PriceResearchRecalculated`) e a auditoria
 * `price_research.import`. Logs sem preços nem conteúdo do arquivo.
 */

const SETTING_MAX_SIZE = 'uploads.maxFileSizeMb';
const MB = 1024 * 1024;
const FILE_NAME_MAX = 255;
/** Tipos que navegadores e o Excel informam para `.xlsx` (o conteúdo é conferido ao ler o ZIP). */
const XLSX_TYPES = new Set([
  QUOTATION_IMPORT_LIMITS.mimeType,
  'application/octet-stream',
  'application/zip',
  'application/x-zip-compressed',
]);

function logContext() {
  const context = requireRequestContext();
  return { tenantId: context.tenantId, correlationId: context.correlationId };
}

/** 422 da estrutura da planilha (RN-PRICE-36), no campo `file`. */
function structureError(problem: ImportStructureProblem | 'TOO_MANY_ROWS'): ApiError {
  const messages = {
    NO_ITEM_COLUMN: ['REQUIRED', QUOTATION_IMPORT_MESSAGES.noItemColumn],
    NO_SOURCE_COLUMN: ['REFERENCE_NOT_FOUND', QUOTATION_IMPORT_MESSAGES.noSourceColumn],
    TOO_MANY_SOURCES: ['OUT_OF_RANGE', QUOTATION_IMPORT_MESSAGES.tooManySources],
    TOO_MANY_ROWS: ['OUT_OF_RANGE', QUOTATION_IMPORT_MESSAGES.tooManyRows],
  } as const;
  const [code, message] = messages[problem];
  return validationError([{ field: 'file', code, message }]);
}

function fileTypeNotAllowed(): ApiError {
  return new ApiError('FILE_TYPE_NOT_ALLOWED', { detail: QUOTATION_IMPORT_MESSAGES.fileType });
}

function fileTooLarge(maxFileSizeMb: number): ApiError {
  return new ApiError('FILE_TOO_LARGE', {
    detail: QUOTATION_IMPORT_MESSAGES.fileTooLarge,
    extensions: { maxFileSizeMb },
  });
}

/** Itens da pesquisa com a `sequence`, a descrição e a unidade do item do processo. */
@Injectable()
export class ImportItemsReader {
  constructor(
    @Inject(PRICE_RESEARCH_REPOSITORY) private readonly researches: PriceResearchRepository,
    private readonly catalog: ProcessItemCatalogRegistry,
    private readonly catalogs: CatalogFacade,
  ) {}

  async of(tx: TenantTx, research: PriceResearch): Promise<ImportItemRef[]> {
    const items = await this.researches.listItems(tx, research.id);
    if (items.length === 0) return [];
    const references = new Map(
      (await this.catalog.listActive(tx, research.processId)).map((item) => [item.id, item]),
    );
    const units = await this.catalogs.unitsOf(
      tx,
      [...references.values()].map((item) => item.unitOfMeasureId),
    );
    return items.map((item) => {
      const reference = references.get(item.processItemId);
      return {
        priceItemId: item.id,
        sequence: reference?.sequence ?? item.sortOrder,
        description: reference?.description ?? '',
        unitLabel:
          reference === undefined ? '' : (units.get(reference.unitOfMeasureId)?.label ?? ''),
      };
    });
  }
}

// --- PRS-24 -------------------------------------------------------------------------------------

export interface ImportTemplateFile {
  readonly fileName: string;
  readonly data: Buffer;
}

/** `GetImportTemplateQuery` — PRS-24 (fluxo principal 2 · RN-PRICE-35). */
@Injectable()
export class GetImportTemplateQuery {
  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) private readonly transactions: PriceResearchTransactions,
    @Inject(PRICE_SOURCE_REPOSITORY) private readonly sources: PriceSourceRepository,
    private readonly gate: PriceSourceGate,
    private readonly items: ImportItemsReader,
  ) {}

  async execute(researchId: string): Promise<ImportTemplateFile> {
    const { research, code, items, sources, quotations } = await this.transactions.run(
      async (tx) => {
        const { research: found, view } = await this.gate.writable(
          tx,
          researchId,
          priceResearchNotFound,
        );
        return {
          research: found,
          code: view.document.code,
          items: await this.items.of(tx, found),
          sources: await this.sources.listSources(tx, found.id),
          quotations: await this.sources.listQuotations(tx, found.id),
        };
      },
    );
    if (
      items.length > QUOTATION_IMPORT_LIMITS.maxRows ||
      sources.length > QUOTATION_IMPORT_LIMITS.maxSources
    ) {
      throw new ApiError('EXPORT_TOO_LARGE', {
        status: 422,
        title: 'Exportação muito grande',
        detail: QUOTATION_IMPORT_MESSAGES.templateTooLarge,
        extensions: { meta: { itemsCount: items.length, sourcesCount: sources.length } },
      });
    }
    const decimals = research.parameters.unitPriceDecimals;
    const matrix = importTemplateMatrix({
      items,
      sources,
      quotations,
      unitPriceDecimals: decimals,
    });
    const priceStyle = decimals === 4 ? 'decimal4' : 'decimal2';
    const rows: XlsxCellValue[][] = [
      matrix.headers.map((header) => ({ kind: 'text', value: header, style: 'header' })),
      ...matrix.rows.map((row): XlsxCellValue[] => [
        { kind: 'number', value: String(row.sequence) },
        { kind: 'text', value: row.description },
        { kind: 'text', value: row.unitLabel },
        ...row.prices.map((price): XlsxCellValue =>
          price === null ? null : { kind: 'number', value: price, style: priceStyle },
        ),
      ]),
    ];
    return {
      fileName: importTemplateFileName(code),
      data: writeXlsx({
        name: 'Cotações',
        rows,
        columnWidths: [8, 60, 12, ...sources.map(() => 22)],
        freezeHeader: true,
      }),
    };
  }
}

// --- PRS-18 -------------------------------------------------------------------------------------

/** O corpo multipart, lido só depois da autorização (com o limite do tenant). */
export interface ImportUpload {
  read(maxFileBytes: number, tooLarge: () => ApiError): Promise<UploadedFile>;
  /** Descarta o corpo quando a requisição é recusada antes da leitura. */
  discard(): Promise<void>;
}

export interface PreviewQuotationImportInput {
  readonly researchId: string;
  readonly upload: ImportUpload;
}

/**
 * `PreviewQuotationImportCommand` — PRS-18 (fluxo principal 4–5 · FA-01/02/04 · RN-PRICE-36/37).
 * Somente leitura: a transação só confere a guarda e tira o retrato de itens, fontes e cotações;
 * o arquivo é lido fora dela (sem segurar a trava da pesquisa durante o envio).
 */
@Injectable()
export class PreviewQuotationImportCommand {
  private readonly logger = new Logger('price_research.import');

  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) private readonly transactions: PriceResearchTransactions,
    @Inject(PRICE_SOURCE_REPOSITORY) private readonly sources: PriceSourceRepository,
    private readonly gate: PriceSourceGate,
    private readonly items: ImportItemsReader,
    private readonly tenancy: TenancyFacade,
    private readonly store: QuotationImportStore,
  ) {}

  async execute({
    researchId,
    upload,
  }: PreviewQuotationImportInput): Promise<QuotationImportPreview> {
    try {
      return await this.run(researchId, upload);
    } catch (error) {
      if (isUnexpectedFailure(error)) {
        this.logger.error(
          {
            event: 'price_research.import_failed',
            step: 'preview',
            errorCode: failureCodeOf(error),
            ...logContext(),
          },
          'price_research.import_failed',
        );
      }
      throw error;
    }
  }

  private async run(researchId: string, upload: ImportUpload): Promise<QuotationImportPreview> {
    let snapshot;
    try {
      snapshot = await this.transactions.run(async (tx) => {
        const { research } = await this.gate.writable(tx, researchId, priceResearchNotFound);
        const values = await this.tenancy.settingValues(tx, [SETTING_MAX_SIZE]);
        const maxFileSizeMb = values.get(SETTING_MAX_SIZE);
        return {
          research,
          maxFileSizeMb: typeof maxFileSizeMb === 'number' ? maxFileSizeMb : 0,
          items: await this.items.of(tx, research),
          sources: await this.sources.listSources(tx, research.id),
          quotations: await this.sources.listQuotations(tx, research.id),
        };
      });
    } catch (error) {
      await upload.discard();
      throw error;
    }
    const { research, maxFileSizeMb } = snapshot;

    // FA-01 · RN-PRICE-36: tamanho, extensão/tipo e conteúdo antes de qualquer linha.
    const file = await upload.read(maxFileSizeMb * MB, () => fileTooLarge(maxFileSizeMb));
    const declaredType = file.contentType?.split(';')[0]?.trim().toLowerCase() ?? null;
    if (
      !isXlsxFileName(file.fileName) ||
      (declaredType !== null && !XLSX_TYPES.has(declaredType))
    ) {
      throw fileTypeNotAllowed();
    }
    // Nome do arquivo vai para a auditoria e a resposta: só o nome, limitado.
    const fileName = file.fileName.slice(0, FILE_NAME_MAX);
    let sheetRows;
    try {
      sheetRows = readXlsx(file.data, {
        // O cabeçalho + 500 linhas de item.
        maxRows: QUOTATION_IMPORT_LIMITS.maxRows + 1,
        maxColumns: 16_384,
      });
    } catch (error) {
      if (error instanceof XlsxFormatError) throw fileTypeNotAllowed();
      if (error instanceof XlsxTooLargeError) throw structureError('TOO_MANY_ROWS');
      throw error;
    }

    const plan = planQuotationImport({
      rows: sheetRows,
      items: snapshot.items,
      sources: snapshot.sources,
      quotations: snapshot.quotations,
      unitPriceDecimals: research.parameters.unitPriceDecimals,
    });
    if (plan.kind === 'invalid') throw structureError(plan.problem);

    const token = newId();
    const expiresAt = await this.store.save(token, {
      researchId: research.id,
      userId: requireRequestContext().actor.userId,
      fileName,
      skipped: plan.summary.errors + plan.summary.warnings,
      cells: plan.cells,
    });
    this.logger.log(
      {
        event: 'price_research.import_previewed',
        priceResearchId: research.id,
        rows: plan.summary.rows,
        validCells: plan.summary.valid,
        errors: plan.summary.errors,
        warnings: plan.summary.warnings + plan.columnIssues.length,
        ...logContext(),
      },
      'price_research.import_previewed',
    );
    return {
      previewToken: token,
      expiresAt: expiresAt.toISOString(),
      fileName,
      columns: [...plan.columns],
      rows: [...plan.rows],
      columnIssues: [...plan.columnIssues],
      summary: plan.summary,
    };
  }
}

// --- PRS-19 -------------------------------------------------------------------------------------

export interface ApplyQuotationImportInput {
  readonly researchId: string;
  readonly previewToken: string;
}

interface ApplyPrepared {
  readonly now: Date;
  readonly lookup: ImportPreviewLookup;
}

export interface AppliedQuotationImport extends QuotationImportResult {
  readonly priceResearchId: string;
  readonly previewToken: string;
}

/**
 * `ApplyQuotationImportCommand` — PRS-19 (fluxo principal 6–8 · FA-03/05 · RN-PRICE-38..40): numa
 * transação só, a guarda (404/403/409), o token (outra pesquisa, outro usuário ou outro tenant =
 * 404; vencido = 410), as células válidas da prévia sobre as cotações vigentes, a versão nova das
 * fontes tocadas, a auditoria `price_research.import` e um único recálculo. Falha = nada gravado.
 */
@Injectable()
export class ApplyQuotationImportCommand extends TransactionalCommandHandler<
  ApplyQuotationImportInput,
  ApplyPrepared,
  AppliedQuotationImport
> {
  constructor(
    @Inject(PRICE_RESEARCH_TRANSACTIONS) transactions: PriceResearchTransactions,
    @Inject(PRICE_RESEARCH_CLOCK) private readonly clock: PriceResearchClock,
    @Inject(PRICE_RESEARCH_REPOSITORY) private readonly researches: PriceResearchRepository,
    @Inject(PRICE_SOURCE_REPOSITORY) private readonly sources: PriceSourceRepository,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    private readonly gate: PriceSourceGate,
    private readonly rules: PriceSourceRulesReader,
    private readonly numbering: NumberingFacade,
    private readonly recalculator: QuotationRecalculator,
    private readonly store: QuotationImportStore,
  ) {
    // `<nome>_failed` = `price_research.import_failed` ("Logs").
    super('price_research.import', transactions);
  }

  protected async prepare({ previewToken }: ApplyQuotationImportInput): Promise<ApplyPrepared> {
    return { now: this.clock(), lookup: await this.store.find(previewToken) };
  }

  protected async handle(
    tx: TenantTx,
    { researchId, previewToken }: ApplyQuotationImportInput,
    { now, lookup }: ApplyPrepared,
  ): Promise<AppliedQuotationImport> {
    const { research, view } = await this.gate.writable(tx, researchId, priceResearchNotFound);
    const userId = requireRequestContext().actor.userId;
    // Token de outra pesquisa, de outra pessoa ou de outro tenant (chave do contexto): 404.
    const issued =
      lookup.state === 'ACTIVE' ? lookup.preview : lookup.state === 'EXPIRED' ? lookup : null;
    if (issued?.researchId !== research.id || issued.userId !== userId) {
      throw new ApiError('NOT_FOUND', { detail: QUOTATION_IMPORT_MESSAGES.notFound });
    }
    if (lookup.state !== 'ACTIVE') {
      this.logger.warn(
        {
          event: 'price_research.import_token_expired',
          priceResearchId: research.id,
          ...logContext(),
        },
        'price_research.import_token_expired',
      );
      throw new ApiError('IMPORT_PREVIEW_EXPIRED', { detail: QUOTATION_IMPORT_MESSAGES.expired });
    }
    const { preview } = lookup;

    const items = await this.researches.listItems(tx, research.id);
    const sources = await this.sources.listSources(tx, research.id);
    const quotations = await this.sources.listQuotations(tx, research.id);
    const plan = planImportApplication({
      cells: preview.cells,
      itemIds: new Set(items.map((item) => item.id)),
      sourceIds: new Set(sources.map((source) => source.id)),
      quotations,
    });
    const stamp = { now, userId };
    const sourcesById = new Map(sources.map((source) => [source.id, source]));
    const expiry = await this.expiryOf(tx, research, sources);
    const touched = new Set<string>();

    const created: Quotation[] = plan.creates.map((cell) => {
      touched.add(cell.priceSourceId);
      return createQuotation({
        id: newId(),
        tenantId: research.tenantId,
        priceResearchId: research.id,
        priceItemId: cell.priceItemId,
        priceSourceId: cell.priceSourceId,
        unitPrice: cell.unitPrice,
        brandModel: null,
        isExpired: expiry.get(cell.priceSourceId) ?? false,
        ...stamp,
      });
    });
    await this.sources.insertQuotations(tx, created);
    for (const { cell, existing } of plan.updates) {
      touched.add(cell.priceSourceId);
      const next = withPrice(
        existing,
        {
          unitPrice: cell.unitPrice,
          brandModel: existing.brandModel,
          isExpired: expiry.get(cell.priceSourceId) ?? existing.isExpired,
        },
        stamp,
      );
      // A pesquisa está travada: a versão lida é a vigente.
      await this.sources.updateQuotation(tx, next, existing.version);
    }
    // A grade aberta (PRS-13, `If-Match` da fonte) passa a ver a versão nova da fonte.
    for (const sourceId of touched) {
      const source = sourcesById.get(sourceId);
      if (source !== undefined) await this.touch(tx, source, stamp);
    }

    const appliedCount = created.length + plan.updates.length;
    const skippedCount = preview.skipped + plan.unchanged;
    await this.audit.record(tx, {
      action: 'price_research.import',
      entityType: 'PriceResearch',
      entityId: research.id,
      processId: research.processId,
      metadata: {
        priceResearchId: research.id,
        documentCode: view.document.code,
        appliedCount,
        skippedCount,
        createdCount: created.length,
        updatedCount: plan.updates.length,
        fileName: preview.fileName,
      },
    });
    // RN-PRICE-40: um único recálculo ao final (`PriceResearchRecalculated`), mesmo sem mudanças.
    await this.recalculator.recalculate(tx, research, stamp, 'IMPORT');
    return { appliedCount, skippedCount, priceResearchId: research.id, previewToken };
  }

  /** RN-PRICE-26: validade das cotações novas/alteradas pela regra do tipo de cada fonte. */
  private async expiryOf(
    tx: TenantTx,
    research: PriceResearch,
    sources: readonly PriceSource[],
  ): Promise<ReadonlyMap<string, boolean>> {
    if (sources.length === 0) return new Map();
    const { timezone } = await this.numbering.settingsOf(tx);
    const types = await this.rules.of(
      tx,
      sources.map((source) => source.sourceTypeId),
    );
    return new Map(
      sources.map((source) => {
        const type = types.get(source.sourceTypeId);
        return [
          source.id,
          type === undefined ? false : isSourceExpired(source, rulesOf(type), research, timezone),
        ];
      }),
    );
  }

  private async touch(
    tx: TenantTx,
    source: PriceSource,
    stamp: { readonly now: Date; readonly userId: string | null },
  ): Promise<void> {
    try {
      await this.sources.updateSource(
        tx,
        { ...source, updatedAt: stamp.now, updatedById: stamp.userId },
        source.version,
      );
    } catch (error) {
      if (error instanceof VersionConflictError) {
        const latest = await this.sources.findSource(tx, source.id);
        throw priceSourceVersionConflict(latest?.version ?? source.version + 1);
      }
      throw error;
    }
  }

  protected override committed(result: AppliedQuotationImport, durationMs: number): void {
    this.logger.log(
      {
        event: 'price_research.import_applied',
        priceResearchId: result.priceResearchId,
        appliedCount: result.appliedCount,
        skippedCount: result.skippedCount,
        durationMs,
        ...logContext(),
      },
      'price_research.import_applied',
    );
    // O token não serve de novo; falha aqui não desfaz a importação já gravada.
    this.store.consume(result.previewToken).catch(() => undefined);
  }
}
