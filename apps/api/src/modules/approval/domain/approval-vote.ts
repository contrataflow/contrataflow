import type {
  ApprovalApproverStatus,
  ApprovalDecision,
  ApprovalDecisionBlocker,
  ApprovalDecisionOutcome,
  ApprovalDecisionPolicy,
  ApprovalSkippedReason,
  ProcessStatus,
} from '@contrataflow/validation';

import {
  STATUS_OF_DECISION,
  designationOf,
  isDecidableProcessStatus,
} from './approval-decision.js';
import type { ApprovalRecord, ApproverUnit, Designation } from './approval-decision.js';
import { mirrorOf } from './approval-lines.js';
import type { ApprovalApprover } from './approval-lines.js';

/*
 * Decisão por linha da aprovação múltipla (US-134 · DEC-193 · RN-APV-33..50), puro: quem cobre cada
 * linha (`USER`, titular/substituto de `DEPARTMENT_HEAD`, detentor do perfil `ROLE`), a escolha da
 * linha do voto na ordem das verificações de RN-APV-40, a `DecisionPolicyStrategy` (`ANY`, `ALL`,
 * `SEQUENTIAL`) que diz se o voto mantém a aprovação aberta, passa a vez ou a encerra, e as
 * invariantes de RN-APV-50 (teste de propriedade). Os efeitos do MVP 1 (US-052) só acontecem no
 * encerramento e são do coordenador (`DecideApprovalCommand`).
 */

const NOT_DESIGNATED: Designation = { designated: false, asDeputy: false };

/** O que a designação por linha leu no `tx` (POL-03 por linha). */
export interface LineDesignationFacts {
  readonly userId: string;
  /** `ROLE`: detentores competentes por perfil, no escopo da unidade solicitante (RN-TRAM-47). */
  readonly roleHolders: ReadonlyMap<string, readonly string[]>;
  /** `DEPARTMENT_HEAD`: titular e substituto ATUAIS por unidade (`null` = inexistente). */
  readonly units: ReadonlyMap<string, ApproverUnit | null>;
}

/**
 * RN-APV-33/44 — designação da pessoa numa linha: `USER` direto; `ROLE` detentor competente;
 * `DEPARTMENT_HEAD` o titular ATUAL da unidade ou, com `allowDeputy`, o substituto (`asDeputy`).
 * Linha desviada pela segregação na solicitação (US-133 · RN-APV-20: `allowDeputy = false` com o
 * substituto gravado em `approverUserId`) é decidida só pela pessoa gravada — em substituição ao
 * titular autor (`asDeputy = true`). Linha `CANCELED` não tem aprovador.
 */
export function lineDesignationOf(
  line: ApprovalApprover,
  facts: LineDesignationFacts,
): Designation {
  if (line.status === 'CANCELED') return NOT_DESIGNATED;
  const { userId } = facts;
  const unit =
    line.approverDepartmentId === null
      ? null
      : (facts.units.get(line.approverDepartmentId) ?? null);
  if (
    line.approverType === 'DEPARTMENT_HEAD' &&
    !line.allowDeputy &&
    line.approverUserId !== null
  ) {
    if (line.approverUserId !== userId) return NOT_DESIGNATED;
    return { designated: true, asDeputy: unit?.headUserId !== userId };
  }
  const roleHolderIds =
    line.approverRoleId === null ? [] : (facts.roleHolders.get(line.approverRoleId) ?? []);
  return designationOf(line, { userId, roleHolderIds, unit });
}

/**
 * Por que quem consulta não pode decidir (APV-02 — SCR-015 oculta as ações e explica), na ordem
 * das checagens do APV-03 (RN-APV-40 · lacuna 4): aprovação encerrada, sem `APPROVAL_DECIDE`, sem
 * linha, já votou, linha `WAITING` (`NOT_DESIGNATED_APPROVER`), linha decidida/dispensada,
 * segregação e processo não decidível. `null` = pode decidir.
 */
