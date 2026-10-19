import { localDateOf } from '@contrataflow/types';
import {
  missingPriceSourceFields,
  PRICE_SOURCE_MESSAGES,
  unitPriceIssue,
} from '@contrataflow/validation';
import type {
  ExclusionReason,
  FieldError,
  OutlierFlag,
  PriceResearchParameters,
  PriceSourceField,
  PriceSourceRequiredField,
  QuotationLine,
  QuotationStatus,
} from '@contrataflow/validation';
import { Decimal } from 'decimal.js';

/*
 * Fontes de pesquisa e cotações (US-026 · entities.md §4.8 `PriceSource`/`Quotation` ·
 * RN-PRICE-21..29). `PriceSource` é a evidência (art. 23, § 1º, da Lei 14.133/2021) cujos campos
 * exigidos vêm do tipo de fonte (`PRICE_SOURCE_TYPE.requiredFields`, lido na gravação — mudanças no
 * catálogo não retroagem); `Quotation` é o preço de um item numa fonte, único por (item, fonte).
 * Puro: sem NestJS, Prisma nem outro módulo. Preços com `decimal.js` (DEC-003).
 */

export interface PriceSource {
  readonly id: string;
  readonly tenantId: string;
  readonly priceResearchId: string;
  readonly processId: string;
  readonly sourceTypeId: string;
  readonly supplierId: string | null;
  readonly description: string;
  /** `AAAA-MM-DD`. */
  readonly quoteDate: string | null;
  readonly accessedAt: Date | null;
  readonly url: string | null;
  readonly referenceOrganization: string | null;
  readonly referenceDocument: string | null;
  readonly supplierChoiceJustification: string | null;
  readonly notes: string | null;
  readonly sortOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly version: number;
}

export interface Quotation {
  readonly id: string;
  readonly tenantId: string;
  readonly priceResearchId: string;
  readonly priceItemId: string;
  readonly priceSourceId: string;
  /** Decimal(18,4) normalizado (`"150.0000"`). */
  readonly unitPrice: string;
  readonly brandModel: string | null;
  readonly status: QuotationStatus;
  readonly exclusionReason: ExclusionReason | null;
  readonly exclusionJustification: string | null;
  readonly excludedById: string | null;
  readonly excludedAt: Date | null;
  readonly outlierFlag: OutlierFlag;
  readonly isExpired: boolean;
  readonly notes: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly version: number;
}

/** Regras do tipo de fonte lidas do catálogo no momento da gravação (RN-PRICE-21/26). */
export interface PriceSourceTypeRules {
  readonly id: string;
  readonly code: string;
  readonly requiredFields: readonly PriceSourceRequiredField[];
  readonly maxAgeDays: number | null;
  readonly ageReference: 'quoteDate' | 'accessedAt';
}

/** Campos editáveis da fonte (PRS-10/11), já normalizados pelo schema. */
export interface PriceSourceFields {
  readonly sourceTypeId: string;
  readonly description: string;
  readonly supplierId: string | null;
  readonly quoteDate: string | null;
  readonly accessedAt: Date | null;
  readonly url: string | null;
  readonly referenceOrganization: string | null;
  readonly referenceDocument: string | null;
  readonly supplierChoiceJustification: string | null;
  readonly notes: string | null;
}

/** Campos editáveis na ordem do formulário (a lista de `changes` da auditoria segue esta ordem). */
export const PRICE_SOURCE_EDITABLE_FIELDS = [
  'sourceTypeId',
  'description',
  'supplierId',
  'quoteDate',
  'accessedAt',
  'url',
  'referenceOrganization',
  'referenceDocument',
  'supplierChoiceJustification',
  'notes',
] as const satisfies readonly (keyof PriceSourceFields)[];

export type PriceSourceEditableField = (typeof PRICE_SOURCE_EDITABLE_FIELDS)[number];

// --- Fonte (RN-PRICE-21..23) -------------------------------------------------------------------

/**
 * RN-PRICE-21 · V-01: os campos exigidos pelo tipo ausentes (sem o anexo — RN-PRICE-28). Lista vazia
 * = a fonte pode ser gravada.
 */
export function missingRequiredFields(
  fields: PriceSourceFields,
  rules: Pick<PriceSourceTypeRules, 'requiredFields'>,
): PriceSourceField[] {
  return missingPriceSourceFields(
    {
      supplierId: fields.supplierId,
      quoteDate: fields.quoteDate,
      accessedAt: fields.accessedAt?.toISOString() ?? null,
      url: fields.url,
      referenceOrganization: fields.referenceOrganization,
      referenceDocument: fields.referenceDocument,
      supplierChoiceJustification: fields.supplierChoiceJustification,
    },
    rules.requiredFields,
  );
}

