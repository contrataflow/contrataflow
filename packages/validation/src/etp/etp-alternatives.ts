import { z } from 'zod';

import { isoDateTimeSchema } from '../common/dates.js';
import { uuidV7Schema } from '../common/identifiers.js';
import { richTextPlainText, richTextProblem } from '../document/rich-text.js';
import { RISK_LEVELS } from '../risk/risk.js';
import type { RiskLevel } from '../risk/risk.js';

/*
 * Alternativas de solução do ETP (US-021 · entities.md `EtpAlternative` · api/06-etp.md ETP-05..09 ·
 * Lei 14.133/2021, art. 18, §1º, V e VII). Coleção tipada do ETP (DEC-017), distinta das seções
 * narrativas: a seção `ALTERNATIVES` (`render = ALTERNATIVES_TABLE`) só exibe o quadro comparativo.
 * Os MESMOS schemas validam o `AlternativeFormDrawer`/`DecideAlternativeDialog` da SCR-008 e o corpo
 * da API; o quadro comparativo (RN-ETP-23) e a regra da justificativa (RN-ETP-19) são as funções
 * únicas usadas pela API e pela UI.
 */

/** entities.md §2 — `AlternativeDecision` (RN-ETP-19). */
export const ALTERNATIVE_DECISIONS = ['UNDER_ANALYSIS', 'RECOMMENDED', 'DISCARDED'] as const;
export type AlternativeDecision = (typeof ALTERNATIVE_DECISIONS)[number];

export const ALTERNATIVE_DECISION_LABELS: Readonly<Record<AlternativeDecision, string>> =
  Object.freeze({
    UNDER_ANALYSIS: 'Em análise',
    RECOMMENDED: 'Recomendada',
    DISCARDED: 'Descartada',
  });

/** Limites dos campos (US-021 · "Campos" · RN-ETP-18/19). */
export const ETP_ALTERNATIVE_LIMITS = Object.freeze({
  nameMax: 150,
  justificationMin: 20,
  justificationMax: 4000,
  observationsMax: 4000,
  sortOrderMax: 100_000,
});

/** Mensagens das Validações V-01..V-09 e dos "Casos de erro" da US-021. */
export const ETP_ALTERNATIVE_MESSAGES = Object.freeze({
  nameInvalid: 'Informe um nome de até 150 caracteres para a alternativa.',
  descriptionRequired: 'Descreva a alternativa.',
  nameDuplicate: 'Já existe uma alternativa com este nome neste ETP.',
  justificationRequired: 'Justifique a decisão (mín. 20 caracteres).',
  justificationLength: 'A justificativa deve ter no máximo 4.000 caracteres.',
  recommendedExists: 'Já existe uma alternativa recomendada. Substituir pela atual?',
  deleteRecommended: 'Altere a decisão desta alternativa antes de excluí-la.',
  costInvalid: 'Informe um valor válido, com até 2 casas decimais.',
  riskLevelInvalid: 'Selecione um nível de risco válido.',
  decisionInvalid: 'Selecione uma decisão válida.',
  observationsLength: 'As observações devem ter no máximo 4.000 caracteres.',
  sortOrderInvalid: 'Informe uma posição válida.',
  notEditable: 'Este ETP não pode ser editado no status atual.',
  versionConflict: 'Alguém alterou esta alternativa. Recarregue para ver as mudanças.',
  permissionDenied: 'Você não pode editar as alternativas deste ETP.',
  /** POL-09: sem a política, o custo de processo sigiloso não é exibido nem alterado. */
  confidentialCost: 'Você não pode alterar o custo estimado deste processo sigiloso.',
  notFound: 'Alternativa não encontrada.',
  unavailable: 'Não foi possível salvar agora. Tente novamente em instantes.',
});

// --- Regras puras (API e UI) --------------------------------------------------------------------

/** RN-ETP-19: decidir `RECOMMENDED`/`DISCARDED` exige justificativa. */
export function decisionRequiresJustification(decision: AlternativeDecision): boolean {
  return decision !== 'UNDER_ANALYSIS';
}

/**
 * V-04 (RN-ETP-19): `CONDITIONAL_REQUIRED` sem justificativa e `TOO_SHORT` abaixo de 20 caracteres
 * (sem contar espaços nas pontas); `null` = aceita.
 */
