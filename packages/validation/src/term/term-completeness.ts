import type { TermEstimatedValueSource } from './term.js';
import { DOCUMENT_LIMITS } from '../document/document.js';
import type { DraftSection } from '../document/document.js';
import { richTextPlainText } from '../document/rich-text.js';
import type { Violation } from '../http/problem.js';

/*
 * Completude do TR (US-039 · RN-TR-34..36 · api.md §2.1.2): função PURA, sem I/O. O servidor
 * (`TermDocumentValidator`) a alimenta com o cabeçalho, os itens do TR e — havendo ETP `FINALIZED`/
 * `APPROVED` no processo — os itens do ETP; o `document` a compõe com as regras genéricas de seção
 * (`SECTION_REQUIRED`/`SECTION_JUSTIFICATION_REQUIRED`/`FIELD_REQUIRED`) num único `violations[]`.
 * O DOC-08 (painel "Completude do TR") e a revalidação do DOC-09/DOC-10 usam o mesmo registro.
 * Comparações determinísticas; a análise com IA fica para o MVP 5 (DEC-019).
 */

/** Mensagens da US-039 (RN-TR-35/36, Validações V-01..V-08 e "Casos de erro"). */
export const TERM_COMPLETENESS_MESSAGES = Object.freeze({
  estimatedValueRequired: 'Informe o valor estimado do TR (pesquisa de preços, ETP ou manual).',
  estimatedValueJustificationRequired:
    'Valor estimado informado manualmente: preencha a seção "Estimativa do valor da contratação" com a justificativa e a memória do valor.',
  itemsRequired: 'Informe ao menos um item com quantidade.',
  selectionCriterionRequired: 'Defina o critério de julgamento.',
  awardTypeRequired: 'Defina o tipo de adjudicação.',
  itemQuantityDivergent: (sequence: number | null, trQuantity: string, etpQuantity: string) =>
    `A quantidade do item ${sequence === null ? '' : `${String(sequence)} `}no TR (${trQuantity}) diverge da quantidade no ETP (${etpQuantity}).`,
  guaranteeNotDefined:
    'Nenhuma garantia definida: nem a garantia do produto nem a garantia contratual foram informadas.',
  incomplete: 'Resolva as pendências antes de concluir.',
  warningsNotAcknowledged: 'Reconheça os avisos antes de concluir.',
  notEditable: 'O TR não pode ser concluído no status atual.',
  typeNotAllowedInStage: 'O TR não pode ser concluído nesta etapa.',
  permissionDenied: 'Você não tem permissão para concluir este TR.',
  versionConflict: 'O TR foi alterado por outra pessoa. Recarregue para continuar.',
});

/** Catálogo dos códigos `TR_*` de completude (api.md §2.1.2 — esta story é a dona). */
export const TERM_BLOCKING_CODES = [
  'TR_ESTIMATED_VALUE_REQUIRED',
  'TR_ESTIMATED_VALUE_JUSTIFICATION_REQUIRED',
  'TR_ITEMS_REQUIRED',
  'TR_SELECTION_CRITERION_REQUIRED',
  'TR_AWARD_TYPE_REQUIRED',
] as const;
export const TERM_WARNING_CODES = [
  'TR_ITEM_QUANTITY_DIVERGENT',
  'TR_GUARANTEE_NOT_DEFINED',
] as const;
export const TERM_VIOLATION_CODES = [...TERM_BLOCKING_CODES, ...TERM_WARNING_CODES] as const;
export type TermViolationCode = (typeof TERM_VIOLATION_CODES)[number];

/** Chave da seção do valor estimado no modelo padrão (US-036 — critério da justificativa). */
export const TERM_ESTIMATED_VALUE_SECTION_KEY = 'ESTIMATED_VALUE';

export interface TermCompletenessItem {
  /** Id da linha `DocumentItem` do TR (vai em `itemId`). */
  readonly id: string;
  readonly processItemId: string;
  /** Decimal(18,4) como string. */
  readonly quantity: string | null;
}

export interface TermCompletenessEtpItem {
  readonly processItemId: string;
  /** Número do item no processo (o mesmo no ETP e no TR). */
  readonly sequence: number | null;
  readonly quantity: string | null;
}

export interface TermCompletenessInput {
  /** Decimal(18,2) como string; `null` = sem valor. */
  readonly estimatedTotalValue: string | null;
  readonly estimatedValueSource: TermEstimatedValueSource | null;
  readonly selectionCriterionId: string | null;
  readonly awardType: string | null;
  readonly productWarrantyMonths: number | null;
  /** Decimal(9,4) como string. */
  readonly contractGuaranteePercent: string | null;
  /** A seção `ESTIMATED_VALUE` do rascunho (ausente = vazia). */
  readonly estimatedValueSection: DraftSection | undefined;
  readonly items: readonly TermCompletenessItem[];
  /** Itens do ETP `FINALIZED`/`APPROVED` do processo; `null` = sem ETP elegível (sem avisos de divergência). */
  readonly etpItems: readonly TermCompletenessEtpItem[] | null;
}

