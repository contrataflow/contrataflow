import { alternativeNameKey } from '@contrataflow/validation';
import type {
  AlternativeDecision,
  CreateEtpAlternativeParsed,
  RichTextDocValue,
  RiskLevel,
  UpdateEtpAlternativeParsed,
} from '@contrataflow/validation';

import type { Etp } from './etp.js';

/*
 * Alternativa de solução do ETP (US-021 · entities.md `EtpAlternative` · RN-ETP-18..22): funções
 * puras de criação, edição, decisão e exclusão. A unicidade do nome (RN-ETP-18) e a da recomendada
 * (RN-ETP-20) são conferidas aqui sobre as irmãs lidas com o documento ETP travado; os índices únicos
 * parciais do banco são a última barreira na corrida.
 */

export interface EtpAlternative {
  readonly id: string;
  readonly tenantId: string;
  readonly etpId: string;
  /** Desnormalizado do ETP (RN-ETP-18). */
  readonly processId: string;
  readonly name: string;
  readonly description: RichTextDocValue;
  readonly advantages: RichTextDocValue | null;
  readonly disadvantages: RichTextDocValue | null;
  /** Decimal(18,2) como string (POL-09 na serialização). */
  readonly estimatedCost: string | null;
  readonly riskLevel: RiskLevel | null;
  readonly observations: string | null;
  readonly decision: AlternativeDecision;
  readonly decisionJustification: string | null;
  readonly sortOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly version: number;
}

