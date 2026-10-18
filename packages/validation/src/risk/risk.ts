import { z } from 'zod';

import { riskTreatmentSchema } from './treatment.js';
import { uuidV7Schema } from '../common/identifiers.js';
import { RISK_LEVEL_VALUES } from '../tenancy/settings.js';
import type { RiskLevelThreshold, RiskScaleSetting } from '../tenancy/settings.js';

/*
 * Riscos do processo (US-033 · DEC-021 · entities.md `Risk` · api/08-risks.md RSK-01..05). Os
 * MESMOS schemas validam o `RiskFormDrawer` do SCR-011 e o corpo da API. A faixa de probabilidade e
 * impacto depende da escala do tenant (`risk.scale.max`, 3..5): o schema aceita 1..5 e o domínio da
 * API confere o máximo vigente (V-03 · `OUT_OF_RANGE`). O cálculo de `score`/`level`
 * (`assessRisk`) é a função única usada pela API ao gravar e pela UI ao exibir em tempo real.
 */

/** entities.md §2 — `RiskPhase`. */
export const RISK_PHASES = ['PLANNING', 'SELECTION', 'CONTRACT_MANAGEMENT'] as const;
export type RiskPhase = (typeof RISK_PHASES)[number];

/** entities.md §2 — `RiskLevel`. */
export const RISK_LEVELS = RISK_LEVEL_VALUES;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** entities.md §2 — `RiskStatus` (RN-RISK-07). */
export const RISK_STATUSES = [
  'OPEN',
  'IN_TREATMENT',
  'MITIGATED',
  'MATERIALIZED',
  'CLOSED',
] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];

export const RISK_PHASE_LABELS: Readonly<Record<RiskPhase, string>> = Object.freeze({
  PLANNING: 'Planejamento da contratação',
  SELECTION: 'Seleção do fornecedor',
  CONTRACT_MANAGEMENT: 'Gestão do contrato',
});

export const RISK_LEVEL_LABELS: Readonly<Record<RiskLevel, string>> = Object.freeze({
  LOW: 'Baixo',
  MEDIUM: 'Médio',
  HIGH: 'Alto',
  EXTREME: 'Extremo',
});

export const RISK_STATUS_LABELS: Readonly<Record<RiskStatus, string>> = Object.freeze({
  OPEN: 'Aberto',
  IN_TREATMENT: 'Em tratamento',
  MITIGATED: 'Mitigado',
  MATERIALIZED: 'Materializado',
  CLOSED: 'Encerrado',
});

/** Limites dos campos (US-033 · "Campos" · V-02/V-03). */
export const RISK_LIMITS = Object.freeze({
  titleMin: 3,
  titleMax: 200,
  descriptionMax: 2000,
  causeMin: 10,
  causeMax: 1000,
  consequenceMin: 10,
  consequenceMax: 1000,
  /** Maior `risk.scale.max` aceito (DEC-021); o vigente do tenant é conferido pela API. */
  scaleMax: 5,
});

/** Mensagens da tabela de validações e dos casos de erro da US-033. */
export const RISK_MESSAGES = Object.freeze({
  titleRequired: 'Informe o título.',
  titleLength: 'O título deve ter entre 3 e 200 caracteres.',
  descriptionLength: 'A descrição deve ter no máximo 2.000 caracteres.',
  categoryRequired: 'Informe a categoria.',
  categoryInvalid: 'Selecione uma categoria válida.',
  phaseRequired: 'Informe a fase.',
  causeRequired: 'Informe a causa.',
  causeLength: 'A causa deve ter entre 10 e 1.000 caracteres.',
  consequenceRequired: 'Informe a consequência.',
  consequenceLength: 'A consequência deve ter entre 10 e 1.000 caracteres.',
  probabilityRequired: 'Informe a probabilidade.',
  impactRequired: 'Informe o impacto.',
  outOfRange: (max: number) => `Selecione um valor entre 1 e ${String(max)}.`,
  ownerInvalid: 'Selecione um responsável válido.',
  residualPair: 'Informe a probabilidade e o impacto residuais juntos.',
  statusInvalid: 'Selecione uma situação válida.',
  locked:
    'Os riscos estão bloqueados porque o Mapa de Riscos foi concluído. Reabra o documento para editar.',
  invalidProcessStatus: 'Este processo não permite alterações nos riscos agora.',
  permissionDenied: 'Você não tem permissão para gerenciar riscos deste processo.',
  versionConflict: 'Este risco foi alterado por outra pessoa. Recarregue para ver a versão atual.',
  unavailable: 'Não foi possível salvar o risco agora. Tente novamente em instantes.',
  noOwner: 'Sem responsável',
});

/** Texto obrigatório com limites: ausente/vazio → "Informe …"; fora dos limites → "… entre X e Y". */
function boundedText(min: number, max: number, required: string, length: string) {
  return z
    .string({ error: (issue) => (issue.input === undefined ? required : length) })
    .trim()
    .min(1, { error: required, abort: true })
    .min(min, { error: length })
    .max(max, { error: length });
}

