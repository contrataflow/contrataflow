import {
  PRICE_RESEARCH_MESSAGES,
  createPriceResearchSchema,
  manualPriceIssues,
  priceItemQuantityIssue,
  referenceDateIssue,
  updatePriceResearchSchema,
} from '@contrataflow/validation';
import type {
  CreatePriceResearch,
  PriceCalculationMethod,
  PriceDefaultMethod,
  PriceItemDto,
  PriceItemInput,
  PriceResearchLockReason,
  PriceResearchParameters,
  PriceRoundingMode,
  ProcessItemDto,
  UpdatePriceItem,
  UpdatePriceResearch,
} from '@contrataflow/validation';

import type { ApiError } from '@/lib/api/api-error';

import { displayQuantity } from '../dfd/dfd-model';

/*
 * Regras de tela da pesquisa de preços (US-024), puras e testáveis: linhas do diálogo de criação
 * (seleção + quantidade, V-01/V-03/V-04/V-05/V-06), mapeamento dos `errors[]` do 422 para as linhas,
 * itens do processo ausentes da pesquisa (FA-04) e o motivo de bloqueio da SCR-009.
 */

/** Linha do diálogo: um item do processo, marcado ou não, com a quantidade digitada. */
export interface ResearchRow {
  readonly processItemId: string;
  readonly sequence: number;
  readonly lotNumber: number | null;
  readonly lotName: string | null;
  readonly description: string;
  readonly unitLabel: string;
  readonly allowsDecimal: boolean;
  /** Quantidade de referência do item do processo, formatada (`""` quando ausente). */
  readonly referenceQuantity: string;
  readonly selected: boolean;
  /** Texto do campo "Quantidade" (padrão: a de referência). */
  readonly quantity: string;
}

/** O que o usuário mudou numa linha (o restante vem do item do processo). */
export interface RowEdit {
  readonly selected?: boolean;
  readonly quantity?: string;
}

/** Linhas por número do item, todas marcadas (RN-PRICE-03) e com a quantidade de referência. */
export function researchRows(
  processItems: readonly ProcessItemDto[],
  unitAllowsDecimal: ReadonlyMap<string, boolean>,
  edits: Readonly<Record<string, RowEdit>>,
): ResearchRow[] {
  return [...processItems]
    .sort((a, b) => a.sequence - b.sequence)
    .map((item) => {
      const reference = displayQuantity(item.referenceQuantity);
      const edit = edits[item.id];
      return {
        processItemId: item.id,
        sequence: item.sequence,
        lotNumber: item.lotNumber,
        lotName: item.lotName,
        description: item.description,
        unitLabel: item.unitOfMeasure.label,
        allowsDecimal: unitAllowsDecimal.get(item.unitOfMeasure.id) ?? true,
        referenceQuantity: reference,
        selected: edit?.selected ?? true,
        quantity: edit?.quantity ?? reference,
      };
    });
}

/** Texto digitado → decimal com ponto (aceita a vírgula do teclado brasileiro). */
export function normalizeQuantity(text: string): string {
  return text.trim().replace(',', '.');
}

export type RowIssue = 'MISSING' | { readonly message: string };

/**
 * Problema da quantidade de uma linha marcada: `MISSING` (FA-03 — "Informe a quantidade"), a
 * mensagem de V-04 (a mesma regra da API) ou `null`.
 */
export function rowIssue(row: ResearchRow): RowIssue | null {
  if (!row.selected) return null;
  const quantity = normalizeQuantity(row.quantity);
  if (quantity === '') return 'MISSING';
  const issue = priceItemQuantityIssue(quantity, row.allowsDecimal);
  return issue === null ? null : { message: issue.message };
}

/** Mensagem exibida na linha. */
export function rowMessage(issue: RowIssue | null): string | null {
  if (issue === null) return null;
  return issue === 'MISSING' ? PRICE_RESEARCH_MESSAGES.quantityMissing : issue.message;
}