/**
 * RN-PRICE-23 · V-05: data do orçamento posterior a hoje (fuso do tenant) ou data/hora de acesso
 * posterior a agora → `DATE_IN_PAST` no campo (o código do catálogo para "não pode ser futura").
 */
export function sourceDateErrors(
  fields: Pick<PriceSourceFields, 'quoteDate' | 'accessedAt'>,
  clock: { readonly now: Date; readonly today: string },
): FieldError[] {
  const errors: FieldError[] = [];
  if (fields.quoteDate !== null && fields.quoteDate > clock.today) {
    errors.push({
      field: 'quoteDate',
      code: 'DATE_IN_PAST',
      message: PRICE_SOURCE_MESSAGES.dateFuture,
    });
  }
  if (fields.accessedAt !== null && fields.accessedAt.getTime() > clock.now.getTime()) {
    errors.push({
      field: 'accessedAt',
      code: 'DATE_IN_PAST',
      message: PRICE_SOURCE_MESSAGES.dateFuture,
    });
  }
  return errors;
}

export interface PriceSourceCreation {
  readonly id: string;
  readonly tenantId: string;
  readonly priceResearchId: string;
  readonly processId: string;
  readonly sortOrder: number;
  readonly userId: string | null;
  readonly now: Date;
}

/** `PriceSource.create` (fluxo principal 4): versão 1. */
export function createPriceSource(
  fields: PriceSourceFields,
  input: PriceSourceCreation,
): PriceSource {
  return {
    id: input.id,
    tenantId: input.tenantId,
    priceResearchId: input.priceResearchId,
    processId: input.processId,
    ...fields,
    sortOrder: input.sortOrder,
    createdAt: input.now,
    updatedAt: input.now,
    createdById: input.userId,
    updatedById: input.userId,
    version: 1,
  };
}

/** Os campos editáveis atuais da fonte. */
export function fieldsOf(source: PriceSource): PriceSourceFields {
  return {
    sourceTypeId: source.sourceTypeId,
    description: source.description,
    supplierId: source.supplierId,
    quoteDate: source.quoteDate,
    accessedAt: source.accessedAt,
    url: source.url,
    referenceOrganization: source.referenceOrganization,
    referenceDocument: source.referenceDocument,
    supplierChoiceJustification: source.supplierChoiceJustification,
    notes: source.notes,
  };
}

const sameValue = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

/**
 * `PriceSource.update` (FA-01): aplica o PATCH (`undefined` = não informado) e diz quais campos
 * mudaram, na ordem do formulário. A conferência dos campos exigidos é feita depois sobre o
 * resultado (trocar o tipo reavalia os obrigatórios).
 */
export function applySourcePatch(
  source: PriceSource,
  patch: Partial<Record<PriceSourceEditableField, unknown>>,
): { readonly fields: PriceSourceFields; readonly changed: readonly PriceSourceEditableField[] } {
  const current = fieldsOf(source);
  const next: Record<string, unknown> = { ...current };
  const changed: PriceSourceEditableField[] = [];
  for (const field of PRICE_SOURCE_EDITABLE_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    if (sameValue(value, current[field])) continue;
    next[field] = value;
    changed.push(field);
  }
  return { fields: next as unknown as PriceSourceFields, changed };
}

/** A fonte gravada com os campos novos (a versão sobe no repositório). */
export function withSourceFields(
  source: PriceSource,
  fields: PriceSourceFields,
  stamp: { readonly now: Date; readonly userId: string | null },
): PriceSource {
  return { ...source, ...fields, updatedAt: stamp.now, updatedById: stamp.userId };
}

// --- Validade (RN-PRICE-26) --------------------------------------------------------------------

/**
 * Validade em dias do tipo: sem `maxAgeDays` no catálogo, a fonte nunca expira. A pesquisa direta com
 * fornecedores e a contratação similar usam o valor fixado no snapshot da pesquisa
 * (`priceResearch.directQuoteMaxAgeDays`/`similarContractMaxAgeDays` — DEC-020), que é o parâmetro
 * configurável do órgão para esses tipos; os demais usam o do catálogo.
 */
export function effectiveMaxAgeDays(
  rules: Pick<PriceSourceTypeRules, 'code' | 'maxAgeDays'>,
  parameters: Pick<PriceResearchParameters, 'directQuoteMaxAgeDays' | 'similarContractMaxAgeDays'>,
): number | null {
  if (rules.maxAgeDays === null) return null;
  if (rules.code === 'PESQUISA_DIRETA_FORNECEDOR') return parameters.directQuoteMaxAgeDays;
  if (rules.code === 'CONTRATACAO_SIMILAR') return parameters.similarContractMaxAgeDays;
  return rules.maxAgeDays;
}

