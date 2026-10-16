import type {
  ApprovalStatus,
  DocumentStatus,
  ProcessStageStatus,
  ProcessStatus,
  RuleContextV1,
} from '@contrataflow/validation';

/*
 * Runtime do processo para as leituras do painel (US-041 · PRC-08/PRC-09): o agregado `Process`,
 * TODAS as passagens (`ProcessStage`), as decisões das aprovações de etapa, os documentos e as
 * concessões de acesso (`ProcessAccess` — DEC-024), lidos num ÚNICO snapshot: a consulta nunca
 * mistura a etapa de antes com a de depois de uma tramitação concorrente.
 */

export interface ProcessStagePass {
  readonly processStageId: string;
  readonly workflowStageId: string;
  readonly sequence: number;
  readonly status: ProcessStageStatus;
  readonly departmentId: string;
  readonly assigneeId: string | null;
  /** ISO 8601 UTC. */
  readonly enteredAt: string;
  readonly exitedAt: string | null;
}

export interface ProcessStageApproval {
  readonly processStageId: string;
  readonly status: ApprovalStatus;
}

export interface ProcessDocument {
  readonly documentTypeCode: string;
  readonly status: DocumentStatus;
  readonly isComplete: boolean;
  readonly versionNumber: number | null;
  readonly approvedAt: string | null;
}

/** Concessões `ProcessAccess` vigentes (permissions.md §5). */
export interface ProcessAccessGrants {
  /** Unidades com acesso (`REQUESTING`, `CURRENT`, `HISTORICAL` conforme o tenant). */
  readonly departmentIds: readonly string[];
  /** Usuários com acesso (`CREATOR`, `RESPONSIBLE`, `PARTICIPANT`, `APPROVER`). */
  readonly userIds: readonly string[];
}

export interface ProcessRuntime {
  readonly id: string;
  readonly tenantId: string;
  /** Versão PUBLICADA fixada na criação (imutável — RN-WF-33). */
  readonly workflowVersionId: string;
  readonly status: ProcessStatus;
  readonly createdById: string;
  readonly currentDepartmentId: string;
  readonly currentResponsibleId: string | null;
  /** `process.*` do RuleContext v1 (entities.md §5.4). */
  readonly ruleProcess: RuleContextV1['process'];
  readonly passes: readonly ProcessStagePass[];
  readonly approvals: readonly ProcessStageApproval[];
  readonly documents: readonly ProcessDocument[];
  readonly access: ProcessAccessGrants;
}
