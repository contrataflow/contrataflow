import type { ApprovalApproverStatus } from '@contrataflow/validation';

import { ApprovalNotPendingError } from './approval-decision.js';
import type { ApprovalRecord } from './approval-decision.js';
import { mirrorOf, mirroredLineOf } from './approval-lines.js';
import type { ApprovalApprover } from './approval-lines.js';
import type { ResolvedApprover } from './approval.js';

/*
 * Redirecionar uma linha da aprovação múltipla e retirar a aprovação inteira (US-135 · DEC-193 ·
 * RN-APV-51..60), puro: a linha alvo (APV-06) ou a única linha (APV-05), as checagens do novo
 * aprovador que não dependem de leitura (igual ao atual, segregação por linha com a regra do
 * substituto, pessoa única entre as linhas) e o mecanismo "cancelar e criar" — a linha antiga vira
 * `CANCELED` (`REASSIGNED`) e nasce outra com o mesmo `sequence`, estado, `activatedAt` e `dueAt`.
 * A elegibilidade (vínculo ativo, detentor competente, titular atual) é a resolução da US-051.
 */

const LIVE: ReadonlySet<ApprovalApproverStatus> = new Set(['PENDING', 'WAITING']);

/** A linha pedida não é desta aprovação (404 — nada revela sobre outras aprovações). */
export class ApprovalLineNotFoundError extends Error {
  constructor(readonly approvalApproverId: string) {
    super('Linha da aprovação não encontrada.');
    this.name = 'ApprovalLineNotFoundError';
  }
}

/** RN-APV-51 (V-07): a linha já foi decidida, dispensada ou cancelada. */
export class ApprovalLineNotReassignableError extends Error {
  constructor(readonly line: ApprovalApprover) {
    super(`A linha ${String(line.sequence)} não está pendente (${line.status}).`);
    this.name = 'ApprovalLineNotReassignableError';
  }
}

/** RN-APV-60 (V-08): APV-05 numa aprovação com mais de uma linha. */
export class ApprovalLineRequiredError extends Error {
  constructor(readonly linesCount: number) {
    super(`A aprovação tem ${String(linesCount)} linhas: informe a linha.`);
    this.name = 'ApprovalLineRequiredError';
  }
}

/** RN-APV-53 (V-04): o novo aprovador é autor de documento coberto e não há desvio possível. */
export class ReassignSelfApprovalError extends Error {
  constructor(readonly sequence: number) {
    super(`O novo aprovador da linha ${String(sequence)} é autor de um documento coberto.`);
    this.name = 'ReassignSelfApprovalError';
  }
}

/** RN-APV-53 (V-05): o novo aprovador ocupa ou ocupou outra linha desta aprovação. */
export class ReassignDuplicatedError extends Error {
  constructor(
    readonly sequence: number,
    readonly otherSequence: number,
  ) {
    super(`A mesma pessoa nas linhas ${String(otherSequence)} e ${String(sequence)}.`);
    this.name = 'ReassignDuplicatedError';
  }
}

/** Posições da aprovação (linhas canceladas por redirecionamento não contam — RN-APV-52). */
export function positionsOf(lines: readonly ApprovalApprover[]): number {
  return new Set(lines.map((line) => line.sequence)).size;
}

/**
 * RN-APV-51 (APV-06): a linha `{approverId}` desta aprovação, ainda `PENDING` ou `WAITING`.
 * @throws ApprovalLineNotFoundError · ApprovalLineNotReassignableError
 */
export function reassignableLineOf(
  lines: readonly ApprovalApprover[],
  approvalApproverId: string,
): ApprovalApprover {
  const line = lines.find((candidate) => candidate.id === approvalApproverId);
  if (line === undefined) throw new ApprovalLineNotFoundError(approvalApproverId);
  if (!LIVE.has(line.status)) throw new ApprovalLineNotReassignableError(line);
  return line;
}

