import { AI_PROPOSAL_TTL_DAYS } from '@contrataflow/types';
import type {
  AiGenerationErrorCode,
  AiGenerationKind,
  AiGenerationStatus,
  AiSectionAction,
  AiTargetModule,
} from '@contrataflow/types';
import type { AiGenerationOutput, AiInputRef } from '@contrataflow/validation';

/*
 * `AiGeneration` (entities.md §4.11 · DEC-079 · US-115 · RN-AI-01/03/11/12): o registro de cada
 * geração com IA. Funções puras sobre um registro imutável — nada aqui lê banco, relógio ou
 * contexto. O registro nunca é excluído; só o status muda, e só pelas transições abaixo:
 *
 * | De                 | Para                          | Transição                         |
 * |--------------------|-------------------------------|-----------------------------------|
 * | QUEUED / RUNNING   | RUNNING                       | `claimGeneration` (job)           |
 * | RUNNING            | SUCCEEDED / FAILED            | `completeGeneration`/`failGeneration` |
 * | QUEUED / RUNNING   | CANCELED                      | `cancelGeneration` (AI-04, política) |
 * | SUCCEEDED          | APPLIED / DISCARDED / EXPIRED | `markApplied`/`discardGeneration`/`expireGeneration` |
 *
 * Estados finais (`FAILED`, `CANCELED`, `APPLIED`, `DISCARDED`, `EXPIRED`) são imutáveis — exceto
 * `APPLIED` do mapa de riscos, que acumula as partes aplicadas (riscos e seções, cada uma uma vez).
 */

export interface AiGenerationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AppliedTargets {
  readonly sectionKeys: readonly string[];
  readonly riskIds: readonly string[];
}

export interface AiGeneration {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly documentId: string | null;
  readonly targetModule: AiTargetModule;
  readonly kind: AiGenerationKind;
  readonly action: AiSectionAction | null;
  readonly sectionKey: string | null;
  readonly baseRevision: number | null;
  readonly status: AiGenerationStatus;
  /** Conteúdo do pedido: nunca vai para logs, eventos, auditoria nem respostas. */
  readonly needSummary: string | null;
  readonly instruction: string | null;
  readonly provider: string;
  readonly model: string | null;
  readonly promptKey: string;
  readonly promptVersion: string;
  readonly inputRefs: readonly AiInputRef[];
  readonly contextHash: string | null;
  readonly output: AiGenerationOutput | null;
  readonly outputHash: string | null;
  readonly placeholdersCount: number;
  readonly groundingReplacements: number;
  readonly reservedTokens: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  /** Decimal em string (numeric 12,6 — DEC-003); `null` = modelo sem preço (RN-AI-09). */
  readonly costUsd: string | null;
  readonly pricingVersion: string | null;
  readonly latencyMs: number | null;
  readonly attempts: number;
  readonly providerRequestId: string | null;
  readonly errorCode: AiGenerationErrorCode | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly appliedAt: Date | null;
  readonly appliedById: string | null;
  readonly appliedTargets: AppliedTargets | null;
  readonly discardedAt: Date | null;
  readonly discardedById: string | null;
  readonly createdAt: Date;
  readonly createdById: string;
  readonly updatedAt: Date;
}

/** Transição recusada pela máquina de estados (RN-AI-03). */
export class AiGenerationTransitionError extends Error {
  constructor(
    readonly from: AiGenerationStatus,
    readonly to: AiGenerationStatus,
  ) {
    super(`Transição de geração ${from} → ${to} não permitida.`);
    this.name = 'AiGenerationTransitionError';
  }
}

export const ACTIVE_STATUSES: ReadonlySet<AiGenerationStatus> = new Set(['QUEUED', 'RUNNING']);

/** De onde cada transição parte (o repositório usa os mesmos conjuntos no `WHERE`). */
export const TRANSITION_SOURCES = {
  claim: ['QUEUED', 'RUNNING'],
  complete: ['RUNNING'],
  fail: ['QUEUED', 'RUNNING'],
  cancel: ['QUEUED', 'RUNNING'],
  discard: ['SUCCEEDED'],
  expire: ['SUCCEEDED'],
  apply: ['SUCCEEDED'],
} as const satisfies Record<string, readonly AiGenerationStatus[]>;

export function isActive(generation: Pick<AiGeneration, 'status'>): boolean {
  return ACTIVE_STATUSES.has(generation.status);
}

function assertFrom(
  generation: AiGeneration,
  sources: readonly AiGenerationStatus[],
  to: AiGenerationStatus,
): void {
  if (!sources.includes(generation.status)) {
    throw new AiGenerationTransitionError(generation.status, to);
  }
}

