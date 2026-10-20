import { z } from 'zod';

import { ETP_ESTIMATED_VALUE_SOURCES, PARCELING_DECISIONS } from './etp.js';
import type { FieldError } from '../http/problem.js';

/*
 * Estimativas do ETP (US-022 · RN-ETP-25..32 · api/06-etp.md ETP-04): a origem do valor estimado
 * total — `MANUAL` (valor ≥ 0 com 2 casas) ou `PRICE_RESEARCH` (a pesquisa não cancelada do mesmo
 * processo; o valor passa a ser derivado, somente leitura, e é sincronizado pelo worker a cada
 * recálculo/conclusão da pesquisa — RN-ETP-29). As quantidades e a memória de cálculo por item vão
 * pelo DOC-07 genérico (`documentItemsReplaceSchema` com `calculationMemo`). As mesmas regras no
 * painel "Valor estimado" da SCR-008 e na API (`etpEstimateIssues`).
 */

/** Mensagens da US-022 (Validações V-04..V-08 e "Casos de erro"). */
export const ETP_ESTIMATE_MESSAGES = Object.freeze({
  sourceRequired: 'Escolha como o valor estimado será definido.',
  valueRequired: 'Informe o valor estimado total.',
  valueInvalid: 'Informe um valor válido, com até 2 casas decimais.',
  valueReadOnly: 'O valor vinculado à pesquisa de preços é calculado automaticamente.',
  priceResearchRequired: 'Selecione a pesquisa de preços deste processo.',
  priceResearchInvalid: 'Selecione uma pesquisa de preços válida deste processo.',
  priceResearchNotAllowed: 'O valor manual não se vincula a uma pesquisa de preços.',
  notEditable: 'Este ETP não pode ser editado no momento.',
  versionConflict: 'Os dados foram alterados por outra pessoa.',
  permissionDenied: 'Você não tem permissão para editar este ETP.',
  unavailable: 'Não foi possível salvar agora. Tente novamente em instantes.',
  /** FA-03: pesquisa vinculada sem estatística ainda. */
  awaitingCalculation: 'Aguardando cálculo da pesquisa de preços',
  /** FA-04: o vínculo foi desfeito com o cancelamento da pesquisa (o último valor fica). */
  stale: 'Valor desatualizado — escolha a origem novamente',
  /** US-023: conclusão fora de `VIABLE`/`NOT_VIABLE`. */
  conclusionInvalid: 'Escolha se o ETP conclui pela viabilidade ou pela não viabilidade.',
  /** US-023: decisão sobre o parcelamento fora de `ParcelingDecision`. */
  parcelingInvalid: 'Escolha uma decisão sobre o parcelamento válida.',
});

/** `Decimal(18,2)` ≥ 0 com até 2 casas, ponto como separador (RN-ETP-28 · V-05). */
export const ETP_MONEY_PATTERN = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;

/** V-05: problema do valor manual digitado; `null` = válido. */
export function etpEstimatedValueIssue(value: string): FieldError | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return {
      field: 'estimatedTotalValue',
      code: 'REQUIRED',
      message: ETP_ESTIMATE_MESSAGES.valueRequired,
    };
  }
  return ETP_MONEY_PATTERN.test(trimmed)
    ? null
    : {
        field: 'estimatedTotalValue',
        code: 'INVALID_DECIMAL',
        message: ETP_ESTIMATE_MESSAGES.valueInvalid,
      };
}

// --- Contrato -----------------------------------------------------------------------------------

/** Conclusões aceitas no ETP-04 (US-023): `PENDING` é só o estado inicial. */
export const ETP_PATCH_CONCLUSIONS = ['VIABLE', 'NOT_VIABLE'] as const;

/**
 * ETP-04 — corpo de `PATCH /etps/{id}` (`If-Match` com a versão do ETP): as estimativas (US-022) e,
 * na US-023, a conclusão e a decisão sobre o parcelamento (RN-ETP-34/35 — `PENDING` não volta pelo
 * PATCH: a conclusão é definida como viável ou não viável).
 */
