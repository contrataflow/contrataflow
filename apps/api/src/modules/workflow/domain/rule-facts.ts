import type {
  ApprovalStatus,
  DocumentStatus,
  ProcessStageStatus,
  RuleContextV1,
} from '@contrataflow/validation';

/*
 * Fatos que o motor de workflow lê (US-041 · DEC-016): o `RuleContext` v1 (o único dado das regras
 * `REQUIRED_FIELD`/`CONDITION`) mais as listas de que os tipos `REQUIRED_DOCUMENT` (`minCount` por
 * documento) e `REQUIRED_APPROVAL` (última passagem pela etapa) precisam. Tudo já carregado pelo
 * chamador: o motor nunca acessa o banco.
 */

/** Um documento do processo (não descartado), qualquer status (DEC-018). */
export interface RuleDocumentFact {
  readonly documentTypeCode: string;
  readonly status: DocumentStatus;
  /** Passa na validação de completude do tipo (`DocumentCompletenessValidator`). */
  readonly isComplete: boolean;
  readonly versionNumber: number | null;
  /** ISO 8601 UTC. */
  readonly approvedAt: string | null;
}

/** Uma passagem do processo por uma etapa (`ProcessStage`). */
export interface StagePassFact {
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

/** Decisão de aprovação de etapa (`Approval.subjectType = PROCESS_STAGE`). */
export interface StageApprovalFact {
  readonly processStageId: string;
  readonly status: ApprovalStatus;
}

export interface RuleFacts {
  readonly context: RuleContextV1;
  readonly documents: readonly RuleDocumentFact[];
  readonly passes: readonly StagePassFact[];
  readonly approvals: readonly StageApprovalFact[];
}

/** Ordem de "avanço" do status do documento: o mais avançado representa o tipo no contexto. */
const STATUS_RANK: Readonly<Record<DocumentStatus, number>> = {
  CANCELED: 0,
  DRAFT: 1,
  REJECTED: 2,
  RETURNED: 3,
  IN_REVIEW: 4,
  FINALIZED: 5,
  APPROVED: 6,
};

/** Status que já passaram pela validação de completude (finalizar/submeter — DEC-018). */
const SUBMITTED: ReadonlySet<DocumentStatus> = new Set(['IN_REVIEW', 'FINALIZED', 'APPROVED']);

/** `documents.<CÓDIGO>` de um tipo sem documento algum. */
export const ABSENT_DOCUMENT: RuleContextV1['documents'][string] = Object.freeze({
  exists: false,
  count: 0,
  status: null,
  isComplete: false,
  versionNumber: null,
  approvedAt: null,
});

/** O documento conta como "completo" (DEC-018: `COMPLETE` = passa na validação de completude). */
export function isDocumentComplete(document: RuleDocumentFact): boolean {
  return document.status !== 'CANCELED' && (document.isComplete || SUBMITTED.has(document.status));
}

/**
 * `documents.<CÓDIGO>` a partir dos documentos do tipo: `exists`/`count` contam os não cancelados;
 * `status` é o do mais avançado; `isComplete` se algum estiver completo; a maior versão e a
 * aprovação mais recente.
 */
export function documentStateOf(
  documents: readonly RuleDocumentFact[],
): RuleContextV1['documents'][string] {
  const active = documents.filter((document) => document.status !== 'CANCELED');
  if (active.length === 0) return ABSENT_DOCUMENT;
  const best = active.reduce((left, right) =>
    STATUS_RANK[right.status] > STATUS_RANK[left.status] ? right : left,
  );
  const versions = active.flatMap((document) =>
    document.versionNumber === null ? [] : [document.versionNumber],
  );
  const approvals = active.flatMap((document) =>
    document.approvedAt === null ? [] : [document.approvedAt],
  );
  return {
    exists: true,
    count: active.length,
    status: best.status,
    isComplete: active.some(isDocumentComplete),
    versionNumber: versions.length > 0 ? Math.max(...versions) : null,
    approvedAt:
      approvals.length > 0
        ? approvals.reduce((left, right) => (right > left ? right : left))
        : null,
  };
}

/** `documents` do RuleContext v1 agrupando os documentos por código de tipo. */
export function documentsSectionOf(
  documents: readonly RuleDocumentFact[],
): RuleContextV1['documents'] {
  const byCode = new Map<string, RuleDocumentFact[]>();
  for (const document of documents) {
    const list = byCode.get(document.documentTypeCode) ?? [];
    list.push(document);
    byCode.set(document.documentTypeCode, list);
  }
  return Object.fromEntries(
    [...byCode.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([code, list]) => [code, documentStateOf(list)]),
  );
}