export function decisionJustificationProblem(
  decision: AlternativeDecision,
  justification: string | null | undefined,
): 'CONDITIONAL_REQUIRED' | 'TOO_SHORT' | null {
  if (!decisionRequiresJustification(decision)) return null;
  const text = (justification ?? '').trim();
  if (text === '') return 'CONDITIONAL_REQUIRED';
  if (Array.from(text).length < ETP_ALTERNATIVE_LIMITS.justificationMin) return 'TOO_SHORT';
  return null;
}

/** Nome normalizado para a unicidade por ETP (RN-ETP-18 — `lower(name)` no índice). */
export function alternativeNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Linha do quadro comparativo (RN-ETP-23). */
export interface AlternativeComparisonRow {
  readonly id: string;
  readonly name: string;
  readonly decision: AlternativeDecision;
  readonly estimatedCost: string | null;
  readonly estimatedCostMasked: boolean;
  readonly riskLevel: RiskLevel | null;
  readonly isRecommended: boolean;
  /** O menor custo informado entre as alternativas não descartadas (sem custo mascarado). */
  readonly isLowestCost: boolean;
}

interface ComparableAlternative {
  readonly id: string;
  readonly name: string;
  readonly decision: AlternativeDecision;
  readonly estimatedCost: string | null;
  readonly estimatedCostMasked: boolean;
  readonly riskLevel: RiskLevel | null;
  readonly sortOrder: number;
  readonly createdAt: string;
}

/** Centavos de um `Decimal(18,2)` em string (comparação exata, sem ponto flutuante). */
function cents(value: string): bigint {
  const [integer = '0', fraction = ''] = value.split('.');
  return BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
}

/**
 * RN-ETP-23: as alternativas por `sortOrder` (empate: criação, id) com nome, decisão, custo
 * (mascarado conforme POL-09 — já `null` na resposta) e risco; destaca a recomendada e o menor custo
 * entre as não descartadas.
 */
export function alternativesComparison(
  alternatives: readonly ComparableAlternative[],
): AlternativeComparisonRow[] {
  const ordered = [...alternatives].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
  let lowest: bigint | null = null;
  for (const alternative of ordered) {
    if (alternative.decision === 'DISCARDED' || alternative.estimatedCost === null) continue;
    const value = cents(alternative.estimatedCost);
    if (lowest === null || value < lowest) lowest = value;
  }
  const lowestCount =
    lowest === null
      ? 0
      : ordered.filter(
          (alternative) =>
            alternative.decision !== 'DISCARDED' &&
            alternative.estimatedCost !== null &&
            cents(alternative.estimatedCost) === lowest,
        ).length;
  return ordered.map((alternative) => ({
    id: alternative.id,
    name: alternative.name,
    decision: alternative.decision,
    estimatedCost: alternative.estimatedCost,
    estimatedCostMasked: alternative.estimatedCostMasked,
    riskLevel: alternative.riskLevel,
    isRecommended: alternative.decision === 'RECOMMENDED',
    // Com uma única alternativa com custo, "menor custo" não diz nada.
    isLowestCost:
      lowest !== null &&
      lowestCount < ordered.length &&
      alternative.decision !== 'DISCARDED' &&
      alternative.estimatedCost !== null &&
      cents(alternative.estimatedCost) === lowest,
  }));
}

/** Próximo `sortOrder`: depois do maior da lista (RN-ETP-18 — "ao final da lista"). */
export function nextAlternativeSortOrder(
  alternatives: readonly { readonly sortOrder: number }[],
): number {
  return alternatives.reduce((max, alternative) => Math.max(max, alternative.sortOrder + 1), 0);
}

// --- Campos -------------------------------------------------------------------------------------

/** `Decimal(18,2)` ≥ 0 com até 2 casas (V-07). */
const MONEY_PATTERN = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;

const nameSchema = z
  .string({ error: ETP_ALTERNATIVE_MESSAGES.nameInvalid })
  .trim()
  .min(1, { error: ETP_ALTERNATIVE_MESSAGES.nameInvalid })
  .max(ETP_ALTERNATIVE_LIMITS.nameMax, { error: ETP_ALTERNATIVE_MESSAGES.nameInvalid });

