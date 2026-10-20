import type { FieldErrorCode } from '@contrataflow/types';
import type {
  AcknowledgedWarning,
  ChecklistViolation,
  DocumentStatus,
  MovementDocumentRef,
  ProcessStatus,
  StageDepartmentResolution,
  StageType,
} from '@contrataflow/validation';

/*
 * Regras do encaminhamento (US-047 · PRC-19 · RN-TRAM-01..22) sobre fatos já carregados: status
 * permitidos, regras de workflow (bloqueios e avisos reconhecidos — DEC-016), unidade e
 * responsável de destino, documentos que acompanham a tramitação e o status do processo na nova
 * etapa (DEC-013). Puro: leituras, autorização e gravações são do `ForwardProcessCommand`.
 */

/** RN-TRAM-02 (POL-01): status em que o processo pode ser encaminhado. */
const FORWARDABLE: ReadonlySet<ProcessStatus> = new Set(['DRAFT', 'IN_PROGRESS', 'RETURNED']);

export function canForwardInStatus(status: ProcessStatus): boolean {
  return FORWARDABLE.has(status);
}

const STATUS_NAMES: Readonly<Record<ProcessStatus, string>> = {
  DRAFT: 'em rascunho',
  IN_PROGRESS: 'em andamento',
  AWAITING_APPROVAL: 'aguardando aprovação',
  RETURNED: 'devolvido',
  SUSPENDED: 'suspenso',
  CANCELED: 'cancelado',
  COMPLETED: 'concluído',
  PUBLISHED: 'publicado',
};

/** "Casos de erro": "O processo está {status} e não pode ser encaminhado." */
export function notForwardableMessage(status: ProcessStatus): string {
  return `O processo está ${STATUS_NAMES[status]} e não pode ser encaminhado.`;
}

/** RN-TRAM-13 (DEC-013): destino `APPROVAL` → `AWAITING_APPROVAL`; `START`/`TASK` → `IN_PROGRESS`. */
export function statusOnEntering(stageType: StageType): ProcessStatus {
  return stageType === 'APPROVAL' ? 'AWAITING_APPROVAL' : 'IN_PROGRESS';
}

/** RN-TRAM-05: regras `BLOCKING` não satisfeitas (impedem o encaminhamento). */
export function blockingViolations(
  violations: readonly ChecklistViolation[],
): ChecklistViolation[] {
  return violations.filter((violation) => violation.severity === 'BLOCKING');
}

/** RN-TRAM-06: avisos não satisfeitos que NÃO constam em `acknowledgedWarnings` (ids extras: ignorados). */
export function unacknowledgedWarnings(
  violations: readonly ChecklistViolation[],
  acknowledged: readonly string[],
): ChecklistViolation[] {
  const known = new Set(acknowledged);
  return violations.filter(
    (violation) => violation.severity === 'WARNING' && !known.has(violation.ruleId),
  );
}

/** RN-TRAM-06 · DEC-016: avisos reconhecidos registrados com id e mensagem da regra. */
export function acknowledgedWarningsOf(
  violations: readonly ChecklistViolation[],
  acknowledged: readonly string[],
): AcknowledgedWarning[] {
  const known = new Set(acknowledged);
  return violations
    .filter((violation) => violation.severity === 'WARNING' && known.has(violation.ruleId))
    .map((violation) => ({ ruleId: violation.ruleId, message: violation.message }));
}

/** Unidade de destino segundo a `departmentResolution` da etapa (RN-TRAM-07). */
export type DestinationDecision =
  | { readonly kind: 'RESOLVED'; readonly departmentId: string }
  /** `CHOSEN_ON_FORWARD` sem `toDepartmentId` → 422 `DEPARTMENT_REQUIRED`. */
  | { readonly kind: 'REQUIRED' }
  /** Resolução da configuração ausente (`FIXED` sem unidade) → `TRANSITION_NOT_AVAILABLE`. */
  | { readonly kind: 'UNRESOLVED' }
  /** `toDepartmentId` diferente do resolvido pela configuração → `VALIDATION_ERROR`/`NOT_ALLOWED`. */
  | { readonly kind: 'MISMATCH' };

export function destinationDecision(
  mode: StageDepartmentResolution,
  resolvedDepartmentId: string | null,
  chosenDepartmentId: string | null,
): DestinationDecision {
  if (mode === 'CHOSEN_ON_FORWARD') {
    return chosenDepartmentId === null
      ? { kind: 'REQUIRED' }
      : { kind: 'RESOLVED', departmentId: chosenDepartmentId };
  }
  if (resolvedDepartmentId === null) return { kind: 'UNRESOLVED' };
  if (chosenDepartmentId !== null && chosenDepartmentId !== resolvedDepartmentId) {
    return { kind: 'MISMATCH' };
  }
  return { kind: 'RESOLVED', departmentId: resolvedDepartmentId };
}

