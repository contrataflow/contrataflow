import { z } from 'zod';

import { uuidV7Schema } from '../common/identifiers.js';

/*
 * Importação de cotações por planilha (US-028 · api/07 PRS-18/19/24 · RN-PRICE-35..40). O modelo
 * (PRS-24) é a matriz itens (linhas, pela `sequence` do item do processo) × fontes já cadastradas
 * (colunas, pelo cabeçalho = descrição da fonte); a prévia (PRS-18) lê a planilha sem gravar e
 * devolve o token de 15 minutos; a aplicação (PRS-19) grava só as células válidas da prévia. Os
 * mesmos limites, mensagens e schemas servem à API e ao diálogo "Importar planilha" da SCR-009.
 */

export const QUOTATION_IMPORT_LIMITS = Object.freeze({
  /** Linhas de item por planilha (o mesmo teto do `EXPORT_TOO_LARGE` do mapa comparativo — US-031). */
  maxRows: 500,
  /** Colunas de fonte por planilha (idem). */
  maxSources: 50,
  /** Validade do token da prévia (RN-PRICE-37/38). */
  previewTtlSeconds: 15 * 60,
  /** Extensão e tipo aceitos (RN-PRICE-36 · V-01). */
  extension: '.xlsx',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});

/** Cabeçalhos das colunas fixas do modelo (PRS-24); a do item identifica a linha (FA-02). */
export const QUOTATION_IMPORT_HEADERS = Object.freeze({
  item: 'Item',
  description: 'Descrição do item',
  unit: 'Unidade',
});

/** Mensagens (V-01..V-07, FA-02/04, RN-PRICE-39) compartilhadas pela API e pela SCR-009. */
export const QUOTATION_IMPORT_MESSAGES = Object.freeze({
  fileType: 'Envie um arquivo .xlsx.',
  fileTooLarge: 'O arquivo excede o tamanho máximo permitido.',
  fileRequired: 'Selecione a planilha.',
  noItemColumn: `A planilha não tem a coluna "${QUOTATION_IMPORT_HEADERS.item}". Baixe o modelo e preencha os preços nele.`,
  noSourceColumn:
    'Nenhuma coluna da planilha corresponde a uma fonte desta pesquisa. Baixe o modelo e preencha os preços nele.',
  tooManyRows: `A planilha pode ter no máximo ${String(QUOTATION_IMPORT_LIMITS.maxRows)} itens.`,
  tooManySources: `A planilha pode ter no máximo ${String(QUOTATION_IMPORT_LIMITS.maxSources)} fontes.`,
  itemNotFound: (row: number) => `Linha ${String(row)}: item não encontrado nesta pesquisa.`,
  itemDuplicated: (row: number) => `Linha ${String(row)}: item repetido na planilha.`,
  sourceNotFound: (header: string) =>
    `Coluna '${header}': fonte não encontrada nesta pesquisa. A coluna foi ignorada.`,
  priceInvalid: (row: number, source: string) =>
    `Linha ${String(row)}, fonte '${source}': preço inválido.`,
  quotationExcluded: (row: number, source: string) =>
    `Linha ${String(row)}, fonte '${source}': cotação desconsiderada — restaure-a antes de importar. A célula foi ignorada.`,
  expired: 'A prévia expirou. Envie a planilha novamente.',
  notFound: 'Prévia de importação não encontrada. Envie a planilha novamente.',
  noValidCells: 'Nenhuma célula válida para importar. Corrija a planilha e envie-a novamente.',
  templateTooLarge: `O modelo comporta até ${String(QUOTATION_IMPORT_LIMITS.maxRows)} itens e ${String(QUOTATION_IMPORT_LIMITS.maxSources)} fontes.`,
});

/** Situação de uma célula/linha na prévia (RN-PRICE-37). */
export const QUOTATION_IMPORT_ISSUE_SEVERITIES = ['ERROR', 'WARNING'] as const;
export type QuotationImportIssueSeverity = (typeof QUOTATION_IMPORT_ISSUE_SEVERITIES)[number];

/** Códigos dos problemas da prévia: os de `errors[].code` (api.md §2.1.1) e os avisos. */
export const QUOTATION_IMPORT_ISSUE_CODES = [
  'REFERENCE_NOT_FOUND',
  'INVALID_DECIMAL',
  'DUPLICATE_IN_LIST',
  'QUOTATION_EXCLUDED',
] as const;
export type QuotationImportIssueCode = (typeof QUOTATION_IMPORT_ISSUE_CODES)[number];