/**
 * RN-APV-60 (APV-05): a única linha viva de uma aprovação de uma posição. Mais de uma posição →
 * `ApprovalLineRequiredError`; nenhuma viva → `ApprovalNotPendingError` (a aprovação pendente
 * sempre tem uma).
 */
export function singleLineOf(lines: readonly ApprovalApprover[]): ApprovalApprover {
  const positions = positionsOf(lines);
  if (positions > 1) throw new ApprovalLineRequiredError(positions);
  const live = lines.find((line) => LIVE.has(line.status));
  if (live === undefined) throw new ApprovalNotPendingError('PENDING');
  return live;
}

/**
 * RN-APV-53 (V-03): o novo aprovador é o mesmo registro atual da linha — mesmo usuário (`USER`),
 * perfil (`ROLE`) ou unidade (`DEPARTMENT_HEAD`).
 */
export function isSameLineApprover(line: ApprovalApprover, target: ResolvedApprover): boolean {
  if (line.approverType !== target.approverType) return false;
  switch (target.approverType) {
    case 'USER':
      return line.approverUserId === target.approverUserId;
    case 'ROLE':
      return line.approverRoleId === target.approverRoleId;
    case 'DEPARTMENT_HEAD':
      return line.approverDepartmentId === target.approverDepartmentId;
  }
}

export interface LineSegregationFacts {
  readonly preventSelfApproval: boolean;
  /** Autores dos documentos cobertos (criador do documento e da versão analisada). */
  readonly authorIds: ReadonlySet<string>;
  /** Substituto com vínculo ativo da unidade do alvo `DEPARTMENT_HEAD` (`null` = nenhum). */
  readonly deputyUserId: string | null;
}

/** O novo aprovador depois da segregação (o desvio para o substituto só vai à auditoria). */
export interface GuardedLineTarget extends ResolvedApprover {
  readonly selfApprovalAvoided: boolean;
}

/**
 * RN-APV-53 + RN-APV-20 por linha: com `approval.preventSelfApproval`, `USER` autor → recusa;
 * titular autor → a linha vai para o substituto da unidade (`allowDeputy = false`), e sem
 * substituto elegível (ausente, sem vínculo ativo ou também autor) → recusa. `ROLE` não nomeia
 * ninguém: a segregação vale no voto (POL-03). @throws ReassignSelfApprovalError
 */
export function guardLineTarget(
  sequence: number,
  target: ResolvedApprover,
  facts: LineSegregationFacts,
): GuardedLineTarget {
  const unchanged = { ...target, selfApprovalAvoided: false };
  if (!facts.preventSelfApproval || target.approverType === 'ROLE') return unchanged;
  const person = target.approverUserId;
  if (person === null || !facts.authorIds.has(person)) return unchanged;
  if (target.approverType === 'USER') throw new ReassignSelfApprovalError(sequence);
  const deputy = facts.deputyUserId;
  if (deputy === null || facts.authorIds.has(deputy)) throw new ReassignSelfApprovalError(sequence);
  return { ...target, approverUserId: deputy, allowDeputy: false, selfApprovalAvoided: true };
}

/**
 * RN-APV-53 (`DistinctApproversPolicy` com o histórico — "ninguém aprova duas vezes"): a pessoa
 * que passaria a decidir a linha não ocupa nem ocupou outra posição desta aprovação — como
 * aprovador de linha (inclusive canceladas) ou como quem votou numa linha de perfil. `ROLE` não
 * entra na comparação. @throws ReassignDuplicatedError
 */
export function assertNotInOtherLine(
  lines: readonly ApprovalApprover[],
  sequence: number,
  target: ResolvedApprover,
): void {
  const person = target.approverType === 'ROLE' ? null : target.approverUserId;
  if (person === null) return;
  const other = [...lines]
    .sort((a, b) => a.sequence - b.sequence)
    .find(
      (line) =>
        line.sequence !== sequence &&
        (line.approverUserId === person || line.decidedById === person),
    );
  if (other !== undefined) throw new ReassignDuplicatedError(sequence, other.sequence);
}