/** Texto opcional: vazio depois do `trim` = não informado (`null`). */
function optionalText(max: number, message: string) {
  return z
    .string()
    .trim()
    .max(max, { error: message })
    .transform((value) => (value === '' ? null : value))
    .nullish();
}

/** Grau 1..5 da grade (o máximo do tenant é conferido pela API — RN-RISK-03). */
function gradeSchema(required: string) {
  return z
    .int({
      error: (issue) =>
        issue.input === undefined ? required : RISK_MESSAGES.outOfRange(RISK_LIMITS.scaleMax),
    })
    .min(1, { error: RISK_MESSAGES.outOfRange(RISK_LIMITS.scaleMax) })
    .max(RISK_LIMITS.scaleMax, { error: RISK_MESSAGES.outOfRange(RISK_LIMITS.scaleMax) });
}

const titleSchema = boundedText(
  RISK_LIMITS.titleMin,
  RISK_LIMITS.titleMax,
  RISK_MESSAGES.titleRequired,
  RISK_MESSAGES.titleLength,
);
const descriptionSchema = optionalText(RISK_LIMITS.descriptionMax, RISK_MESSAGES.descriptionLength);
const causeSchema = boundedText(
  RISK_LIMITS.causeMin,
  RISK_LIMITS.causeMax,
  RISK_MESSAGES.causeRequired,
  RISK_MESSAGES.causeLength,
);
const consequenceSchema = boundedText(
  RISK_LIMITS.consequenceMin,
  RISK_LIMITS.consequenceMax,
  RISK_MESSAGES.consequenceRequired,
  RISK_MESSAGES.consequenceLength,
);
const categorySchema = z.uuid({
  error: (issue) =>
    issue.input === undefined ? RISK_MESSAGES.categoryRequired : RISK_MESSAGES.categoryInvalid,
});
const phaseSchema = z.enum(RISK_PHASES, { error: RISK_MESSAGES.phaseRequired });
const probabilitySchema = gradeSchema(RISK_MESSAGES.probabilityRequired);
const impactSchema = gradeSchema(RISK_MESSAGES.impactRequired);
const ownerSchema = z.uuid({ error: RISK_MESSAGES.ownerInvalid }).nullish();
const statusSchema = z.enum(RISK_STATUSES, { error: RISK_MESSAGES.statusInvalid });

/**
 * RSK-02 — corpo de `POST /processes/{id}/risks` (RN-RISK-01/06). ESTRITO: `code`, `score`,
 * `level`, `status` e os residuais não entram na criação (422 `NOT_ALLOWED` — RN-RISK-07).
 */
export const createRiskSchema = z
  .strictObject({
    title: titleSchema,
    description: descriptionSchema,
    categoryId: categorySchema,
    phase: phaseSchema,
    cause: causeSchema,
    consequence: consequenceSchema,
    probability: probabilitySchema,
    impact: impactSchema,
    ownerId: ownerSchema,
    ownerDepartmentId: ownerSchema,
  })
  .meta({ id: 'CreateRiskRequest' });
export type CreateRisk = z.output<typeof createRiskSchema>;
export type CreateRiskInput = z.input<typeof createRiskSchema>;

/**
 * RSK-04 — corpo de `PATCH /risks/{id}`: subconjunto ESTRITO dos campos de RSK-02, mais os
 * residuais (RN-RISK-08; `null` limpa) e o ajuste manual de `status` (RN-RISK-07).
 */
export const updateRiskSchema = z
  .strictObject({
    title: titleSchema.optional(),
    description: descriptionSchema,
    categoryId: categorySchema.optional(),
    phase: phaseSchema.optional(),
    cause: causeSchema.optional(),
    consequence: consequenceSchema.optional(),
    probability: probabilitySchema.optional(),
    impact: impactSchema.optional(),
    ownerId: ownerSchema,
    ownerDepartmentId: ownerSchema,
    residualProbability: gradeSchema(RISK_MESSAGES.residualPair).nullish(),
    residualImpact: gradeSchema(RISK_MESSAGES.residualPair).nullish(),
    status: statusSchema.optional(),
  })
  .meta({ id: 'UpdateRiskRequest' });
export type UpdateRisk = z.output<typeof updateRiskSchema>;
export type UpdateRiskInput = z.input<typeof updateRiskSchema>;

/** Campos editáveis, na ordem canônica do diff e da auditoria. */
export const RISK_FIELDS = [
  'title',
  'description',
  'categoryId',
  'phase',
  'cause',
  'consequence',
  'probability',
  'impact',
  'ownerId',
  'ownerDepartmentId',
  'residualProbability',
  'residualImpact',
  'status',
] as const;
export type RiskField = (typeof RISK_FIELDS)[number];

export const riskIdParamsSchema = z.strictObject({ id: uuidV7Schema });

/** RSK-01 — filtros (api.md §1.2). */
export const riskListQuerySchema = z
  .strictObject({
    phase: z.enum(RISK_PHASES).optional(),
    categoryId: z.uuid().optional(),
    status: z.enum(RISK_STATUSES).optional(),
  })
  .meta({ id: 'RiskListQuery' });
