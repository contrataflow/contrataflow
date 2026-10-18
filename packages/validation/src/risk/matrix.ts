import { z } from 'zod';

import { RISK_LEVELS, RISK_PHASES, RISK_STATUSES, assessRisk } from './risk.js';
import type { RiskLevel, RiskScaleSnapshot } from './risk.js';
import type { TreatmentStatus } from './treatment.js';
import type { Violation } from '../http/problem.js';

/*
 * Matriz de riscos e Mapa de Riscos (US-035 · RSK-09/RSK-10 · RN-RISK-18..24). A agregação da
 * matriz (`buildRiskMatrix`) é a MESMA na API (RSK-09 e o snapshot da `DocumentVersion` —
 * RN-RISK-20) e na UI; a completude do `RISK_MAP` (`evaluateRiskMapCompleteness`, RN-RISK-21) é a
 * MESMA no DOC-08/09/10 e no painel de pendências do SCR-011.
 */

/** Título padrão do documento (RN-RISK-19 · "Campos"). */
export const RISK_MAP_TITLE = 'Mapa de Riscos';

/** Níveis que exigem ao menos um tratamento ativo para concluir o mapa (RN-RISK-21). */
export const RISK_MAP_TREATMENT_REQUIRED_LEVELS: readonly RiskLevel[] = Object.freeze([
  'HIGH',
  'EXTREME',
]);

/** Mensagens da tabela de validações e dos casos de erro da US-035. */
export const RISK_MAP_MESSAGES = Object.freeze({
  alreadyExists: 'Já existe um Mapa de Riscos para este processo.',
  listEmpty: 'Registre ao menos um risco antes de emitir o Mapa de Riscos.',
  treatmentRequired: (code: string) =>
    `O risco ${code} precisa de ao menos uma ação de tratamento.`,
  notEditable: 'Este Mapa de Riscos não pode mais ser editado.',
  typeNotAllowedInStage: 'O Mapa de Riscos não é aceito nesta etapa do processo.',
  permissionDenied: 'Você não tem permissão para concluir o Mapa de Riscos.',
  createDenied: 'Você não tem permissão para emitir o Mapa de Riscos deste processo.',
  templateInvalid: 'O modelo padrão do Mapa de Riscos não está publicado.',
  unavailable: 'Não foi possível concluir agora. Tente novamente em instantes.',
});

// --- RSK-09 -------------------------------------------------------------------------------------

/** RSK-09 — filtros não persistidos (os mesmos de RSK-01 — api.md §1.2). */
export const riskMatrixQuerySchema = z
  .strictObject({
    phase: z.enum(RISK_PHASES).optional(),
    categoryId: z.uuid().optional(),
    status: z.enum(RISK_STATUSES).optional(),
  })
  .meta({ id: 'RiskMatrixQuery' });
export type RiskMatrixQuery = z.output<typeof riskMatrixQuerySchema>;

const matrixRiskSchema = z.object({ id: z.uuid(), code: z.string(), title: z.string() });

export const riskMatrixCellSchema = z
  .object({
    probability: z.int().min(1),
    impact: z.int().min(1),
    score: z.int().min(1),
    level: z.enum(RISK_LEVELS),
    /** Riscos da célula por código (`R01`, `R02`…). */
    risks: z.array(matrixRiskSchema),
  })
  .meta({ id: 'RiskMatrixCell' });
export type RiskMatrixCellDto = z.infer<typeof riskMatrixCellSchema>;

/** `data` de RSK-09: escala e faixas VIGENTES (RN-RISK-18) e todas as células da grade. */
export const riskMatrixSchema = z
  .object({
    scale: z.object({
      max: z.int(),
      probabilityLabels: z.array(z.string()),
      impactLabels: z.array(z.string()),
    }),
    levelThresholds: z.array(
      z.object({ level: z.enum(RISK_LEVELS), minScore: z.int(), maxScore: z.int() }),
    ),
    /** `scale.max²` células: probabilidade decrescente (maior no topo), impacto crescente. */
    cells: z.array(riskMatrixCellSchema),
  })
  .meta({ id: 'RiskMatrix' });
export type RiskMatrixDto = z.infer<typeof riskMatrixSchema>;

/** O que a matriz lê de cada risco (não excluído) do processo. */
export interface RiskMatrixEntry {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly probability: number;
  readonly impact: number;
}

