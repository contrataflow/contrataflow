import {
  PRICE_SOURCE_LIMITS,
  PRICE_SOURCE_MESSAGES,
  PRICE_SOURCE_REQUIRED_FIELDS,
  isHttpsUrl,
  missingPriceSourceFields,
  unitPriceIssue,
} from '@contrataflow/validation';
import type {
  CatalogItemDto,
  CreatePriceSource,
  PriceItemDto,
  PriceSourceDto,
  PriceSourceRequiredField,
  QuotationDto,
  QuotationLine,
  UpdatePriceSource,
} from '@contrataflow/validation';

/*
 * Regras de tela da aba "Fontes" (US-026 · SCR-009), puras e testáveis: o tipo de fonte com os campos
 * exigidos (catálogo `PRICE_SOURCE_TYPE` — RN-PRICE-21), o formulário (V-01/V-04/V-05 antes de enviar;
 * a API confere de novo) e a grade de preços (V-06; linhas vazias e cotações `EXCLUDED` não vão).
 * Mensagens de `PRICE_SOURCE_MESSAGES` (as mesmas da API).
 */

export interface SourceTypeOption {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly requiredFields: readonly PriceSourceRequiredField[];
  readonly maxAgeDays: number | null;
}

const KNOWN_FIELDS = new Set<unknown>(PRICE_SOURCE_REQUIRED_FIELDS);

/** Tipos ativos do catálogo com `metadata.requiredFields`/`maxAgeDays` (validados pela API). */
export function sourceTypeOptions(
  items: readonly CatalogItemDto[] | undefined,
): SourceTypeOption[] {
  return (items ?? []).map((item) => {
    const fields = Array.isArray(item.metadata.requiredFields) ? item.metadata.requiredFields : [];
    const maxAgeDays = item.metadata.maxAgeDays;
    return {
      id: item.id,
      code: item.code,
      label: item.label,
      requiredFields: fields.filter((field): field is PriceSourceRequiredField =>
        KNOWN_FIELDS.has(field),
      ),
      maxAgeDays: typeof maxAgeDays === 'number' ? maxAgeDays : null,
    };
  });
}

/** O tipo da fonte gravada como opção (mesmo inativo — continua exibido). */
export function optionOfSource(source: PriceSourceDto): SourceTypeOption {
  return {
    id: source.sourceType.id,
    code: source.sourceType.code,
    label: source.sourceType.label,
    requiredFields: source.sourceType.requiredFields,
    maxAgeDays: source.sourceType.maxAgeDays,
  };
}

export interface SourceFormValues {
  readonly sourceTypeId: string;
  readonly description: string;
  readonly supplierId: string;
  /** Rótulo exibido do fornecedor escolhido (não vai à API). */
  readonly supplierLabel: string;
  /** `AAAA-MM-DD`. */
  readonly quoteDate: string;
  /** `AAAA-MM-DDTHH:mm` no horário local do navegador (`<input type="datetime-local">`). */
  readonly accessedAt: string;
  readonly url: string;
  readonly referenceOrganization: string;
  readonly referenceDocument: string;
  readonly supplierChoiceJustification: string;
  readonly notes: string;
}

export const EMPTY_SOURCE_FORM: SourceFormValues = {
  sourceTypeId: '',
  description: '',
  supplierId: '',
  supplierLabel: '',
  quoteDate: '',
  accessedAt: '',
  url: '',
  referenceOrganization: '',
  referenceDocument: '',
  supplierChoiceJustification: '',
  notes: '',
};

const pad = (value: number) => String(value).padStart(2, '0');

