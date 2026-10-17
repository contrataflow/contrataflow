import type { ApprovalPolicy, ApproverType } from '@contrataflow/validation';

/*
 * `Approval` (entities.md §4.6 · DEC-022). US-065 abre a aprovação avulsa de documento
 * (`subjectType = DOCUMENT`) na submissão; a de etapa, a resolução do titular da unidade e a
 * decisão são da US-051/US-052. Funções puras.
 */

export type ApprovalSubjectType = 'PROCESS_STAGE' | 'DOCUMENT';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'RETURNED' | 'REJECTED' | 'CANCELED';

export interface Approval {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly subjectType: ApprovalSubjectType;
  readonly processStageId: string | null;
  readonly documentId: string | null;
  readonly title: string;
  readonly requestedById: string;
  readonly requestedAt: Date;
  readonly requestComment: string | null;
  readonly approverType: ApproverType;
  readonly approverUserId: string | null;
  readonly approverRoleId: string | null;
  readonly approverDepartmentId: string | null;
  readonly allowDeputy: boolean;
  readonly dueAt: Date | null;
  readonly status: ApprovalStatus;
  readonly createdAt: Date;
  readonly createdById: string;
}

/** Documento coberto e a versão exata analisada (`ApprovalDocument`). */
export interface ApprovalCoverage {
  readonly id: string;
  readonly documentId: string;
  readonly documentVersionId: string;
}

/** Aprovador registrado na solicitação (as decisões futuras usam exatamente este registro). */
export interface ResolvedApprover {
  readonly approverType: ApproverType;
  readonly approverUserId: string | null;
  readonly approverRoleId: string | null;
  readonly approverDepartmentId: string | null;
  readonly allowDeputy: boolean;
}

export class ApproverUnresolvedError extends Error {
  constructor(readonly approverType: ApproverType) {
    super(`Aprovador ${approverType} não resolvível pela política do tipo.`);
    this.name = 'ApproverUnresolvedError';
  }
}

/**
 * Aprovador da submissão avulsa pela `DocumentType.approvalPolicy` (entities.md §5.7): `USER` e
 * `ROLE` diretos; `DEPARTMENT_HEAD` registra a unidade cujo titular/substituto decide (fixa,
 * secretaria ou setor solicitante do processo).
 */
export function resolveDocumentApprover(
  policy: ApprovalPolicy,
  process: { readonly requestingSecretariatId: string; readonly requestingDepartmentId: string },
): ResolvedApprover {
  const base = {
    approverType: policy.approverType,
    approverUserId: null,
    approverRoleId: null,
    approverDepartmentId: null,
    allowDeputy: policy.allowDeputy,
  };
  switch (policy.approverType) {
    case 'USER':
      if (!policy.approverUserId) throw new ApproverUnresolvedError('USER');
      return { ...base, approverUserId: policy.approverUserId };
    case 'ROLE':
      if (!policy.approverRoleId) throw new ApproverUnresolvedError('ROLE');
      return { ...base, approverRoleId: policy.approverRoleId };
    case 'DEPARTMENT_HEAD': {
      const departmentId =
        policy.approverDepartmentResolution === 'FIXED'
          ? (policy.approverFixedDepartmentId ?? null)
          : policy.approverDepartmentResolution === 'REQUESTING_SECRETARIAT'
            ? process.requestingSecretariatId
            : policy.approverDepartmentResolution === 'REQUESTING_DEPARTMENT'
              ? process.requestingDepartmentId
              : null;
      if (departmentId === null) throw new ApproverUnresolvedError('DEPARTMENT_HEAD');
      return { ...base, approverDepartmentId: departmentId };
    }
  }
}

const TITLE_MAX = 200;

/** RN-TRAM-52: "Aprovação avulsa — {nome do tipo} {código}" (até 200 caracteres). */
export function documentApprovalTitle(
  typeName: string,
  code: string | null,
  title: string,
): string {
  const label = code === null ? `${typeName} "${title}"` : `${typeName} ${code}`;
  const full = `Aprovação avulsa — ${label}`;
  return full.length <= TITLE_MAX ? full : `${full.slice(0, TITLE_MAX - 1)}…`;
}