export type RiskListQuery = z.output<typeof riskListQuerySchema>;

// --- Cálculo (RN-RISK-03/04/08) -----------------------------------------------------------------

/** Escala e faixas vigentes no cálculo — gravadas em `scaleSnapshot` (RN-RISK-04). */
export interface RiskScaleSnapshot {
  readonly scale: RiskScaleSetting;
  readonly levelThresholds: readonly RiskLevelThreshold[];
}

export interface RiskAssessment {
  readonly score: number;
  readonly level: RiskLevel;
}

/** Grau dentro de `[1, scale.max]` (RN-RISK-03 · V-03). */
export function isWithinScale(value: number, scale: Pick<RiskScaleSetting, 'max'>): boolean {
  return Number.isInteger(value) && value >= 1 && value <= scale.max;
}

/** Faixa em que `minScore ≤ score ≤ maxScore`; `null` se nenhuma cobre o escore. */
export function riskLevelOf(
  score: number,
  thresholds: readonly RiskLevelThreshold[],
): RiskLevel | null {
  return thresholds.find((band) => band.minScore <= score && score <= band.maxScore)?.level ?? null;
}

/**
 * RN-RISK-03: `score = probability × impact` e `level` pela faixa vigente. Faixas configuradas
 * cobrem 1..`maxScore` (contíguas, a partir de 1 — DEC-021); escore acima da última faixa (escala
 * maior que as faixas) fica no nível da última, nunca sem nível.
 */
export function assessRisk(
  probability: number,
  impact: number,
  thresholds: readonly RiskLevelThreshold[],
): RiskAssessment {
  const score = probability * impact;
  const level = riskLevelOf(score, thresholds);
  if (level !== null) return { score, level };
  const last = [...thresholds].sort((a, b) => a.maxScore - b.maxScore).at(-1);
  if (last === undefined) throw new Error('risk.levelThresholds sem faixas.');
  return { score, level: last.level };
}

// --- Respostas ----------------------------------------------------------------------------------

const scaleSnapshotSchema = z.object({
  scale: z.object({
    max: z.int(),
    probabilityLabels: z.array(z.string()),
    impactLabels: z.array(z.string()),
  }),
  levelThresholds: z.array(
    z.object({ level: z.enum(RISK_LEVELS), minScore: z.int(), maxScore: z.int() }),
  ),
});

const namedRef = z.object({ id: z.uuid(), name: z.string() });

/** `Risk` — resposta de RSK-01..04 (api/08-risks.md, esquema de referência + rótulos). */
export const riskSchema = z
  .object({
    id: z.uuid(),
    processId: z.uuid(),
    code: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    categoryId: z.uuid(),
    /** Rótulo do catálogo (exibido mesmo se o item foi inativado depois — RN-TEN-61). */
    category: z.object({ id: z.uuid(), code: z.string(), label: z.string() }),
    phase: z.enum(RISK_PHASES),
    cause: z.string(),
    consequence: z.string(),
    probability: z.int().min(1),
    impact: z.int().min(1),
    score: z.int().min(1),
    level: z.enum(RISK_LEVELS),
    scaleSnapshot: scaleSnapshotSchema,
    ownerId: z.uuid().nullable(),
    owner: namedRef.nullable(),
    ownerDepartmentId: z.uuid().nullable(),
    ownerDepartment: namedRef.nullable(),
    residualProbability: z.int().nullable(),
    residualImpact: z.int().nullable(),
    residualScore: z.int().nullable(),
    residualLevel: z.enum(RISK_LEVELS).nullable(),
    status: z.enum(RISK_STATUSES),
    sortOrder: z.int(),
    /** Tratamentos não excluídos por `sortOrder`, prazo e criação (US-034 · RN-RISK-10). */
    treatments: z.array(riskTreatmentSchema),
    /** `If-Match` de RSK-04/RSK-05. */
    version: z.int().min(1),
  })
  .meta({ id: 'Risk' });
export type RiskDto = z.infer<typeof riskSchema>;

/** Por que os riscos não podem ser alterados agora (FA-04 · RN-RISK-09) — `null` = editáveis. */
export const RISK_LOCK_REASONS = [
  'PERMISSION_DENIED',
  'NOT_CUSTODIAN',
  'INVALID_PROCESS_STATUS',
  'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE',
  'DOCUMENT_NOT_EDITABLE',
] as const;
export type RiskLockReason = (typeof RISK_LOCK_REASONS)[number];

/** `meta` de RSK-01: escala vigente, o `RISK_MAP` do processo e se o usuário pode gerenciar. */
export const riskListMetaSchema = z
  .object({
    scale: scaleSnapshotSchema.shape.scale,
    levelThresholds: scaleSnapshotSchema.shape.levelThresholds,
    riskMap: z.object({ id: z.uuid(), code: z.string().nullable(), status: z.string() }).nullable(),
    canManage: z.boolean(),
    lockReason: z.enum(RISK_LOCK_REASONS).nullable(),
  })
  .meta({ id: 'RiskListMeta' });
export type RiskListMetaDto = z.infer<typeof riskListMetaSchema>;
