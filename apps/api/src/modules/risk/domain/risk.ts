import type { FieldErrorCode } from '@contrataflow/types';
import { assessRisk, isWithinScale, RISK_FIELDS, RISK_MESSAGES } from '@contrataflow/validation';
import type {
  CreateRisk,
  RiskField,
  RiskLevel,
  RiskPhase,
  RiskScaleSnapshot,
  RiskStatus,
  UpdateRisk,
} from '@contrataflow/validation';

/*
 * Agregado `Risk` (US-033 · DEC-021 · RN-RISK-01..08): código sequencial por processo, nunca
 * reaproveitado (RN-RISK-02), avaliação probabilidade × impacto pela escala vigente com o snapshot
 * da escala usada (RN-RISK-03/04), reavaliação (`RiskAssessed`), residual opcional em par (RN-RISK-08)
 * e o diff único que alimenta auditoria e resposta. Puro: sem NestJS, Prisma nem outro módulo.
 */

export interface Risk {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly code: string;
  readonly title: string;
  readonly description: string | null;
  readonly categoryId: string;
  readonly phase: RiskPhase;
  readonly cause: string;
  readonly consequence: string;
  readonly probability: number;
  readonly impact: number;
  readonly score: number;
  readonly level: RiskLevel;
  readonly scaleSnapshot: RiskScaleSnapshot;
  readonly ownerId: string | null;
  readonly ownerDepartmentId: string | null;
  readonly status: RiskStatus;
  readonly residualProbability: number | null;
  readonly residualImpact: number | null;
  readonly residualScore: number | null;
  readonly residualLevel: RiskLevel | null;
  readonly sortOrder: number;
  /** Geração de origem (RSK-11 · US-119); imutável. `null` = registrado por uma pessoa. */
  readonly aiGenerationId: string | null;
  /** Revisão humana do risco gerado por IA (RSK-12 · RN-AI-42). */
  readonly aiReviewedAt: Date | null;
  readonly aiReviewedById: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly deletedAt: Date | null;
  readonly deletedById: string | null;
  readonly version: number;
}

export interface RiskIssue {
  readonly field: string;
  readonly code: FieldErrorCode;
  readonly message: string;
}

const CODE_PATTERN = /^R(\d+)$/;

/** RN-RISK-02: `R` + sequência com 2 dígitos (`R01`…`R99`, depois `R100`). */
export function riskCode(sequence: number): string {
  return `R${String(sequence).padStart(2, '0')}`;
}

/**
 * Próximo código do processo: maior sequência JÁ USADA + 1 — os excluídos contam, então um código
 * nunca é reaproveitado (RN-RISK-02).
 */