export interface NewAiGeneration {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly documentId: string | null;
  readonly targetModule: AiTargetModule;
  readonly kind: AiGenerationKind;
  readonly action: AiSectionAction | null;
  readonly sectionKey: string | null;
  readonly baseRevision: number | null;
  readonly needSummary: string | null;
  readonly instruction: string | null;
  readonly provider: string;
  readonly promptKey: string;
  readonly promptVersion: string;
  readonly reservedTokens: number;
  readonly createdById: string;
  readonly now: Date;
}

/** RN-AI-01: o registro nasce `QUEUED`, antes de qualquer chamada ao provedor. */
export function requestGeneration(input: NewAiGeneration): AiGeneration {
  return {
    id: input.id,
    tenantId: input.tenantId,
    processId: input.processId,
    documentId: input.documentId,
    targetModule: input.targetModule,
    kind: input.kind,
    action: input.action,
    sectionKey: input.sectionKey,
    baseRevision: input.baseRevision,
    status: 'QUEUED',
    needSummary: input.needSummary,
    instruction: input.instruction,
    provider: input.provider,
    model: null,
    promptKey: input.promptKey,
    promptVersion: input.promptVersion,
    inputRefs: [],
    contextHash: null,
    output: null,
    outputHash: null,
    placeholdersCount: 0,
    groundingReplacements: 0,
    reservedTokens: input.reservedTokens,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    costUsd: null,
    pricingVersion: null,
    latencyMs: null,
    attempts: 0,
    providerRequestId: null,
    errorCode: null,
    startedAt: null,
    completedAt: null,
    expiresAt: null,
    appliedAt: null,
    appliedById: null,
    appliedTargets: null,
    discardedAt: null,
    discardedById: null,
    createdAt: input.now,
    createdById: input.createdById,
    updatedAt: input.now,
  };
}

/**
 * Claim do job (RN-AI-03 · queues.md §4.5.1): `QUEUED → RUNNING`; numa retentativa do PRÓPRIO job
 * (`attempt` = tentativas já feitas + 1), `RUNNING → RUNNING`. Outra entrega do mesmo `jobId`
 * (contador incoerente) ou status final → `null`: o job encerra sem chamar o provedor.
 */
export function claimGeneration(
  generation: AiGeneration,
  attempt: number,
  now: Date,
): AiGeneration | null {
  if (!canClaim(generation, attempt)) return null;
  return {
    ...generation,
    status: 'RUNNING',
    startedAt: generation.startedAt ?? now,
    attempts: generation.attempts + 1,
    updatedAt: now,
  };
}

export function canClaim(generation: Pick<AiGeneration, 'status' | 'attempts'>, attempt: number) {
  if (generation.status === 'QUEUED') return true;
  return generation.status === 'RUNNING' && generation.attempts === attempt - 1;
}

export interface CompletedResult {
  readonly model: string;
  readonly inputRefs: readonly AiInputRef[];
  readonly contextHash: string;
  readonly output: AiGenerationOutput;
  readonly outputHash: string;
  readonly placeholdersCount: number;
  readonly groundingReplacements: number;
  readonly usage: AiGenerationUsage;
  readonly costUsd: string | null;
  readonly pricingVersion: string;
  readonly latencyMs: number;
  readonly providerRequestId: string | null;
}

/** `RUNNING → SUCCEEDED` com a proposta, o consumo e `expiresAt` = conclusão + 7 dias (RN-AI-11). */
export function completeGeneration(
  generation: AiGeneration,
  result: CompletedResult,
  now: Date,
): AiGeneration {
  assertFrom(generation, TRANSITION_SOURCES.complete, 'SUCCEEDED');
  return {
    ...generation,
    ...withUsage(generation, result.usage),
    status: 'SUCCEEDED',
    model: result.model,
    inputRefs: result.inputRefs,
    contextHash: result.contextHash,
    output: result.output,
    outputHash: result.outputHash,
    placeholdersCount: result.placeholdersCount,
    groundingReplacements: result.groundingReplacements,
    costUsd: result.costUsd,
    pricingVersion: result.pricingVersion,
    latencyMs: result.latencyMs,
    providerRequestId: result.providerRequestId,
    errorCode: null,
    completedAt: now,
    expiresAt: proposalExpiry(now),
    updatedAt: now,
  };
}

export function proposalExpiry(completedAt: Date): Date {
  return new Date(completedAt.getTime() + AI_PROPOSAL_TTL_DAYS * 24 * 3_600_000);
}

export interface FailedResult {
  readonly errorCode: Exclude<AiGenerationErrorCode, 'CANCELED_BY_POLICY'>;
  readonly usage: AiGenerationUsage;
  readonly model: string | null;
  readonly inputRefs?: readonly AiInputRef[];
  readonly contextHash?: string | null;
  readonly costUsd: string | null;
  readonly pricingVersion: string | null;
  readonly latencyMs: number | null;
}