/** `AAAA-MM-DD` menos `days` dias (calendário UTC — datas sem hora). */
export function minusDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

/**
 * `Quotation.computeExpiration` (RN-PRICE-26): expirada quando a data de referência da fonte
 * (`quoteDate` ou a data local de `accessedAt`, conforme `ageReference` do tipo) antecede
 * `referenceDate − maxAgeDays`. Sem data de referência ou sem validade no tipo, nunca expira.
 */
export function isSourceExpired(
  source: Pick<PriceSource, 'quoteDate' | 'accessedAt'>,
  rules: PriceSourceTypeRules,
  research: {
    readonly referenceDate: string;
    readonly parameters: Pick<
      PriceResearchParameters,
      'directQuoteMaxAgeDays' | 'similarContractMaxAgeDays'
    >;
  },
  timezone: string,
): boolean {
  const maxAgeDays = effectiveMaxAgeDays(rules, research.parameters);
  if (maxAgeDays === null) return false;
  const reference =
    rules.ageReference === 'accessedAt'
      ? source.accessedAt === null
        ? null
        : localDateOf(source.accessedAt, timezone)
      : source.quoteDate;
  if (reference === null) return false;
  return reference < minusDays(research.referenceDate, maxAgeDays);
}

// --- Cotações (RN-PRICE-24/25) -----------------------------------------------------------------

/** Preço normalizado na escala da coluna (`numeric(18,4)`) com `decimal.js` (DEC-003). */
export function normalizeUnitPrice(unitPrice: string): string {
  return new Decimal(unitPrice.trim()).toFixed(4);
}

/** Linha da grade com preço (as vazias já foram descartadas). */
export interface QuotationWrite {
  readonly index: number;
  readonly priceItemId: string;
  readonly unitPrice: string;
  readonly brandModel: string | null;
  /** Cotação já existente do item nesta fonte (atualização), ou nenhuma (criação). */
  readonly existing: Quotation | null;
}

export interface QuotationGridPlan {
  readonly writes: readonly QuotationWrite[];
  readonly errors: readonly FieldError[];
  /** Linhas com preço sobre cotação `EXCLUDED` (V-07 — 409 `INVALID_STATE`). */
  readonly excluded: readonly number[];
}

const isEmptyLine = (line: QuotationLine) =>
  (line.unitPrice === undefined || line.unitPrice === null || line.unitPrice.trim() === '') &&
  (line.brandModel === undefined || line.brandModel === null);

/**
 * `UpsertQuotations` (RN-PRICE-24/25 · V-06/V-07): a linha vazia não altera nada; a linha com preço
 * cria ou atualiza a cotação do item nesta fonte; a idêntica à gravada é ignorada (sem auditoria nem
 * versão nova). Item fora da pesquisa → `REFERENCE_NOT_FOUND` em `items[i].priceItemId`; preço
 * inválido → `INVALID_DECIMAL` em `items[i].unitPrice`; cotação `EXCLUDED` nunca é sobrescrita.
 */
export function planQuotationGrid(input: {
  readonly lines: readonly QuotationLine[];
  readonly itemIds: ReadonlySet<string>;
  readonly existing: ReadonlyMap<string, Quotation>;
  readonly unitPriceDecimals: 2 | 4;
}): QuotationGridPlan {
  const writes: QuotationWrite[] = [];
  const errors: FieldError[] = [];
  const excluded: number[] = [];
  input.lines.forEach((line, index) => {
    if (!input.itemIds.has(line.priceItemId)) {
      errors.push({
        field: `items[${String(index)}].priceItemId`,
        code: 'REFERENCE_NOT_FOUND',
        message: PRICE_SOURCE_MESSAGES.priceItemInvalid,
      });
      return;
    }
    if (isEmptyLine(line)) return;
    const issue = unitPriceIssue(line.unitPrice, input.unitPriceDecimals);
    if (issue !== null) {
      errors.push({ field: `items[${String(index)}].unitPrice`, ...issue });
      return;
    }
    const existing = input.existing.get(line.priceItemId) ?? null;
    if (existing?.status === 'EXCLUDED') {
      excluded.push(index);
      return;
    }
    const unitPrice = normalizeUnitPrice(line.unitPrice ?? '');
    const brandModel = line.brandModel ?? null;
    if (existing?.unitPrice === unitPrice && existing.brandModel === brandModel) return;
    writes.push({ index, priceItemId: line.priceItemId, unitPrice, brandModel, existing });
  });
  return { writes, errors, excluded };
}