export function lineDecisionBlockerOf(input: {
  readonly status: ApprovalRecord['status'];
  readonly canDecide: boolean;
  readonly line: Pick<ApprovalApprover, 'status'> | null;
  readonly alreadyVoted: boolean;
  readonly selfApproval: boolean;
  readonly processStatus: ProcessStatus;
}): ApprovalDecisionBlocker | null {
  if (input.status !== 'PENDING') return 'NOT_PENDING';
  if (!input.canDecide) return 'PERMISSION_DENIED';
  if (input.line === null) return 'NOT_DESIGNATED_APPROVER';
  if (input.alreadyVoted) return 'ALREADY_VOTED';
  if (input.line.status === 'WAITING') return 'NOT_DESIGNATED_APPROVER';
  if (input.line.status !== 'PENDING') return 'LINE_NOT_PENDING';
  if (input.selfApproval) return 'SELF_APPROVAL_FORBIDDEN';
  if (!isDecidableProcessStatus(input.processStatus)) return 'INVALID_PROCESS_STATUS';
  return null;
}

/** Por que o voto não pode seguir na linha escolhida (RN-APV-33/40). */
export type LineSelectionProblem =
  /** V-03: mais de uma linha `PENDING` cabe à pessoa e ela não disse qual (422). */
  | 'LINE_REQUIRED'
  /** V-04: a linha informada é de outra aprovação ou não cabe à pessoa (403). */
  | 'NOT_LINE_APPROVER'
  /** V-06: a linha já foi decidida, dispensada ou cancelada com a aprovação aberta (409). */
  | 'LINE_NOT_PENDING'
  /** V-07: ainda não é a vez da linha (`SEQUENTIAL` — 403 `NOT_DESIGNATED_APPROVER`). */
  | 'LINE_WAITING';

export class LineSelectionError extends Error {
  constructor(
    readonly problem: LineSelectionProblem,
    readonly line: ApprovalApprover | null,
  ) {
    super(`Linha da aprovação indisponível (${problem}).`);
    this.name = 'LineSelectionError';
  }
}

/** A linha do voto e como a pessoa a decide; `line = null` = nenhuma linha cabe a ela. */
export interface LineSelection {
  readonly line: ApprovalApprover | null;
  readonly designation: Designation;
  /** RN-APV-33: a pessoa já decidiu uma linha desta aprovação (`APPROVER_ALREADY_VOTED`). */
  readonly alreadyVoted: boolean;
}

const bySequence = (a: ApprovalApprover, b: ApprovalApprover) => a.sequence - b.sequence;

/** Linhas que cabem à pessoa (vivas ou já decididas), com a designação de cada uma. */
export function coveredLinesOf(
  lines: readonly ApprovalApprover[],
  facts: LineDesignationFacts,
): { readonly line: ApprovalApprover; readonly designation: Designation }[] {
  return [...lines]
    .sort(bySequence)
    .map((line) => ({ line, designation: lineDesignationOf(line, facts) }))
    .filter((item) => item.designation.designated);
}

const hasVoted = (lines: readonly ApprovalApprover[], userId: string) =>
  lines.some((line) => line.decision !== null && line.decidedById === userId);

/**
 * RN-APV-33/40 — a linha do voto. Com `approvalApproverId`, a linha informada (de outra aprovação
 * ou fora da cobertura → `NOT_LINE_APPROVER`); sem ele, a única `PENDING` que cabe à pessoa (mais
 * de uma → `LINE_REQUIRED`, salvo quem já votou — o 409 diz mais) ou, sem `PENDING`, a primeira
 * coberta (para o 409/403 certo). Depois, na ordem de RN-APV-40: linha decidida, dispensada ou
 * cancelada → `LINE_NOT_PENDING`; `WAITING` → `LINE_WAITING`. Sem linha coberta, `line = null`
 * (o 403 `NOT_DESIGNATED_APPROVER` é de POL-03, depois do `If-Match`).
 * @throws LineSelectionError
 */