export function nextRiskCode(usedCodes: readonly string[]): string {
  const highest = usedCodes.reduce((max, code) => {
    const match = CODE_PATTERN.exec(code);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return riskCode(highest + 1);
}

type Grades = Partial<
  Record<
    'probability' | 'impact' | 'residualProbability' | 'residualImpact',
    number | null | undefined
  >
>;

/** V-03: graus dentro de `[1, risk.scale.max]` do tenant (RN-RISK-03). */
export function gradeIssues(grades: Grades, snapshot: RiskScaleSnapshot): RiskIssue[] {
  const issues: RiskIssue[] = [];
  for (const field of ['probability', 'impact', 'residualProbability', 'residualImpact'] as const) {
    const value = grades[field];
    if (value === undefined || value === null) continue;
    if (!isWithinScale(value, snapshot.scale)) {
      issues.push({
        field,
        code: 'OUT_OF_RANGE',
        message: RISK_MESSAGES.outOfRange(snapshot.scale.max),
      });
    }
  }
  return issues;
}

/** RN-RISK-08 (FA-05): residuais em par — ambos ou nenhum, sobre o estado resultante. */
export function residualIssues(
  state: Pick<Risk, 'residualProbability' | 'residualImpact'>,
): RiskIssue[] {
  if ((state.residualProbability === null) === (state.residualImpact === null)) return [];
  const field = state.residualProbability === null ? 'residualProbability' : 'residualImpact';
  return [{ field, code: 'CONDITIONAL_REQUIRED', message: RISK_MESSAGES.residualPair }];
}

/** Escore e nível residuais pela mesma regra do risco (RN-RISK-08). */
function residualOf(
  probability: number | null,
  impact: number | null,
  snapshot: RiskScaleSnapshot,
): Pick<Risk, 'residualProbability' | 'residualImpact' | 'residualScore' | 'residualLevel'> {
  if (probability === null || impact === null) {
    // Sem par (FA-05): os graus ficam como enviados, sem escore — `residualIssues` recusa.
    return {
      residualProbability: probability,
      residualImpact: impact,
      residualScore: null,
      residualLevel: null,
    };
  }
  const assessed = assessRisk(probability, impact, snapshot.levelThresholds);
  return {
    residualProbability: probability,
    residualImpact: impact,
    residualScore: assessed.score,
    residualLevel: assessed.level,
  };
}

export interface NewRiskContext {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly code: string;
  readonly snapshot: RiskScaleSnapshot;
  readonly now: Date;
  readonly userId: string | null;
}

/** `Risk.create` (RN-RISK-01..07): `status = OPEN`, escore/nível e o snapshot da escala vigente. */
export function createRisk(body: CreateRisk, context: NewRiskContext): Risk {
  const { score, level } = assessRisk(
    body.probability,
    body.impact,
    context.snapshot.levelThresholds,
  );
  return {
    id: context.id,
    tenantId: context.tenantId,
    processId: context.processId,
    code: context.code,
    title: body.title,
    description: body.description ?? null,
    categoryId: body.categoryId,
    phase: body.phase,
    cause: body.cause,
    consequence: body.consequence,
    probability: body.probability,
    impact: body.impact,
    score,
    level,
    scaleSnapshot: context.snapshot,
    ownerId: body.ownerId ?? null,
    ownerDepartmentId: body.ownerDepartmentId ?? null,
    status: 'OPEN',
    residualProbability: null,
    residualImpact: null,
    residualScore: null,
    residualLevel: null,
    sortOrder: 0,
    aiGenerationId: null,
    aiReviewedAt: null,
    aiReviewedById: null,
    createdAt: context.now,
    updatedAt: context.now,
    createdById: context.userId,
    updatedById: context.userId,
    deletedAt: null,
    deletedById: null,
    version: 1,
  };
}

/** Uma reavaliação (probabilidade e/ou impacto alterados — `RiskAssessed` · FA-01). */
export interface RiskReassessment {
  readonly fromScore: number;
  readonly toScore: number;
  readonly fromLevel: RiskLevel;
  readonly toLevel: RiskLevel;
}

export interface PatchedRisk {
  readonly next: Risk;
  /** `null` = probabilidade e impacto inalterados (edição comum — `risk.update`). */
  readonly reassessment: RiskReassessment | null;
}

/** O valor do patch para um campo obrigatório (`undefined` = não enviado — mantém). */
function pick<T>(patched: T | undefined, current: T): T {
  return patched ?? current;
}

/**
 * `Risk.assess` + edição (RSK-04): aplica o patch; com probabilidade ou impacto alterados,
 * recalcula escore/nível pela escala VIGENTE e grava o novo snapshot (RN-RISK-04 · FA-02); os
 * residuais (quando alterados) seguem a mesma regra. Valide `gradeIssues`/`residualIssues` antes.
 */
export function patchRisk(risk: Risk, patch: UpdateRisk, snapshot: RiskScaleSnapshot): PatchedRisk {
  const probability = pick(patch.probability, risk.probability);
  const impact = pick(patch.impact, risk.impact);
  const base: Risk = {
    ...risk,
    title: pick(patch.title, risk.title),
    description: patch.description === undefined ? risk.description : patch.description,
    categoryId: pick(patch.categoryId, risk.categoryId),
    phase: pick(patch.phase, risk.phase),
    cause: pick(patch.cause, risk.cause),
    consequence: pick(patch.consequence, risk.consequence),
    ownerId: patch.ownerId === undefined ? risk.ownerId : patch.ownerId,
    ownerDepartmentId:
      patch.ownerDepartmentId === undefined ? risk.ownerDepartmentId : patch.ownerDepartmentId,
    status: pick(patch.status, risk.status),
  };

  const residualProbability =
    patch.residualProbability === undefined ? risk.residualProbability : patch.residualProbability;
  const residualImpact =
    patch.residualImpact === undefined ? risk.residualImpact : patch.residualImpact;
  const residualChanged =
    residualProbability !== risk.residualProbability || residualImpact !== risk.residualImpact;
  const residual = residualChanged
    ? residualOf(residualProbability, residualImpact, snapshot)
    : {
        residualProbability: risk.residualProbability,
        residualImpact: risk.residualImpact,
        residualScore: risk.residualScore,
        residualLevel: risk.residualLevel,
      };

  if (probability === risk.probability && impact === risk.impact) {
    return { next: { ...base, ...residual }, reassessment: null };
  }
  const assessed = assessRisk(probability, impact, snapshot.levelThresholds);
  return {
    next: {
      ...base,
      ...residual,
      probability,
      impact,
      score: assessed.score,
      level: assessed.level,
      scaleSnapshot: snapshot,
    },
    reassessment: {
      fromScore: risk.score,
      toScore: assessed.score,
      fromLevel: risk.level,
      toLevel: assessed.level,
    },
  };
}

export interface RiskChange {
  readonly field: RiskField;
  readonly old: unknown;
  readonly new: unknown;
}

/** Campos editáveis que mudaram, na ordem canônica (`before = null` = criação). */
export function diffRisk(before: Risk | null, after: Risk): RiskChange[] {
  return RISK_FIELDS.flatMap((field) => {
    const old = before === null ? null : before[field];
    const value = after[field];
    return old === value ? [] : [{ field, old, new: value }];
  });
}

/** Grava autoria e data da alteração (a `version` sobe no repositório — DEC-055). */
export function touchRisk(risk: Risk, now: Date, userId: string | null): Risk {
  return { ...risk, updatedAt: now, updatedById: userId };
}

/**
 * `Risk.startTreatment` (RN-RISK-14 · US-034): o PRIMEIRO tratamento com `status ≠ CANCELED` de um
 * risco `OPEN` o leva a `IN_TREATMENT`; `null` = o risco não muda (outro status ou já havia
 * tratamento ativo). Cancelar/excluir não reverte (FA-04: ajuste manual pelo RSK-04).
 */
export function startTreatment(
  risk: Risk,
  otherTreatments: readonly { readonly status: string }[],
): Risk | null {
  if (risk.status !== 'OPEN') return null;
  if (otherTreatments.some((treatment) => treatment.status !== 'CANCELED')) return null;
  return { ...risk, status: 'IN_TREATMENT' };
}

/** O risco proposto pela IA e escolhido pela pessoa (RSK-11 · RN-AI-39/40), já sem chave da proposta. */
export interface AiRiskProposal {
  readonly title: string;
  readonly description: string;
  readonly categoryId: string;
  readonly phase: RiskPhase;
  readonly cause: string;
  readonly consequence: string;
  readonly probability: number;
  readonly impact: number;
}

/**
 * `Risk.createFromAiProposal` (RN-AI-40): o risco de sempre (código, escore/nível pelas faixas
 * vigentes, snapshot da escala) com a geração de origem e SEM responsável — fica "gerado por IA"
 * até o RSK-12. Valide `gradeIssues` antes (a proposta já foi conferida na geração, mas a escala
 * pode ter mudado depois).
 */
export function createRiskFromAiProposal(
  proposal: AiRiskProposal,
  context: NewRiskContext & { readonly generationId: string },
): Risk {
  const risk = createRisk(
    {
      title: proposal.title,
      description: proposal.description.trim() === '' ? null : proposal.description,
      categoryId: proposal.categoryId,
      phase: proposal.phase,
      cause: proposal.cause,
      consequence: proposal.consequence,
      probability: proposal.probability,
      impact: proposal.impact,
      ownerId: null,
      ownerDepartmentId: null,
    },
    context,
  );
  return { ...risk, aiGenerationId: context.generationId };
}

/**
 * `Risk.markAiReviewed` (RSK-12 · RN-AI-42): grava quem e quando revisou o risco gerado por IA.
 * `null` = nada a fazer (risco sem origem na IA ou já revisado — o RSK-12 é idempotente).
 */
export function markRiskAiReviewed(risk: Risk, userId: string, now: Date): Risk | null {
  if (risk.aiGenerationId === null || risk.aiReviewedAt !== null) return null;
  return {
    ...risk,
    aiReviewedAt: now,
    aiReviewedById: userId,
    updatedAt: now,
    updatedById: userId,
  };
}