export const etpUpdateSchema = z
  .strictObject({
    estimatedValueSource: z
      .enum(ETP_ESTIMATED_VALUE_SOURCES, { error: ETP_ESTIMATE_MESSAGES.sourceRequired })
      .optional(),
    /** Só com `MANUAL` (RN-ETP-28); POL-09. */
    estimatedTotalValue: z
      .string({ error: ETP_ESTIMATE_MESSAGES.valueInvalid })
      .refine((value) => ETP_MONEY_PATTERN.test(value), {
        error: ETP_ESTIMATE_MESSAGES.valueInvalid,
        params: { code: 'INVALID_DECIMAL' },
      })
      .optional()
      .meta({
        description: 'Decimal ≥ 0 com até 2 casas, ponto como separador (ex.: "125000.00").',
      }),
    /** Só com `PRICE_RESEARCH`: pesquisa não cancelada do mesmo processo (DEC-020). */
    priceResearchId: z.uuid({ error: ETP_ESTIMATE_MESSAGES.priceResearchInvalid }).optional(),
    /** US-023 (RN-ETP-34/35): `VIABLE` | `NOT_VIABLE`. */
    conclusion: z
      .enum(ETP_PATCH_CONCLUSIONS, { error: ETP_ESTIMATE_MESSAGES.conclusionInvalid })
      .optional(),
    /** US-023 (RN-ETP-34): `ParcelingDecision`. */
    parcelingDecision: z
      .enum(PARCELING_DECISIONS, { error: ETP_ESTIMATE_MESSAGES.parcelingInvalid })
      .optional(),
  })
  .meta({ id: 'EtpUpdateRequest' });
export type EtpUpdate = z.infer<typeof etpUpdateSchema>;

/** O corpo mexe nas estimativas (US-022)? Sem nenhum campo, vale a regra das estimativas (V-04). */
export function etpPatchTouchesEstimate(patch: EtpUpdate): boolean {
  const { estimatedValueSource, estimatedTotalValue, priceResearchId } = patch;
  if (estimatedValueSource !== undefined) return true;
  if (estimatedTotalValue !== undefined || priceResearchId !== undefined) return true;
  return patch.conclusion === undefined && patch.parcelingDecision === undefined;
}

/**
 * RN-ETP-28 sobre o corpo já no formato: origem obrigatória (V-04 — `REQUIRED`); `MANUAL` exige o
 * valor e não aceita pesquisa; `PRICE_RESEARCH` exige a pesquisa e não aceita valor (somente
 * leitura). Um único `errors[]` com todos os problemas. Corpo só com `conclusion`/
 * `parcelingDecision` (US-023) não mexe nas estimativas — sem problemas aqui.
 */
export function etpEstimateIssues(patch: EtpUpdate): FieldError[] {
  if (!etpPatchTouchesEstimate(patch)) return [];
  const { estimatedValueSource: source, estimatedTotalValue: value, priceResearchId } = patch;
  if (source === undefined) {
    return [
      {
        field: 'estimatedValueSource',
        code: 'REQUIRED',
        message: ETP_ESTIMATE_MESSAGES.sourceRequired,
      },
    ];
  }
  const errors: FieldError[] = [];
  if (source === 'MANUAL') {
    if (value === undefined) {
      errors.push({
        field: 'estimatedTotalValue',
        code: 'REQUIRED',
        message: ETP_ESTIMATE_MESSAGES.valueRequired,
      });
    }
    if (priceResearchId !== undefined) {
      errors.push({
        field: 'priceResearchId',
        code: 'NOT_ALLOWED',
        message: ETP_ESTIMATE_MESSAGES.priceResearchNotAllowed,
      });
    }
    return errors;
  }
  if (priceResearchId === undefined) {
    errors.push({
      field: 'priceResearchId',
      code: 'REQUIRED',
      message: ETP_ESTIMATE_MESSAGES.priceResearchRequired,
    });
  }
  if (value !== undefined) {
    errors.push({
      field: 'estimatedTotalValue',
      code: 'NOT_ALLOWED',
      message: ETP_ESTIMATE_MESSAGES.valueReadOnly,
    });
  }
  return errors;
}

/** `"125000"` → `"125000.00"`; `"0.5"` → `"0.50"` (a string já passou por `ETP_MONEY_PATTERN`). */
export function normalizeEtpMoney(value: string): string {
  const [integer = '0', fraction = ''] = value.trim().split('.');
  return `${integer}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}