export function selectVoteLine(
  lines: readonly ApprovalApprover[],
  facts: LineDesignationFacts,
  requestedLineId: string | null,
): LineSelection {
  const covered = coveredLinesOf(lines, facts);
  const alreadyVoted = hasVoted(lines, facts.userId);
  let chosen: { readonly line: ApprovalApprover; readonly designation: Designation } | undefined;
  if (requestedLineId !== null) {
    chosen = covered.find((item) => item.line.id === requestedLineId);
    if (chosen === undefined) {
      const requested = lines.find((line) => line.id === requestedLineId) ?? null;
      // US-135 (FA-08): a linha da pessoa foi redirecionada (cancelada) antes do voto — 409, não 403.
      if (
        requested?.status === 'CANCELED' &&
        lineDesignationOf({ ...requested, status: 'PENDING' }, facts).designated
      ) {
        throw new LineSelectionError('LINE_NOT_PENDING', requested);
      }
      throw new LineSelectionError('NOT_LINE_APPROVER', requested);
    }
  } else {
    const pending = covered.filter((item) => item.line.status === 'PENDING');
    if (pending.length > 1 && !alreadyVoted) throw new LineSelectionError('LINE_REQUIRED', null);
    chosen =
      pending[0] ??
      covered.find((item) => item.line.status === 'WAITING') ??
      covered.find((item) => item.line.decidedById === facts.userId) ??
      covered[0];
  }
  if (chosen === undefined) return { line: null, designation: NOT_DESIGNATED, alreadyVoted };
  if (chosen.line.status === 'WAITING') throw new LineSelectionError('LINE_WAITING', chosen.line);
  if (chosen.line.status !== 'PENDING') {
    throw new LineSelectionError('LINE_NOT_PENDING', chosen.line);
  }
  return { line: chosen.line, designation: chosen.designation, alreadyVoted };
}

/** RN-APV-41: a versão que o `If-Match` do voto confere — a da aprovação em `ANY`, a da linha. */
export function voteExpectedVersion(
  approval: Pick<ApprovalRecord, 'version' | 'decisionPolicy'>,
  line: Pick<ApprovalApprover, 'version'> | null,
): number {
  const policy = approval.decisionPolicy ?? 'ANY';
  return policy === 'ANY' || line === null ? approval.version : line.version;
}

const LIVE: ReadonlySet<ApprovalApproverStatus> = new Set(['PENDING', 'WAITING']);

/**
 * `DecisionPolicyStrategy` (RN-APV-34..37): o voto encerra a aprovação? `ANY` — sempre; decisão
 * negativa — sempre; `ALL`/`SEQUENTIAL` positivo — só se nenhuma outra linha viva restar.
 */
export function voteClosesApproval(
  policy: ApprovalDecisionPolicy,
  lines: readonly ApprovalApprover[],
  lineId: string,
  decision: ApprovalDecision,
): boolean {
  if (policy === 'ANY' || decision !== 'APPROVE') return true;
  return !lines.some((line) => line.id !== lineId && LIVE.has(line.status));
}

export interface VoteInput {
  readonly lineId: string;
  readonly decision: ApprovalDecision;
  /** RN-TRAM-55: obrigatório (≥ 10) em `RETURN`/`REJECT` — validado no contrato. */
  readonly comment: string | null;
  readonly decidedById: string;
  readonly asDeputy: boolean;
  readonly now: Date;
}

/** Voto registrado numa linha (RN-APV-39 — `votes[]`; nunca o comentário). */
export interface RecordedVote {
  readonly approvalApproverId: string;
  readonly sequence: number;
  readonly decision: ApprovalDecision;
  readonly decidedById: string;
  readonly decidedAsDeputy: boolean;
}

export interface VoteResult {
  readonly outcome: ApprovalDecisionOutcome;
  readonly closes: boolean;
  /** A aprovação depois do voto (`version + 1` sempre — RN-APV-41). */
  readonly approval: ApprovalRecord;
  /** Todas as linhas depois do voto (as que mudaram têm `version + 1`). */
  readonly lines: readonly ApprovalApprover[];
  /** A linha decidida por este voto. */
  readonly decided: ApprovalApprover;
  /** `SEQUENTIAL`: a linha que passou a `PENDING` (`null` sem ativação). */
  readonly activated: ApprovalApprover | null;
  readonly remainingPending: number;
  readonly remainingWaiting: number;
  /** Linhas decididas, em ordem de `sequence` (inclusive a deste voto). */
  readonly votes: readonly RecordedVote[];
}