/** Problema de uma linha (`column: null`), de uma célula ou de uma coluna (`row: null`). */
export const quotationImportIssueSchema = z
  .object({
    severity: z.enum(QUOTATION_IMPORT_ISSUE_SEVERITIES),
    code: z.enum(QUOTATION_IMPORT_ISSUE_CODES),
    /** Linha da planilha (1 = cabeçalho); `null` = problema da coluna inteira. */
    row: z.int().nullable(),
    /** Letra da coluna (`C`); `null` = problema da linha inteira. */
    column: z.string().nullable(),
    /** Cabeçalho da coluna da fonte, quando houver. */
    header: z.string().nullable(),
    priceSourceId: z.uuid().nullable(),
    message: z.string(),
  })
  .meta({ id: 'QuotationImportIssue' });
export type QuotationImportIssue = z.infer<typeof quotationImportIssueSchema>;

/** Linha de item da prévia: contagens e problemas (sem preços — POL-09 e "Logs"). */
export const quotationImportRowSchema = z
  .object({
    row: z.int(),
    sequence: z.int().nullable(),
    priceItemId: z.uuid().nullable(),
    valid: z.int(),
    errors: z.int(),
    empty: z.int(),
    warnings: z.int(),
    issues: z.array(quotationImportIssueSchema),
  })
  .meta({ id: 'QuotationImportRow' });
export type QuotationImportRow = z.infer<typeof quotationImportRowSchema>;

export const quotationImportColumnSchema = z
  .object({
    column: z.string(),
    header: z.string(),
    /** Fonte reconhecida pelo cabeçalho; `null` = coluna desconhecida (aviso, FA-02). */
    priceSourceId: z.uuid().nullable(),
  })
  .meta({ id: 'QuotationImportColumn' });
export type QuotationImportColumn = z.infer<typeof quotationImportColumnSchema>;

export const quotationImportSummarySchema = z
  .object({
    /** Células consideradas: linhas de item × colunas de fonte reconhecidas. */
    total: z.int(),
    valid: z.int(),
    errors: z.int(),
    empty: z.int(),
    /** Células ignoradas com aviso (cotação desconsiderada — RN-PRICE-39). */
    warnings: z.int(),
    rows: z.int(),
  })
  .meta({ id: 'QuotationImportSummary' });
export type QuotationImportSummary = z.infer<typeof quotationImportSummarySchema>;

/** PRS-18 — resposta da prévia (`200 { data }`). */
export const quotationImportPreviewSchema = z
  .object({
    previewToken: z.uuid(),
    expiresAt: z.iso.datetime(),
    fileName: z.string(),
    columns: z.array(quotationImportColumnSchema),
    rows: z.array(quotationImportRowSchema),
    /** Problemas das colunas (fonte não encontrada pelo cabeçalho — aviso, FA-02 · V-04). */
    columnIssues: z.array(quotationImportIssueSchema),
    summary: quotationImportSummarySchema,
  })
  .meta({ id: 'QuotationImportPreview' });
export type QuotationImportPreview = z.infer<typeof quotationImportPreviewSchema>;

/** PRS-19 — `POST /price-research/{id}/import` (`Idempotency-Key` obrigatório). */
export const applyQuotationImportSchema = z
  .strictObject({ previewToken: uuidV7Schema })
  .meta({ id: 'QuotationImportApplyRequest' });
export type ApplyQuotationImport = z.infer<typeof applyQuotationImportSchema>;

/** PRS-19 — resumo da aplicação (`200 { data }`). */
export const quotationImportResultSchema = z
  .object({
    /** Cotações criadas ou com preço alterado. */
    appliedCount: z.int(),
    /** Células preenchidas não aplicadas: com erro, com aviso, iguais à gravada ou sem referência. */
    skippedCount: z.int(),
  })
  .meta({ id: 'QuotationImportResult' });
export type QuotationImportResult = z.infer<typeof quotationImportResultSchema>;

/** PRS-18 — corpo `multipart/form-data` (documentação do OpenAPI). */
export const quotationImportUploadSchema = z
  .object({
    file: z.string().describe('Planilha .xlsx (binário) gerada a partir do modelo PRS-24.'),
  })
  .meta({ id: 'QuotationImportUpload' });

/** V-01 no cliente: extensão `.xlsx` (o tipo informado pelo navegador nem sempre vem). */
export function isXlsxFileName(name: string): boolean {
  return name.trim().toLowerCase().endsWith(QUOTATION_IMPORT_LIMITS.extension);
}

/** Nome do arquivo do modelo (PRS-24): `cotacoes-<código da pesquisa>.xlsx`. */
export function importTemplateFileName(code: string | null): string {
  const slug = (code ?? 'pesquisa')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `cotacoes-${slug === '' ? 'pesquisa' : slug}.xlsx`;
}