/** Documento TipTap (DEC-056) conferido como o `TipTapDoc`, com a mensagem própria do campo. */
function richText(missing: string) {
  return z
    .looseObject(
      { type: z.literal('doc'), content: z.array(z.unknown()).optional() },
      { error: (issue) => (issue.input === undefined ? missing : 'Conteúdo rico malformado.') },
    )
    .superRefine((doc, ctx) => {
      const problem = richTextProblem(doc);
      if (problem) {
        ctx.addIssue({ code: 'custom', message: problem, params: { code: 'INVALID_FORMAT' } });
      }
    });
}

/** V-02: obrigatória e com texto (documento vazio = ausente — `REQUIRED`). */
const descriptionSchema = richText(ETP_ALTERNATIVE_MESSAGES.descriptionRequired).superRefine(
  (doc, ctx) => {
    if (richTextPlainText(doc).trim() === '') {
      ctx.addIssue({
        code: 'custom',
        message: ETP_ALTERNATIVE_MESSAGES.descriptionRequired,
        params: { code: 'REQUIRED' },
      });
    }
  },
);

const optionalRichText = richText('Conteúdo rico malformado.').nullish();

/** V-07: string decimal ≥ 0 com até 2 casas (`INVALID_DECIMAL`); `null` limpa. */
const estimatedCostSchema = z
  .string({ error: ETP_ALTERNATIVE_MESSAGES.costInvalid })
  .refine((value) => MONEY_PATTERN.test(value), {
    error: ETP_ALTERNATIVE_MESSAGES.costInvalid,
    params: { code: 'INVALID_DECIMAL' },
  })
  .nullish()
  .meta({ description: 'Decimal ≥ 0 com até 2 casas, ponto como separador (ex.: "15000.00").' });

const riskLevelSchema = z
  .enum(RISK_LEVELS, { error: ETP_ALTERNATIVE_MESSAGES.riskLevelInvalid })
  .nullish();

const observationsSchema = z
  .string()
  .trim()
  .max(ETP_ALTERNATIVE_LIMITS.observationsMax, {
    error: ETP_ALTERNATIVE_MESSAGES.observationsLength,
  })
  .transform((value) => (value === '' ? null : value))
  .nullish();

// --- Corpos -------------------------------------------------------------------------------------

/**
 * ETP-06 — corpo de `POST /etps/{id}/alternatives` (RN-ETP-18). ESTRITO: `decision` (sempre
 * `UNDER_ANALYSIS` na criação), `decisionJustification` e `sortOrder` não entram (422 `NOT_ALLOWED`).
 */
export const createEtpAlternativeSchema = z
  .strictObject({
    name: nameSchema,
    description: descriptionSchema,
    advantages: optionalRichText,
    disadvantages: optionalRichText,
    estimatedCost: estimatedCostSchema,
    riskLevel: riskLevelSchema,
    observations: observationsSchema,
  })
  .meta({ id: 'EtpAlternativeCreateRequest' });
export type CreateEtpAlternative = z.input<typeof createEtpAlternativeSchema>;
export type CreateEtpAlternativeParsed = z.output<typeof createEtpAlternativeSchema>;

/**
 * ETP-07 — corpo de `PATCH /etp-alternatives/{alternativeId}` (`If-Match`): os campos do ETP-06
 * (parciais) + `sortOrder` (reordenação por arrastar-e-soltar). A decisão só muda pelo ETP-09.
 */
export const updateEtpAlternativeSchema = z
  .strictObject({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    advantages: optionalRichText,
    disadvantages: optionalRichText,
    estimatedCost: estimatedCostSchema,
    riskLevel: riskLevelSchema,
    observations: observationsSchema,
    sortOrder: z
      .int({ error: ETP_ALTERNATIVE_MESSAGES.sortOrderInvalid })
      .min(0, { error: ETP_ALTERNATIVE_MESSAGES.sortOrderInvalid })
      .max(ETP_ALTERNATIVE_LIMITS.sortOrderMax, {
        error: ETP_ALTERNATIVE_MESSAGES.sortOrderInvalid,
      })
      .optional(),
  })
  .meta({ id: 'EtpAlternativeUpdateRequest' });