const LINE_STATUS_OF_DECISION: Readonly<Record<ApprovalDecision, ApprovalApproverStatus>> = {
  APPROVE: 'APPROVED',
  RETURN: 'RETURNED',
  REJECT: 'REJECTED',
};

const CLOSED_OUTCOME_OF: Readonly<Record<ApprovalDecision, ApprovalDecisionOutcome>> = {
  APPROVE: 'APPROVED',
  RETURN: 'RETURNED',
  REJECT: 'REJECTED',
};

/** Aprovação ou linha não está em condições de receber o voto (rede de segurança do domínio). */
export class VoteNotAllowedError extends Error {
  constructor(readonly reason: 'APPROVAL_NOT_PENDING' | 'LINE_NOT_PENDING') {
    super(`Voto recusado (${reason}).`);
    this.name = 'VoteNotAllowedError';
  }
}

/**
 * `Approval.decide(actor, line, decision)` (RN-APV-34..39 · RN-APV-49): grava a decisão na linha
 * (`decidedById`, `decidedAt`, `decidedAsDeputy`, comentário) e aplica a política —
 * - **não encerra** (`ALL` com outras vivas; `SEQUENTIAL` com próxima): a aprovação segue `PENDING`
 *   (`VOTE_RECORDED`); em `SEQUENTIAL` a próxima `WAITING` passa a `PENDING` (`activatedAt = now`) e
 *   as colunas de aprovador da `Approval` espelham a linha corrente (RN-APV-24);
 * - **encerra** (`ANY`, última aprovação, ou decisão negativa): a aprovação recebe a decisão final
 *   da linha que encerrou (e espelha essa linha — RN-APV-39); as vivas restantes ficam `SKIPPED`
 *   (`ANY_DECIDED` em `ANY`, `NEGATIVE_DECISION` em `ALL`/`SEQUENTIAL`); votos anteriores ficam.
 * `Approval.dueAt` nunca muda (RN-APV-49); `version + 1` em todo voto (RN-APV-41).
 * @throws VoteNotAllowedError
 */
export function castVote(
  approval: ApprovalRecord,
  lines: readonly ApprovalApprover[],
  input: VoteInput,
): VoteResult {
  if (approval.status !== 'PENDING') throw new VoteNotAllowedError('APPROVAL_NOT_PENDING');
  const target = lines.find((line) => line.id === input.lineId);
  if (target?.status !== 'PENDING') throw new VoteNotAllowedError('LINE_NOT_PENDING');
  const policy = approval.decisionPolicy ?? 'ANY';
  const { now } = input;
  const touch = (line: ApprovalApprover) => ({ updatedAt: now, version: line.version + 1 });
  const decided: ApprovalApprover = {
    ...target,
    ...touch(target),
    status: LINE_STATUS_OF_DECISION[input.decision],
    decision: input.decision,
    decidedById: input.decidedById,
    decidedAt: now,
    decisionComment: input.comment,
    decidedAsDeputy: input.asDeputy,
  };
  const closes = voteClosesApproval(policy, lines, target.id, input.decision);

  let activated: ApprovalApprover | null = null;
  let after: ApprovalApprover[];
  if (closes) {
    const skippedReason: ApprovalSkippedReason =
      policy === 'ANY' ? 'ANY_DECIDED' : 'NEGATIVE_DECISION';
    after = lines.map((line) => {
      if (line.id === target.id) return decided;
      if (!LIVE.has(line.status)) return line;
      return { ...line, ...touch(line), status: 'SKIPPED', skippedReason };
    });
  } else {
    const next =
      policy === 'SEQUENTIAL'
        ? [...lines]
            .sort(bySequence)
            .find((line) => line.status === 'WAITING' && line.sequence > target.sequence)
        : undefined;
    if (next !== undefined) {
      activated = { ...next, ...touch(next), status: 'PENDING', activatedAt: now };
    }
    after = lines.map((line) => {
      if (line.id === target.id) return decided;
      if (activated !== null && line.id === activated.id) return activated;
      return line;
    });
  }

  const remainingPending = after.filter((line) => line.status === 'PENDING').length;
  const remainingWaiting = after.filter((line) => line.status === 'WAITING').length;
  const outcome: ApprovalDecisionOutcome = closes
    ? CLOSED_OUTCOME_OF[input.decision]
    : 'VOTE_RECORDED';
  const base = { ...approval, updatedAt: now, version: approval.version + 1 };
  const nextApproval: ApprovalRecord = closes
    ? {
        ...base,
        ...mirrorOf(decided),
        status: STATUS_OF_DECISION[input.decision],
        decision: input.decision,
        decidedById: input.decidedById,
        decidedAt: now,
        decisionComment: input.comment,
        decidedAsDeputy: input.asDeputy,
      }
    : activated === null
      ? base
      : { ...base, ...mirrorOf(activated) };

  return {
    outcome,
    closes,
    approval: nextApproval,
    lines: after,
    decided,
    activated,
    remainingPending,
    remainingWaiting,
    votes: votesOf(after),
  };
}