/** `QUEUED | RUNNING → FAILED` com `errorCode` (obrigatório — check do banco). */
export function failGeneration(
  generation: AiGeneration,
  result: FailedResult,
  now: Date,
): AiGeneration {
  assertFrom(generation, TRANSITION_SOURCES.fail, 'FAILED');
  return {
    ...generation,
    ...withUsage(generation, result.usage),
    status: 'FAILED',
    errorCode: result.errorCode,
    model: result.model ?? generation.model,
    inputRefs: result.inputRefs ?? generation.inputRefs,
    contextHash: result.contextHash ?? generation.contextHash,
    costUsd: result.costUsd,
    pricingVersion: result.pricingVersion,
    latencyMs: result.latencyMs,
    completedAt: now,
    updatedAt: now,
  };
}

/** AI-04 em `QUEUED`/`RUNNING` (FA-02) ou revalidação recusada no job (FA-06). */
export function cancelGeneration(
  generation: AiGeneration,
  options: { readonly byPolicy: boolean; readonly userId: string | null },
  now: Date,
): AiGeneration {
  assertFrom(generation, TRANSITION_SOURCES.cancel, 'CANCELED');
  return {
    ...generation,
    status: 'CANCELED',
    errorCode: options.byPolicy ? 'CANCELED_BY_POLICY' : null,
    discardedAt: options.byPolicy ? null : now,
    discardedById: options.byPolicy ? null : options.userId,
    completedAt: generation.completedAt ?? now,
    updatedAt: now,
  };
}

/** AI-04 em `SUCCEEDED`: a proposta é descartada (o conteúdo fica para rastreabilidade). */
export function discardGeneration(
  generation: AiGeneration,
  userId: string,
  now: Date,
): AiGeneration {
  assertFrom(generation, TRANSITION_SOURCES.discard, 'DISCARDED');
  return {
    ...generation,
    status: 'DISCARDED',
    discardedAt: now,
    discardedById: userId,
    updatedAt: now,
  };
}

/** RN-AI-11: `SUCCEEDED` vencida vira `EXPIRED`, mantendo `output`. */
export function expireGeneration(generation: AiGeneration, now: Date): AiGeneration {
  assertFrom(generation, TRANSITION_SOURCES.expire, 'EXPIRED');
  return { ...generation, status: 'EXPIRED', updatedAt: now };
}

export function isExpired(generation: Pick<AiGeneration, 'expiresAt'>, now: Date): boolean {
  return generation.expiresAt !== null && generation.expiresAt.getTime() <= now.getTime();
}

/** Tokens de uma resposta descartada (cancelamento durante a execução — FA-02) contam no uso. */
export function addUsage(generation: AiGeneration, usage: AiGenerationUsage, now: Date) {
  return { ...generation, ...withUsage(generation, usage), updatedAt: now };
}

function withUsage(generation: AiGeneration, usage: AiGenerationUsage) {
  const inputTokens = (generation.inputTokens ?? 0) + usage.inputTokens;
  const outputTokens = (generation.outputTokens ?? 0) + usage.outputTokens;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

/**
 * Aplicação pelo módulo dono (`AiSuggestionSource.markApplied` — DOC-26/RSK-11): `SUCCEEDED →
 * APPLIED`; no mapa de riscos, uma `APPLIED` ainda aceita a parte que faltava (riscos ou seções).
 * `null` = não aplicável (status, vencida ou parte já aplicada).
 */
export function markApplied(
  generation: AiGeneration,
  input: { readonly userId: string; readonly targets: AppliedTargets },
  now: Date,
): AiGeneration | null {
  if (!canApply(generation, input.targets, now)) return null;
  const previous = generation.appliedTargets ?? { sectionKeys: [], riskIds: [] };
  return {
    ...generation,
    status: 'APPLIED',
    appliedAt: generation.appliedAt ?? now,
    appliedById: generation.appliedById ?? input.userId,
    appliedTargets: {
      sectionKeys: [...previous.sectionKeys, ...input.targets.sectionKeys],
      riskIds: [...previous.riskIds, ...input.targets.riskIds],
    },
    updatedAt: now,
  };
}

export function canApply(generation: AiGeneration, targets: AppliedTargets, now: Date): boolean {
  if (isExpired(generation, now)) return false;
  if (generation.status === 'SUCCEEDED') return true;
  if (generation.status !== 'APPLIED' || generation.targetModule !== 'RISK_MAP') return false;
  const applied = generation.appliedTargets ?? { sectionKeys: [], riskIds: [] };
  // Cada parte do mapa de riscos é aplicada uma vez (entities.md §4.11 `appliedTargets`).
  const sectionsAgain = targets.sectionKeys.length > 0 && applied.sectionKeys.length > 0;
  const risksAgain = targets.riskIds.length > 0 && applied.riskIds.length > 0;
  return !sectionsAgain && !risksAgain;
}