function violation(
  code: TermViolationCode,
  message: string,
  location: Partial<Pick<Violation, 'sectionKey' | 'field' | 'itemId'>>,
  severity: Violation['severity'] = 'BLOCKING',
  params: Record<string, unknown> = {},
): Violation {
  return {
    code,
    severity,
    message,
    ruleId: null,
    sectionKey: location.sectionKey ?? null,
    field: location.field ?? null,
    itemId: location.itemId ?? null,
    params,
  };
}

const isBlank = (value: string | null) => value === null || value.trim() === '';

/**
 * Forma canônica de um decimal em string (`"50.0000"` → `"50"`, `"2.5000"` → `"2.5"`); `null` se
 * não for um decimal não negativo. Comparação exata, sem ponto flutuante.
 */
export function canonicalQuantity(value: string | null): string | null {
  if (value === null) return null;
  const match = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(value);
  if (match === null) return null;
  const integer = (match[1] ?? '0').replace(/^0+(?=\d)/, '');
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  return fraction === '' ? integer : `${integer}.${fraction}`;
}

const hasQuantity = (quantity: string | null) => {
  const canonical = canonicalQuantity(quantity);
  return canonical !== null && canonical !== '0';
};

/** Quantidade como o usuário lê (`"2.5"` → `"2,5"`). */
const displayQuantity = (canonical: string) => canonical.replace('.', ',');

/** RN-TR-08 (lacuna 3 da story): a seção do valor preenchida OU "não se aplica" justificado. */
function estimatedValueJustified(section: DraftSection | undefined): boolean {
  if (section === undefined) return false;
  if (section.state === 'NOT_APPLICABLE') {
    return (section.justification?.trim().length ?? 0) >= DOCUMENT_LIMITS.reasonMin;
  }
  return section.content ? richTextPlainText(section.content).trim() !== '' : false;
}

/**
 * As pendências próprias do TR, bloqueantes antes dos avisos:
 * - RN-TR-35: valor estimado (sem valor → só `TR_ESTIMATED_VALUE_REQUIRED`; com valor `MANUAL`, a
 *   seção do valor justificada), ao menos um item com quantidade, critério de julgamento e tipo de
 *   adjudicação;
 * - RN-TR-36: com ETP elegível, `TR_ITEM_QUANTITY_DIVERGENT` por item comum (`processItemId`) com
 *   quantidade diferente; garantia do produto e contratual ambas nulas → `TR_GUARANTEE_NOT_DEFINED`.
 */
export function evaluateTermCompleteness(input: TermCompletenessInput): Violation[] {
  const blocking: Violation[] = [];
  const warnings: Violation[] = [];
  const messages = TERM_COMPLETENESS_MESSAGES;

  if (isBlank(input.estimatedTotalValue)) {
    blocking.push(
      violation('TR_ESTIMATED_VALUE_REQUIRED', messages.estimatedValueRequired, {
        field: 'estimatedTotalValue',
      }),
    );
  } else if (
    input.estimatedValueSource === 'MANUAL' &&
    !estimatedValueJustified(input.estimatedValueSection)
  ) {
    blocking.push(
      violation(
        'TR_ESTIMATED_VALUE_JUSTIFICATION_REQUIRED',
        messages.estimatedValueJustificationRequired,
        { sectionKey: TERM_ESTIMATED_VALUE_SECTION_KEY },
      ),
    );
  }
  if (!input.items.some((item) => hasQuantity(item.quantity))) {
    blocking.push(violation('TR_ITEMS_REQUIRED', messages.itemsRequired, { field: 'items' }));
  }
  if (isBlank(input.selectionCriterionId)) {
    blocking.push(
      violation('TR_SELECTION_CRITERION_REQUIRED', messages.selectionCriterionRequired, {
        field: 'selectionCriterionId',
      }),
    );
  }
  if (input.awardType === null || input.awardType.trim() === '') {
    blocking.push(
      violation('TR_AWARD_TYPE_REQUIRED', messages.awardTypeRequired, { field: 'awardType' }),
    );
  }

  if (input.etpItems !== null) {
    const etpByProcessItem = new Map(input.etpItems.map((item) => [item.processItemId, item]));
    for (const item of input.items) {
      const etp = etpByProcessItem.get(item.processItemId);
      if (etp === undefined) continue;
      const trQuantity = canonicalQuantity(item.quantity);
      const etpQuantity = canonicalQuantity(etp.quantity);
      if (trQuantity === null || etpQuantity === null || trQuantity === etpQuantity) continue;
      warnings.push(
        violation(
          'TR_ITEM_QUANTITY_DIVERGENT',
          messages.itemQuantityDivergent(
            etp.sequence,
            displayQuantity(trQuantity),
            displayQuantity(etpQuantity),
          ),
          { field: 'items', itemId: item.id },
          'WARNING',
          { etpQuantity, trQuantity, processItemId: item.processItemId, sequence: etp.sequence },
        ),
      );
    }
  }
  if (input.productWarrantyMonths === null && isBlank(input.contractGuaranteePercent)) {
    warnings.push(
      violation(
        'TR_GUARANTEE_NOT_DEFINED',
        messages.guaranteeNotDefined,
        { field: 'productWarrantyMonths' },
        'WARNING',
      ),
    );
  }
  return [...blocking, ...warnings];
}