/** Itens do corpo do PRS-02: só as linhas marcadas; `quantity` quando informada. */
export function itemsPayload(rows: readonly ResearchRow[]): PriceItemInput[] {
  return rows
    .filter((row) => row.selected)
    .map((row) => {
      const quantity = normalizeQuantity(row.quantity);
      return quantity === ''
        ? { processItemId: row.processItemId }
        : { processItemId: row.processItemId, quantity };
    });
}

export type HeaderField = 'title' | 'referenceDate' | 'templateId' | 'items';

export type HeaderIssues = Partial<Record<HeaderField, string>>;

export interface CreateDraft {
  readonly title: string;
  readonly referenceDate: string;
  readonly rows: readonly ResearchRow[];
  /** Hoje no fuso do tenant (`AAAA-MM-DD`). */
  readonly today: string;
}

/** Corpo do PRS-02 a partir do rascunho do diálogo. */
export function createBodyOf(draft: CreateDraft): CreatePriceResearch {
  return {
    title: draft.title.trim(),
    ...(draft.referenceDate === '' ? {} : { referenceDate: draft.referenceDate }),
    items: itemsPayload(draft.rows),
  };
}

/** Erros do cabeçalho (título, data-base e lista de itens) — o MESMO schema da API + V-05. */
export function headerIssues(draft: CreateDraft): HeaderIssues {
  const issues: HeaderIssues = {};
  if (draft.referenceDate === '') {
    issues.referenceDate = PRICE_RESEARCH_MESSAGES.referenceDateRequired;
  } else {
    const future = referenceDateIssue(draft.referenceDate, draft.today);
    if (future !== null) issues.referenceDate = future.message;
  }
  const result = createPriceResearchSchema.safeParse(createBodyOf(draft));
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = issue.path[0];
      if (field === 'title' || field === 'items') {
        // `items[i].processItemId` repetido não ocorre na UI (uma linha por item).
        if (issue.path.length === 1) issues[field] ??= issue.message;
      }
    }
  }
  return issues;
}

/** Mensagem por `processItemId` das linhas com problema (só as marcadas). */
export function rowIssues(rows: readonly ResearchRow[]): Map<string, RowIssue> {
  const issues = new Map<string, RowIssue>();
  for (const row of rows) {
    const issue = rowIssue(row);
    if (issue !== null) issues.set(row.processItemId, issue);
  }
  return issues;
}

/** O envio está liberado? (V-01, V-04, V-05, V-06 e a quantidade ausente — FA-03). */
export function canSubmit(draft: CreateDraft): boolean {
  return (
    Object.keys(headerIssues(draft)).length === 0 &&
    rowIssues(draft.rows).size === 0 &&
    draft.rows.some((row) => row.selected)
  );
}

/** Erros do 422 `VALIDATION_ERROR` do PRS-02 divididos entre as linhas e o cabeçalho. */
export interface MappedErrors {
  readonly rows: ReadonlyMap<string, string>;
  readonly header: HeaderIssues;
  /** Erros que não couberam em nenhum campo (para a faixa "Revise os campos destacados."). */
  readonly unmapped: readonly string[];
}

const ITEM_FIELD = /^items\[(\d+)\](?:\.(\w+))?$/;

/**
 * Mapeia `errors[]` (`items[i].quantity`, `items[i].processItemId`, `referenceDate`, `title`,
 * `templateId`) para as linhas e campos. `submitted` é a lista enviada (índice `i` → item).
 */
export function mapValidationErrors(
  error: ApiError,
  submitted: readonly PriceItemInput[],
): MappedErrors {
  const rows = new Map<string, string>();
  const header: Partial<Record<HeaderField, string>> = {};
  const unmapped: string[] = [];
  for (const entry of error.errors) {
    const item = ITEM_FIELD.exec(entry.field.replaceAll(/\.(\d+)(?=\.|$)/g, '[$1]'));
    if (item !== null) {
      const processItemId = submitted[Number(item[1])]?.processItemId;
      if (processItemId !== undefined) {
        rows.set(processItemId, entry.message);
        continue;
      }
    }
    if (
      entry.field === 'title' ||
      entry.field === 'referenceDate' ||
      entry.field === 'templateId' ||
      entry.field === 'items'
    ) {
      header[entry.field] ??= entry.message;
      continue;
    }
    unmapped.push(entry.message);
  }
  return { rows, header, unmapped };
}