const byCode = (a: { readonly code: string }, b: { readonly code: string }) =>
  a.code.localeCompare(b.code, 'pt-BR', { numeric: true });

/** Grau dentro da grade vigente: acima do máximo (escala reduzida depois) vai para a borda. */
const clampToScale = (value: number, max: number) => Math.min(Math.max(value, 1), max);

/**
 * RN-RISK-18: agrega os riscos na grade probabilidade × impacto da escala VIGENTE do tenant (não o
 * `scaleSnapshot` de cada risco). Toda célula aparece (vazias com `risks = []`), com `score` e
 * `level` pelas faixas vigentes; risco com grau acima do máximo vigente (escala reduzida depois do
 * registro) fica na borda da grade — a matriz nunca "perde" um risco.
 */
export function buildRiskMatrix(
  risks: readonly RiskMatrixEntry[],
  current: RiskScaleSnapshot,
): RiskMatrixDto {
  const max = current.scale.max;
  const byCell = new Map<string, RiskMatrixEntry[]>();
  const keyOf = (probability: number, impact: number) => `${String(probability)}:${String(impact)}`;
  for (const risk of risks) {
    const key = keyOf(clampToScale(risk.probability, max), clampToScale(risk.impact, max));
    byCell.set(key, [...(byCell.get(key) ?? []), risk]);
  }
  const cells: RiskMatrixCellDto[] = [];
  for (let probability = max; probability >= 1; probability -= 1) {
    for (let impact = 1; impact <= max; impact += 1) {
      const { score, level } = assessRisk(probability, impact, current.levelThresholds);
      cells.push({
        probability,
        impact,
        score,
        level,
        risks: [...(byCell.get(keyOf(probability, impact)) ?? [])]
          .sort(byCode)
          .map((risk) => ({ id: risk.id, code: risk.code, title: risk.title })),
      });
    }
  }
  return {
    scale: {
      max,
      probabilityLabels: [...current.scale.probabilityLabels],
      impactLabels: [...current.scale.impactLabels],
    },
    levelThresholds: current.levelThresholds.map((band) => ({ ...band })),
    cells,
  };
}

// --- RSK-10 -------------------------------------------------------------------------------------

/** RSK-10 — corpo de `POST /processes/{id}/risk-map`: sem campos (usa os riscos vigentes). */
export const riskMapCreateSchema = z.strictObject({}).meta({ id: 'RiskMapCreateRequest' });
export type RiskMapCreate = z.output<typeof riskMapCreateSchema>;

// --- Completude do RISK_MAP (DOC-08 · RN-RISK-21) -----------------------------------------------

/** O que a completude lê de cada risco (não excluído) e dos tratamentos não excluídos dele. */
export interface RiskMapCompletenessEntry {
  readonly id: string;
  readonly code: string;
  readonly level: RiskLevel;
  readonly treatments: readonly { readonly status: TreatmentStatus }[];
}

/**
 * RN-RISK-21: `RISK_LIST_EMPTY` (BLOCKING) sem nenhum risco; `RISK_TREATMENT_REQUIRED_FOR_LEVEL`
 * (BLOCKING, `itemId = riskId`) por risco `HIGH`/`EXTREME` sem tratamento com `status ≠ CANCELED`.
 * Riscos por código.
 */
export function evaluateRiskMapCompleteness(
  risks: readonly RiskMapCompletenessEntry[],
): Violation[] {
  if (risks.length === 0) {
    return [
      {
        code: 'RISK_LIST_EMPTY',
        severity: 'BLOCKING',
        message: RISK_MAP_MESSAGES.listEmpty,
        ruleId: 'RN-RISK-21',
        sectionKey: null,
        field: 'risks',
        itemId: null,
        params: {},
      },
    ];
  }
  return [...risks]
    .sort(byCode)
    .filter(
      (risk) =>
        RISK_MAP_TREATMENT_REQUIRED_LEVELS.includes(risk.level) &&
        !risk.treatments.some((treatment) => treatment.status !== 'CANCELED'),
    )
    .map((risk) => ({
      code: 'RISK_TREATMENT_REQUIRED_FOR_LEVEL',
      severity: 'BLOCKING' as const,
      message: RISK_MAP_MESSAGES.treatmentRequired(risk.code),
      ruleId: 'RN-RISK-21',
      sectionKey: null,
      field: 'treatments',
      itemId: risk.id,
      params: { code: risk.code, level: risk.level },
    }));
}