/** ISO (UTC) → `AAAA-MM-DDTHH:mm` no horário local do navegador. */
export function isoToLocalDateTime(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** `AAAA-MM-DDTHH:mm` local → ISO 8601 em UTC sem milissegundos (`2026-09-12T17:32:00Z`). */
export function localDateTimeToIso(value: string): string | null {
  if (value.trim() === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 19)}Z`;
}

export function formFromSource(source: PriceSourceDto): SourceFormValues {
  return {
    sourceTypeId: source.sourceTypeId,
    description: source.description,
    supplierId: source.supplierId ?? '',
    supplierLabel: source.supplier?.legalName ?? '',
    quoteDate: source.quoteDate ?? '',
    accessedAt: isoToLocalDateTime(source.accessedAt),
    url: source.url ?? '',
    referenceOrganization: source.referenceOrganization ?? '',
    referenceDocument: source.referenceDocument ?? '',
    supplierChoiceJustification: source.supplierChoiceJustification ?? '',
    notes: source.notes ?? '',
  };
}

export type SourceFormErrors = Partial<Record<keyof SourceFormValues, string | undefined>>;

const textLimits: Partial<Record<keyof SourceFormValues, number>> = {
  description: PRICE_SOURCE_LIMITS.descriptionMax,
  url: PRICE_SOURCE_LIMITS.urlMax,
  referenceOrganization: PRICE_SOURCE_LIMITS.referenceOrganizationMax,
  referenceDocument: PRICE_SOURCE_LIMITS.referenceDocumentMax,
  supplierChoiceJustification: PRICE_SOURCE_LIMITS.longTextMax,
  notes: PRICE_SOURCE_LIMITS.longTextMax,
};

/**
 * V-01/V-04/V-05 no formulário (FA-06): tipo e descrição; campos exigidos pelo tipo ("Selecione o
 * fornecedor" para o fornecedor); URL `https://`; datas não futuras; tamanhos.
 */
export function validateSourceForm(
  values: SourceFormValues,
  type: SourceTypeOption | undefined,
  clock: { readonly now: Date; readonly today: string },
): SourceFormErrors {
  const errors: Record<string, string> = {};
  if (type === undefined) errors.sourceTypeId = PRICE_SOURCE_MESSAGES.sourceTypeRequired;
  if (values.description.trim() === '')
    errors.description = PRICE_SOURCE_MESSAGES.descriptionRequired;
  for (const [field, max] of Object.entries(textLimits)) {
    const value = values[field as keyof SourceFormValues];
    if (value.trim().length > max && errors[field] === undefined) {
      errors[field] = PRICE_SOURCE_MESSAGES.textLength(max);
    }
  }
  if (type !== undefined) {
    for (const field of missingPriceSourceFields(values, type.requiredFields)) {
      errors[field] =
        field === 'supplierId'
          ? PRICE_SOURCE_MESSAGES.supplierRequired
          : PRICE_SOURCE_MESSAGES.fieldRequired;
    }
  }
  if (values.url.trim() !== '' && !isHttpsUrl(values.url)) {
    errors.url = PRICE_SOURCE_MESSAGES.urlHttps;
  }
  if (values.quoteDate !== '' && values.quoteDate > clock.today) {
    errors.quoteDate = PRICE_SOURCE_MESSAGES.dateFuture;
  }
  const accessedAt = localDateTimeToIso(values.accessedAt);
  if (accessedAt !== null && new Date(accessedAt).getTime() > clock.now.getTime()) {
    errors.accessedAt = PRICE_SOURCE_MESSAGES.dateFuture;
  }
  return errors;
}

const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

/** Corpo do PRS-10. */
export function createSourceBody(values: SourceFormValues): CreatePriceSource {
  return {
    sourceTypeId: values.sourceTypeId,
    description: values.description.trim(),
    supplierId: orNull(values.supplierId),
    quoteDate: orNull(values.quoteDate),
    accessedAt: localDateTimeToIso(values.accessedAt),
    url: orNull(values.url),
    referenceOrganization: orNull(values.referenceOrganization),
    referenceDocument: orNull(values.referenceDocument),
    supplierChoiceJustification: orNull(values.supplierChoiceJustification),
    notes: orNull(values.notes),
  };
}

/** Corpo do PRS-11: só os campos alterados (`null` apaga). `null` = nada mudou. */
export function updateSourceBody(
  values: SourceFormValues,
  source: PriceSourceDto,
): UpdatePriceSource | null {
  const next = createSourceBody(values);
  const current = createSourceBody(formFromSource(source));
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(next) as (keyof CreatePriceSource)[]) {
    if (next[key] !== current[key]) patch[key] = next[key];
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

/** "150,5" / "1.234,56" / "150.5" → `"150.5"` / `"1234.56"` (DEC-003: ponto como separador). */
export function toApiDecimal(value: string): string {
  const trimmed = value.trim().replace(/\s/g, '');
  if (!trimmed.includes(',')) return trimmed;
  return trimmed.replace(/\./g, '').replace(',', '.');
}

/** `"150.0000"` → `"150,00"` no campo da grade, com as casas do snapshot. */
export function toInputDecimal(value: string | null, decimals: 2 | 4): string {
  if (value === null) return '';
  const [integer = '0', fraction = ''] = value.split('.');
  return `${integer},${fraction.padEnd(decimals, '0').slice(0, decimals)}`;
}

/** Mesma escala da coluna (`numeric(18,4)`) para comparar com o valor gravado. */
function sameDecimal(a: string, b: string): boolean {
  const scale = (value: string) => {
    const [integer = '0', fraction = ''] = value.split('.');
    return `${integer.replace(/^0+(?=\d)/, '')}.${fraction.padEnd(4, '0')}`;
  };
  return scale(a) === scale(b);
}

export interface GridRow {
  readonly item: PriceItemDto;
  readonly quotation: QuotationDto | null;
  /** FA-05: cotação desconsiderada — somente leitura até ser restaurada (US-027). */
  readonly excluded: boolean;
}

/** Uma linha por item da pesquisa (na ordem dos itens), com a cotação da fonte. */
export function gridRows(
  items: readonly PriceItemDto[],
  source: Pick<PriceSourceDto, 'quotations'>,
): GridRow[] {
  const byItem = new Map(source.quotations.map((quotation) => [quotation.priceItemId, quotation]));
  return items.map((item) => {
    const quotation = byItem.get(item.id) ?? null;
    return { item, quotation, excluded: quotation?.status === 'EXCLUDED' };
  });
}

export interface GridCell {
  readonly unitPrice: string;
  readonly brandModel: string;
}

/** Valores iniciais das células (o gravado, no formato da tela). */
export function initialGridCells(
  rows: readonly GridRow[],
  decimals: 2 | 4,
): Record<string, GridCell> {
  return Object.fromEntries(
    rows.map((row) => [
      row.item.id,
      {
        unitPrice: toInputDecimal(row.quotation?.unitPrice ?? null, decimals),
        brandModel: row.quotation?.brandModel ?? '',
      },
    ]),
  );
}

/**
 * Linhas do PRS-13 a partir das células (RN-PRICE-24): só as que mudaram; célula vazia sem cotação
 * não vai; cotação `EXCLUDED` nunca vai; preço inválido (V-06) vira erro da célula e nada é enviado.
 * Apagar o preço de uma cotação gravada não a remove pela grade (a remoção é o PRS-15).
 */
export function gridLines(
  rows: readonly GridRow[],
  cells: Readonly<Record<string, GridCell>>,
  decimals: 2 | 4,
): { readonly lines: QuotationLine[]; readonly errors: Record<string, string> } {
  const lines: QuotationLine[] = [];
  const errors: Record<string, string> = {};
  for (const row of rows) {
    if (row.excluded) continue;
    const cell = cells[row.item.id] ?? { unitPrice: '', brandModel: '' };
    const unitPrice = toApiDecimal(cell.unitPrice);
    const brandModel = cell.brandModel.trim();
    if (unitPrice === '' && brandModel === '') continue;
    const issue = unitPriceIssue(unitPrice, decimals);
    if (issue !== null) {
      errors[row.item.id] = issue.message;
      continue;
    }
    const saved = row.quotation;
    if (
      saved !== null &&
      saved.unitPrice !== null &&
      sameDecimal(saved.unitPrice, unitPrice) &&
      (saved.brandModel ?? '') === brandModel
    ) {
      continue;
    }
    lines.push({
      priceItemId: row.item.id,
      unitPrice,
      brandModel: brandModel === '' ? null : brandModel,
    });
  }
  return { lines, errors };
}