/** 422 `BUSINESS_RULE_VIOLATION` com `PRICE_ITEMS_REQUIRED` (FA-02). */
export function isItemsRequired(error: ApiError): boolean {
  return (
    error.code === 'BUSINESS_RULE_VIOLATION' &&
    error.violations.some((violation) => violation.code === 'PRICE_ITEMS_REQUIRED')
  );
}

/** `meta.existingId` do 409 `DOCUMENT_ALREADY_EXISTS` (FA-01). */
export function existingResearchId(error: ApiError): string | null {
  const meta = (error.problem?.meta ?? {}) as { existingId?: unknown };
  return typeof meta.existingId === 'string' ? meta.existingId : null;
}

/** Itens do processo que ainda não estão na pesquisa (FA-04), por número do item. */
export function missingProcessItems(
  processItems: readonly ProcessItemDto[],
  priceItems: readonly PriceItemDto[],
): ProcessItemDto[] {
  const included = new Set(priceItems.map((item) => item.processItemId));
  return processItems
    .filter((item) => !included.has(item.id))
    .sort((a, b) => a.sequence - b.sequence);
}

/** Corpo do PRS-06: a quantidade de referência quando existe (senão, o servidor a resolve). */
export function addItemsPayload(missing: readonly ProcessItemDto[]): PriceItemInput[] {
  return missing.map((item) => {
    const quantity = displayQuantity(item.referenceQuantity);
    return quantity === '' ? { processItemId: item.id } : { processItemId: item.id, quantity };
  });
}

/** Chave de mensagem do motivo do bloqueio (`priceResearch.lock.<motivo>`). */
export function lockReasonKey(reason: PriceResearchLockReason | null): string {
  return reason ?? 'READ_ONLY';
}

/** Texto do valor "Sigiloso"? — o valor recomendado está mascarado (POL-09 · RN-PRICE-12). */
export function isItemMasked(item: PriceItemDto): boolean {
  return item.valuesMasked || item.recommendedUnitPriceMasked;
}

// --- US-029: método do item e parâmetros de cálculo (SCR-009) -----------------------------------

/** Rascunho do `MethodSelect` + `ManualPriceFieldset` (`''` = segue o método padrão da pesquisa). */
export interface MethodDraft {
  readonly methodOverride: PriceCalculationMethod | '';
  readonly manualUnitPrice: string;
  readonly manualJustification: string;
}

/** O rascunho inicial a partir do item gravado. */
export function methodDraftOf(item: PriceItemDto): MethodDraft {
  return {
    methodOverride: item.methodOverride ?? '',
    manualUnitPrice: item.manualUnitPrice === null ? '' : displayQuantity(item.manualUnitPrice),
    manualJustification: item.manualJustification ?? '',
  };
}

export type MethodIssues = Partial<Record<'manualUnitPrice' | 'manualJustification', string>>;

/** V-01/V-02 na tela — a MESMA regra da API (`manualPriceIssues`), só com `MANUAL`. */
export function methodIssues(draft: MethodDraft, unitPriceDecimals: 2 | 4): MethodIssues {
  if (draft.methodOverride !== 'MANUAL') return {};
  const issues: MethodIssues = {};
  for (const issue of manualPriceIssues(
    {
      manualUnitPrice: normalizeQuantity(draft.manualUnitPrice),
      manualJustification: draft.manualJustification,
    },
    unitPriceDecimals,
  )) {
    issues[issue.field] ??= issue.message;
  }
  return issues;
}