export interface LineReassignmentStamp {
  readonly now: Date;
  readonly newId: () => string;
  /** Quem redirecionou (`createdById` da linha nova). */
  readonly userId: string;
}

export interface LineReassignment {
  /** A linha antiga, `CANCELED` com `skippedReason = REASSIGNED` (`version + 1`). */
  readonly canceled: ApprovalApprover;
  /** A linha nova: mesmo `sequence`, estado, `activatedAt` e `dueAt`; `reassignedFromId`. */
  readonly created: ApprovalApprover;
  /** Todas as linhas depois da troca, em ordem de `sequence` (a nova depois da cancelada). */
  readonly linesAfter: readonly ApprovalApprover[];
  /** A aprovação com o espelho atualizado (RN-APV-24) e `version + 1`. */
  readonly approval: ApprovalRecord;
}

/**
 * RN-APV-52 — "cancelar e criar": a linha antiga `CANCELED` (`REASSIGNED`), a nova com o mesmo
 * `sequence`, estado (`PENDING`/`WAITING`), `activatedAt` e `dueAt` (o prazo não recomeça) e
 * `reassignedFromId`; título, prazo, solicitante, política e cobertura da `Approval` ficam
 * (RN-TRAM-70); o espelho da `Approval` segue a linha corrente. `version + 1` na aprovação (o
 * `If-Match` da retirada passa a refletir a troca). Só `PENDING`/`WAITING` (RN-APV-51).
 * @throws ApprovalNotPendingError · ApprovalLineNotReassignableError
 */
export function reassignLine(
  approval: ApprovalRecord,
  lines: readonly ApprovalApprover[],
  line: ApprovalApprover,
  target: ResolvedApprover,
  stamp: LineReassignmentStamp,
): LineReassignment {
  if (approval.status !== 'PENDING') throw new ApprovalNotPendingError(approval.status);
  if (!LIVE.has(line.status)) throw new ApprovalLineNotReassignableError(line);
  const canceled: ApprovalApprover = {
    ...line,
    status: 'CANCELED',
    skippedReason: 'REASSIGNED',
    updatedAt: stamp.now,
    version: line.version + 1,
  };
  const created: ApprovalApprover = {
    id: stamp.newId(),
    approvalId: line.approvalId,
    sequence: line.sequence,
    approverType: target.approverType,
    approverUserId: target.approverUserId,
    approverRoleId: target.approverRoleId,
    approverDepartmentId: target.approverDepartmentId,
    allowDeputy: target.allowDeputy,
    status: line.status,
    activatedAt: line.activatedAt,
    dueAt: line.dueAt,
    decision: null,
    decidedById: null,
    decidedAt: null,
    decisionComment: null,
    decidedAsDeputy: false,
    reassignedFromId: line.id,
    skippedReason: null,
    createdAt: stamp.now,
    updatedAt: stamp.now,
    createdById: stamp.userId,
    version: 1,
  };
  const linesAfter: ApprovalApprover[] = [];
  for (const candidate of lines) {
    if (candidate.id === line.id) linesAfter.push(canceled, created);
    else linesAfter.push(candidate);
  }
  linesAfter.sort((a, b) => a.sequence - b.sequence);
  const mirrored = mirroredLineOf(approval.decisionPolicy ?? 'ANY', linesAfter);
  return {
    canceled,
    created,
    linesAfter,
    approval: {
      ...approval,
      ...(mirrored === null ? {} : mirrorOf(mirrored)),
      updatedAt: stamp.now,
      version: approval.version + 1,
    },
  };
}

/** RN-APV-57 (log `approval.withdrawn` e auditoria): linhas canceladas e votos preservados. */
export function withdrawalTallyOf(lines: readonly ApprovalApprover[]): {
  readonly linesCanceled: number;
  readonly votesKept: number;
  readonly canceledLineIds: readonly string[];
} {
  const live = lines.filter((line) => LIVE.has(line.status));
  return {
    linesCanceled: live.length,
    votesKept: lines.filter((line) => line.decision !== null).length,
    canceledLineIds: live.map((line) => line.id),
  };
}