/** RN-APV-39: as linhas decididas, em ordem de `sequence` (só ids e decisão). */
export function votesOf(lines: readonly ApprovalApprover[]): RecordedVote[] {
  return [...lines]
    .sort(bySequence)
    .filter(
      (line): line is ApprovalApprover & { decision: ApprovalDecision; decidedById: string } =>
        line.decision !== null && line.decidedById !== null,
    )
    .map((line) => ({
      approvalApproverId: line.id,
      sequence: line.sequence,
      decision: line.decision,
      decidedById: line.decidedById,
      decidedAsDeputy: line.decidedAsDeputy,
    }));
}

/**
 * RN-APV-50 — invariantes de toda aprovação (verificadas pelo teste de propriedade): (a) nenhuma
 * `PENDING` com todas as linhas decididas; (b) nenhuma linha `APPROVED` depois de uma decisão
 * negativa; (c) uma pessoa com no máximo uma linha decidida; (d) `ALL`/`SEQUENTIAL` `APPROVED` têm
 * todas as linhas (não canceladas) `APPROVED`. Devolve as violadas (vazio = consistente).
 */
export function approvalInvariantViolations(
  approval: Pick<ApprovalRecord, 'status' | 'decisionPolicy'>,
  lines: readonly ApprovalApprover[],
): string[] {
  const problems: string[] = [];
  const counted = lines.filter((line) => line.status !== 'CANCELED');
  if (
    approval.status === 'PENDING' &&
    counted.length > 0 &&
    !counted.some((l) => LIVE.has(l.status))
  ) {
    problems.push('a: PENDING sem linha viva');
  }
  const negative = counted
    .filter((line) => line.decision === 'RETURN' || line.decision === 'REJECT')
    .map((line) => line.decidedAt?.getTime() ?? 0);
  if (negative.length > 0) {
    const firstNegative = Math.min(...negative);
    if (
      counted.some(
        (line) => line.status === 'APPROVED' && (line.decidedAt?.getTime() ?? 0) > firstNegative,
      )
    ) {
      problems.push('b: APPROVED depois de decisão negativa');
    }
  }
  const deciders = counted.flatMap((line) => (line.decidedById === null ? [] : [line.decidedById]));
  if (new Set(deciders).size !== deciders.length) problems.push('c: pessoa com dois votos');
  const policy = approval.decisionPolicy ?? 'ANY';
  if (
    approval.status === 'APPROVED' &&
    policy !== 'ANY' &&
    counted.some((line) => line.status !== 'APPROVED')
  ) {
    problems.push('d: APPROVED sem todas as linhas aprovadas');
  }
  return problems;
}