/** Corpo do PRS-07: o método e, só com `MANUAL`, valor e justificativa. */
export function methodBodyOf(draft: MethodDraft): UpdatePriceItem {
  if (draft.methodOverride !== 'MANUAL') {
    return { methodOverride: draft.methodOverride === '' ? null : draft.methodOverride };
  }
  return {
    methodOverride: 'MANUAL',
    manualUnitPrice: normalizeQuantity(draft.manualUnitPrice),
    manualJustification: draft.manualJustification.trim(),
  };
}

/** O rascunho difere do item gravado? (reenviar o mesmo método não grava — [Duplicidade]). */
export function methodChanged(draft: MethodDraft, item: PriceItemDto): boolean {
  const saved = methodDraftOf(item);
  if (draft.methodOverride !== saved.methodOverride) return true;
  if (draft.methodOverride !== 'MANUAL') return false;
  return (
    normalizeQuantity(draft.manualUnitPrice) !== normalizeQuantity(saved.manualUnitPrice) ||
    draft.manualJustification.trim() !== saved.manualJustification
  );
}

/** "Valor manual" × "Automático" × método fixado no item (o selo do `MethodSelect`). */
export function methodBadge(item: PriceItemDto): 'MANUAL' | 'AUTOMATIC' | 'OVERRIDE' {
  if (item.methodOverride === 'MANUAL') return 'MANUAL';
  return item.methodOverride === null ? 'AUTOMATIC' : 'OVERRIDE';
}

/** Rascunho do editor de parâmetros (FA-03 · RN-PRICE-47). */
export interface ParametersDraft {
  readonly defaultMethod: PriceDefaultMethod;
  readonly cvThresholdPercent: string;
  readonly minQuotations: string;
  readonly unitPriceDecimals: 2 | 4;
  readonly roundingMode: PriceRoundingMode;
}

export function parametersDraftOf(parameters: PriceResearchParameters): ParametersDraft {
  return {
    defaultMethod: parameters.defaultMethod,
    cvThresholdPercent: displayQuantity(parameters.cvThresholdPercent),
    minQuotations: String(parameters.minQuotations),
    unitPriceDecimals: parameters.unitPriceDecimals,
    roundingMode: parameters.roundingMode,
  };
}

/** Corpo do PRS-04 com os parâmetros alterados (vazio = nada a enviar) e os erros de faixa. */
export function parametersPatchOf(
  draft: ParametersDraft,
  current: PriceResearchParameters,
): {
  readonly body: UpdatePriceResearch;
  readonly issues: Partial<Record<keyof ParametersDraft, string>>;
} {
  const candidate = {
    defaultMethod: draft.defaultMethod,
    cvThresholdPercent: normalizeQuantity(draft.cvThresholdPercent),
    minQuotations: Number(draft.minQuotations),
    unitPriceDecimals: draft.unitPriceDecimals,
    roundingMode: draft.roundingMode,
  };
  const parsed = updatePriceResearchSchema.safeParse(candidate);
  const issues: Partial<Record<keyof ParametersDraft, string>> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as keyof ParametersDraft;
      issues[field] ??= PRICE_RESEARCH_MESSAGES.parameterInvalid;
    }
  }
  const body: { -readonly [K in keyof UpdatePriceResearch]: UpdatePriceResearch[K] } = {};
  if (candidate.defaultMethod !== current.defaultMethod) {
    body.defaultMethod = candidate.defaultMethod;
  }
  if (
    issues.cvThresholdPercent === undefined &&
    Number(candidate.cvThresholdPercent) !== Number(current.cvThresholdPercent)
  ) {
    body.cvThresholdPercent = candidate.cvThresholdPercent;
  }
  if (candidate.minQuotations !== current.minQuotations) {
    body.minQuotations = candidate.minQuotations;
  }
  if (candidate.unitPriceDecimals !== current.unitPriceDecimals) {
    body.unitPriceDecimals = candidate.unitPriceDecimals;
  }
  if (candidate.roundingMode !== current.roundingMode) body.roundingMode = candidate.roundingMode;
  return { body, issues };
}