/** Campos editáveis pelo ETP-07 (a decisão só muda pelo ETP-09). */
export const EDITABLE_FIELDS = [
  'name',
  'description',
  'advantages',
  'disadvantages',
  'estimatedCost',
  'riskLevel',
  'observations',
  'sortOrder',
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export interface AlternativeChange {
  readonly field: EditableField | 'decision' | 'decisionJustification';
  readonly old: unknown;
  readonly new: unknown;
}

/** Custo como o `Decimal(18,2)` do banco devolve (`"15000"` → `"15000.00"`). */
export function money(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const [integer = '0', fraction = ''] = value.split('.');
  return `${integer}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

/** RN-ETP-18/19: nasce `UNDER_ANALYSIS`, sem justificativa, na posição pedida (fim da lista). */
export function createEtpAlternative(
  body: CreateEtpAlternativeParsed,
  context: {
    readonly id: string;
    readonly etp: Pick<Etp, 'id' | 'tenantId' | 'processId'>;
    readonly sortOrder: number;
    readonly now: Date;
    readonly userId: string | null;
  },
): EtpAlternative {
  return {
    id: context.id,
    tenantId: context.etp.tenantId,
    etpId: context.etp.id,
    processId: context.etp.processId,
    name: body.name,
    description: body.description,
    advantages: body.advantages ?? null,
    disadvantages: body.disadvantages ?? null,
    estimatedCost: money(body.estimatedCost),
    riskLevel: body.riskLevel ?? null,
    observations: body.observations ?? null,
    decision: 'UNDER_ANALYSIS',
    decisionJustification: null,
    sortOrder: context.sortOrder,
    createdAt: context.now,
    updatedAt: context.now,
    createdById: context.userId,
    updatedById: context.userId,
    version: 1,
  };
}

/** Os campos informados no patch (`undefined` = mantém; `null` limpa os opcionais). */
export function patchEtpAlternative(
  current: EtpAlternative,
  patch: UpdateEtpAlternativeParsed,
): EtpAlternative {
  const pick = (key: keyof UpdateEtpAlternativeParsed) => patch[key] !== undefined;
  return {
    ...current,
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.description === undefined ? {} : { description: patch.description }),
    ...(pick('advantages') ? { advantages: patch.advantages ?? null } : {}),
    ...(pick('disadvantages') ? { disadvantages: patch.disadvantages ?? null } : {}),
    ...(pick('estimatedCost') ? { estimatedCost: money(patch.estimatedCost) } : {}),
    ...(pick('riskLevel') ? { riskLevel: patch.riskLevel ?? null } : {}),
    ...(pick('observations') ? { observations: patch.observations ?? null } : {}),
    ...(patch.sortOrder === undefined ? {} : { sortOrder: patch.sortOrder }),
  };
}

/** Centavos de um `Decimal(18,2)` em string (`"10"` = `"10.00"`), sem ponto flutuante. */
function cents(value: string): bigint {
  const [integer = '0', fraction = ''] = value.split('.');
  return BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
}

/** Igualdade de valores de campo (rich text por estrutura; custo por valor decimal). */
function same(field: EditableField, a: unknown, b: unknown): boolean {
  if (field === 'estimatedCost' && typeof a === 'string' && typeof b === 'string') {
    return cents(a) === cents(b);
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** O que mudou entre a alternativa gravada e a editada (vazio = nada a gravar). */
export function diffEtpAlternative(
  before: EtpAlternative,
  after: EtpAlternative,
): AlternativeChange[] {
  return EDITABLE_FIELDS.filter((field) => !same(field, before[field], after[field])).map(
    (field) => ({ field, old: before[field], new: after[field] }),
  );
}

/** Marca a gravação: autor, momento (a versão sobe no repositório, condicionada ao `If-Match`). */
export function touchEtpAlternative(
  alternative: EtpAlternative,
  now: Date,
  userId: string | null,
): EtpAlternative {
  return { ...alternative, updatedAt: now, updatedById: userId };
}

/** V-03 (RN-ETP-18): outra alternativa não excluída do ETP com o mesmo nome, sem diferenciar caixa. */
export function isNameTaken(
  siblings: readonly Pick<EtpAlternative, 'id' | 'name'>[],
  name: string,
  exceptId: string | null = null,
): boolean {
  const key = alternativeNameKey(name);
  return siblings.some(
    (sibling) => sibling.id !== exceptId && alternativeNameKey(sibling.name) === key,
  );
}

export interface DecisionInput {
  readonly decision: AlternativeDecision;
  readonly decisionJustification: string | null;
  readonly replaceRecommended: boolean;
}

export type DecisionPlan =
  | {
      readonly ok: false;
      /** V-05 (RN-ETP-20): já existe outra recomendada e não veio `replaceRecommended: true`. */
      readonly reason: 'RECOMMENDED_EXISTS';
      readonly recommendedAlternativeId: string;
    }
  | {
      readonly ok: true;
      /** A alternativa com a decisão aplicada (sem `touch`). */
      readonly next: EtpAlternative;
      /** FA-01: a antes recomendada, de volta a `UNDER_ANALYSIS` (gravada ANTES da nova). */
      readonly demoted: EtpAlternative | null;
      /** RN-ETP-21: novo `Etp.recommendedAlternativeId` (`undefined` = não muda). */
      readonly recommendedAlternativeId: string | null | undefined;
      /** `EtpAlternativeRecommended` a publicar (só na recomendação nova). */
      readonly recommended: { readonly previousAlternativeId: string | null } | null;
      readonly changes: readonly AlternativeChange[];
    };

/**
 * ETP-09 (RN-ETP-19..21): aplica a decisão. Recomendar com outra já recomendada exige
 * `replaceRecommended` (a outra volta a `UNDER_ANALYSIS`, com a justificativa preservada como
 * histórico). Sair de `RECOMMENDED` limpa `Etp.recommendedAlternativeId`. Repetir a mesma decisão
 * com a mesma justificativa não muda nada (`changes` vazio).
 */
export function planDecision(
  target: EtpAlternative,
  siblings: readonly EtpAlternative[],
  input: DecisionInput,
): DecisionPlan {
  const other =
    input.decision === 'RECOMMENDED'
      ? (siblings.find(
          (sibling) => sibling.id !== target.id && sibling.decision === 'RECOMMENDED',
        ) ?? null)
      : null;
  if (other !== null && !input.replaceRecommended) {
    return { ok: false, reason: 'RECOMMENDED_EXISTS', recommendedAlternativeId: other.id };
  }
  const next: EtpAlternative = {
    ...target,
    decision: input.decision,
    decisionJustification: input.decisionJustification,
  };
  const changes: AlternativeChange[] = [];
  if (target.decision !== next.decision) {
    changes.push({ field: 'decision', old: target.decision, new: next.decision });
  }
  if (target.decisionJustification !== next.decisionJustification) {
    changes.push({
      field: 'decisionJustification',
      old: target.decisionJustification,
      new: next.decisionJustification,
    });
  }
  const newlyRecommended = input.decision === 'RECOMMENDED' && target.decision !== 'RECOMMENDED';
  const leftRecommended = target.decision === 'RECOMMENDED' && input.decision !== 'RECOMMENDED';
  return {
    ok: true,
    next,
    demoted: other === null ? null : { ...other, decision: 'UNDER_ANALYSIS' },
    recommendedAlternativeId: newlyRecommended ? target.id : leftRecommended ? null : undefined,
    recommended: newlyRecommended ? { previousAlternativeId: other?.id ?? null } : null,
    changes,
  };
}

/**
 * RN-ETP-22 (V-06 · FA-03): a alternativa `RECOMMENDED` corrente não pode ser excluída — a decisão
 * muda antes (de volta a `UNDER_ANALYSIS` ou outra recomendada).
 */
export function canDeleteEtpAlternative(alternative: Pick<EtpAlternative, 'decision'>): boolean {
  return alternative.decision !== 'RECOMMENDED';
}

/** RN-ETP-21: o cabeçalho do ETP com a nova recomendada (a versão do ETP sobe). */
export function setRecommendedAlternative(
  etp: Etp,
  alternativeId: string | null,
  change: { readonly at: Date; readonly userId: string | null },
): Etp {
  return {
    ...etp,
    recommendedAlternativeId: alternativeId,
    updatedAt: change.at,
    updatedById: change.userId,
    version: etp.version + 1,
  };
}