/** A unidade escolhida como a validação a vê (`null` = inexistente no tenant — RLS). */
export interface DepartmentFact {
  readonly organizationId: string;
  readonly isActive: boolean;
}

/**
 * V-11 (RN-TRAM-07): a unidade escolhida existe no tenant, é do órgão do processo (outro órgão =
 * `REFERENCE_NOT_FOUND`, sem revelar) e está ativa. `null` = válida.
 */
export function chosenDepartmentIssue(
  department: DepartmentFact | null,
  organizationId: string,
): Extract<FieldErrorCode, 'REFERENCE_NOT_FOUND' | 'REFERENCE_INACTIVE'> | null {
  if (department?.organizationId !== organizationId) return 'REFERENCE_NOT_FOUND';
  return department.isActive ? null : 'REFERENCE_INACTIVE';
}

/** O candidato a responsável como a elegibilidade o vê (RN-TRAM-08). */
export interface AssigneeFacts {
  readonly membershipStatus: string;
  readonly membershipExpiresAt: Date | null;
  /** Lotado na unidade de destino. */
  readonly assignedToDepartment: boolean;
  /** Tem `PROCESS_VIEW` em algum escopo vigente. */
  readonly canViewProcesses: boolean;
}

/**
 * RN-TRAM-08: vínculo `ACTIVE` não vencido, lotação na unidade de destino e `PROCESS_VIEW`.
 * `null` = sem vínculo no tenant (outro tenant = inexistente).
 */
export function isEligibleAssignee(facts: AssigneeFacts | null, now: Date): boolean {
  if (facts?.membershipStatus !== 'ACTIVE') return false;
  if (facts.membershipExpiresAt !== null && facts.membershipExpiresAt.getTime() <= now.getTime()) {
    return false;
  }
  return facts.assignedToDepartment && facts.canViewProcesses;
}

/** Documento do processo como o encaminhamento o lê (antes ou depois dos efeitos). */
export interface ForwardDocumentFact {
  readonly id: string;
  readonly typeCode: string;
  readonly code: string | null;
  readonly title: string;
  readonly status: DocumentStatus;
  readonly currentVersionId: string | null;
  readonly currentVersionNumber: number | null;
  readonly updatedAt: Date;
}

/**
 * RN-TRAM-12: sem `documentIds`, seguem os documentos criados ou alterados DURANTE a passagem
 * atual (rascunho salvo ou versão criada depois de `enteredAt`), exceto os cancelados.
 */
export function changedDuringPass(
  documents: readonly ForwardDocumentFact[],
  enteredAt: Date,
): string[] {
  return documents
    .filter((document) => document.status !== 'CANCELED')
    .filter((document) => document.updatedAt.getTime() > enteredAt.getTime())
    .map((document) => document.id);
}

/** V-04: ids de `documentIds` que não são documentos (não excluídos) do processo. */
export function unknownDocumentIndexes(
  documentIds: readonly string[],
  documents: readonly ForwardDocumentFact[],
): number[] {
  const known = new Set(documents.map((document) => document.id));
  return documentIds.flatMap((id, index) => (known.has(id) ? [] : [index]));
}

/** RN-TRAM-12: escolhidos + cobertos (destino `APPROVAL`), sem repetição, na ordem de escolha. */
export function movementDocumentIds(
  chosen: readonly string[],
  covered: readonly string[],
): string[] {
  return [...new Set([...chosen, ...covered])];
}

/** `MovementDocumentRef` (entities.md §5.6) com status e versão APÓS os efeitos do encaminhamento. */
export function movementDocumentRefs(
  ids: readonly string[],
  documents: readonly ForwardDocumentFact[],
): MovementDocumentRef[] {
  const byId = new Map(documents.map((document) => [document.id, document]));
  return ids.flatMap((id) => {
    const document = byId.get(id);
    if (document === undefined) return [];
    return [
      {
        documentId: document.id,
        documentVersionId: document.currentVersionId,
        versionNumber: document.currentVersionNumber,
        code: document.code,
        title: document.title,
        documentTypeCode: document.typeCode,
        status: document.status,
      },
    ];
  });
}

/** Documentos cobertos pela etapa `APPROVAL` (RN-TRAM-44): dos tipos da etapa, não cancelados. */
export function coveredDocuments(
  documents: readonly ForwardDocumentFact[],
  approvalDocumentTypeCodes: readonly string[],
): ForwardDocumentFact[] {
  const codes = new Set(approvalDocumentTypeCodes);
  return documents.filter(
    (document) => codes.has(document.typeCode) && document.status !== 'CANCELED',
  );
}