/** `Quotation` nova (RN-PRICE-24): `VALID`, sem marcação de outlier, versão 1. */
export function createQuotation(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly priceResearchId: string;
  readonly priceItemId: string;
  readonly priceSourceId: string;
  readonly unitPrice: string;
  readonly brandModel: string | null;
  readonly isExpired: boolean;
  readonly userId: string | null;
  readonly now: Date;
}): Quotation {
  return {
    id: input.id,
    tenantId: input.tenantId,
    priceResearchId: input.priceResearchId,
    priceItemId: input.priceItemId,
    priceSourceId: input.priceSourceId,
    unitPrice: input.unitPrice,
    brandModel: input.brandModel,
    status: 'VALID',
    exclusionReason: null,
    exclusionJustification: null,
    excludedById: null,
    excludedAt: null,
    outlierFlag: 'NONE',
    isExpired: input.isExpired,
    notes: null,
    createdAt: input.now,
    updatedAt: input.now,
    createdById: input.userId,
    updatedById: input.userId,
    version: 1,
  };
}

/** `Quotation.upsertPrice` (RN-PRICE-24): novo preço/marca (a versão sobe no repositório). */
export function withPrice(
  quotation: Quotation,
  input: {
    readonly unitPrice: string;
    readonly brandModel: string | null;
    readonly isExpired: boolean;
  },
  stamp: { readonly now: Date; readonly userId: string | null },
): Quotation {
  return {
    ...quotation,
    unitPrice: input.unitPrice,
    brandModel: input.brandModel,
    isExpired: input.isExpired,
    updatedAt: stamp.now,
    updatedById: stamp.userId,
  };
}

// --- Desconsiderar e restaurar (US-027 · RN-PRICE-30..33) ---------------------------------------

/**
 * `Quotation.exclude` (RN-PRICE-30/32): só uma cotação `VALID` pode ser desconsiderada. Devolve o
 * estado atual quando a transição é inválida (a API responde `INVALID_STATE` com o estado), senão
 * `null`.
 */
export function excludeBlockedBy(quotation: Pick<Quotation, 'status'>): QuotationStatus | null {
  return quotation.status === 'VALID' ? null : quotation.status;
}

/** `Quotation.restore` (RN-PRICE-32): só uma cotação `EXCLUDED` pode ser restaurada. */
export function restoreBlockedBy(quotation: Pick<Quotation, 'status'>): QuotationStatus | null {
  return quotation.status === 'EXCLUDED' ? null : quotation.status;
}

/**
 * Desconsidera a cotação: `EXCLUDED` com motivo, justificativa, autor e momento (o `CHECK` do banco
 * exige motivo e justificativa). A versão sobe no repositório. O chamador confere
 * `excludeBlockedBy` antes.
 */
export function excludeQuotation(
  quotation: Quotation,
  input: {
    readonly reason: ExclusionReason;
    readonly justification: string;
    readonly userId: string | null;
    readonly now: Date;
  },
): Quotation {
  if (excludeBlockedBy(quotation) !== null) {
    throw new Error(`Cotação ${quotation.id} não pode ser desconsiderada em ${quotation.status}.`);
  }
  return {
    ...quotation,
    status: 'EXCLUDED',
    exclusionReason: input.reason,
    exclusionJustification: input.justification,
    excludedById: input.userId,
    excludedAt: input.now,
    updatedAt: input.now,
    updatedById: input.userId,
  };
}

/** Restaura a cotação: volta a `VALID` e limpa os campos de exclusão (RN-PRICE-32). */
export function restoreQuotation(
  quotation: Quotation,
  stamp: { readonly now: Date; readonly userId: string | null },
): Quotation {
  if (restoreBlockedBy(quotation) !== null) {
    throw new Error(`Cotação ${quotation.id} não pode ser restaurada em ${quotation.status}.`);
  }
  return {
    ...quotation,
    status: 'VALID',
    exclusionReason: null,
    exclusionJustification: null,
    excludedById: null,
    excludedAt: null,
    updatedAt: stamp.now,
    updatedById: stamp.userId,
  };
}

/** Cotações válidas por item (`status = VALID`) — o `validQuotationsCount` do recálculo. */
export function validQuotationCounts(
  quotations: readonly Pick<Quotation, 'priceItemId' | 'status'>[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const quotation of quotations) {
    if (quotation.status !== 'VALID') continue;
    counts.set(quotation.priceItemId, (counts.get(quotation.priceItemId) ?? 0) + 1);
  }
  return counts;
}