export type UpdateEtpAlternative = z.input<typeof updateEtpAlternativeSchema>;
export type UpdateEtpAlternativeParsed = z.output<typeof updateEtpAlternativeSchema>;

/**
 * ETP-09 — corpo de `POST /etp-alternatives/{alternativeId}/decide` (`If-Match`). V-04: para
 * `RECOMMENDED`/`DISCARDED`, `decisionJustification` ≥ 20 caracteres (`CONDITIONAL_REQUIRED`/
 * `TOO_SHORT`). `replaceRecommended: true` só depois do aviso `RECOMMENDED_ALTERNATIVE_EXISTS`.
 */
export const decideEtpAlternativeSchema = z
  .strictObject({
    decision: z.enum(ALTERNATIVE_DECISIONS, { error: ETP_ALTERNATIVE_MESSAGES.decisionInvalid }),
    decisionJustification: z
      .string()
      .trim()
      .max(ETP_ALTERNATIVE_LIMITS.justificationMax, {
        error: ETP_ALTERNATIVE_MESSAGES.justificationLength,
      })
      .transform((value) => (value === '' ? null : value))
      .nullish(),
    replaceRecommended: z.boolean().optional(),
  })
  .superRefine((body, ctx) => {
    const problem = decisionJustificationProblem(body.decision, body.decisionJustification);
    if (problem !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['decisionJustification'],
        message: ETP_ALTERNATIVE_MESSAGES.justificationRequired,
        params: { code: problem },
      });
    }
  })
  .meta({ id: 'EtpAlternativeDecideRequest' });
export type DecideEtpAlternative = z.input<typeof decideEtpAlternativeSchema>;
export type DecideEtpAlternativeParsed = z.output<typeof decideEtpAlternativeSchema>;

export const etpAlternativeIdParamsSchema = z.strictObject({ alternativeId: uuidV7Schema });
export type EtpAlternativeIdParams = z.infer<typeof etpAlternativeIdParamsSchema>;

// --- Resposta -----------------------------------------------------------------------------------

const richTextResponse = z.looseObject({
  type: z.literal('doc'),
  content: z.array(z.unknown()).optional(),
});

/**
 * `EtpAlternative` (api/06-etp.md ETP-05). POL-09 (RN-ETP-24): sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`
 * nem custódia em processo sigiloso, `estimatedCost = null` e `estimatedCostMasked = true`.
 */
export const etpAlternativeSchema = z
  .object({
    id: z.uuid(),
    etpId: z.uuid(),
    processId: z.uuid(),
    name: z.string(),
    description: richTextResponse,
    advantages: richTextResponse.nullable(),
    disadvantages: richTextResponse.nullable(),
    /** Decimal(18,2) como string; `null` se não informado ou mascarado. */
    estimatedCost: z.string().nullable(),
    estimatedCostMasked: z.boolean(),
    riskLevel: z.enum(RISK_LEVELS).nullable(),
    observations: z.string().nullable(),
    sortOrder: z.int(),
    decision: z.enum(ALTERNATIVE_DECISIONS),
    decisionJustification: z.string().nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    /** O `ETag`/`If-Match` de ETP-07/08/09. */
    version: z.int(),
  })
  .meta({ id: 'EtpAlternative' });
export type EtpAlternativeDto = z.infer<typeof etpAlternativeSchema>;

/** `meta` do ETP-05: se o usuário pode alterar a coleção agora e a recomendada (`Etp`). */
export const etpAlternativeListMetaSchema = z
  .object({
    /** `ETP_UPDATE` + POL-02 e o ETP em `DRAFT`/`RETURNED` (senão a seção abre somente leitura). */
    canManage: z.boolean(),
    recommendedAlternativeId: z.uuid().nullable(),
    /** POL-09: o custo vem mascarado para este usuário (a tela não o exibe nem o envia). */
    estimatedCostMasked: z.boolean(),
  })
  .meta({ id: 'EtpAlternativeListMeta' });
export type EtpAlternativeListMeta = z.infer<typeof etpAlternativeListMetaSchema>;
