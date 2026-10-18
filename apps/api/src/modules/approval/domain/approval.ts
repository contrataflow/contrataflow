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

/** Aprovador configurado na etapa `APPROVAL` (`WorkflowStage` — DEC-022 · RN-WF-16). */
export interface StageApproverConfig {
  readonly approverType: ApproverType | null;
  readonly approverUserId: string | null;
  readonly approverRoleId: string | null;
  readonly approverDepartmentResolution:
    'FIXED' | 'REQUESTING_SECRETARIAT' | 'REQUESTING_DEPARTMENT' | null;
  readonly approverFixedDepartmentId: string | null;
}

/** Unidades solicitantes do processo (resolução `REQUESTING_*` do titular). */
export interface RequestingUnitsOf {
  readonly requestingSecretariatId: string;
  readonly requestingDepartmentId: string;
}

/** Unidade cujo titular decide (`DEPARTMENT_HEAD`), como a resolução a lê. */
export interface ApproverDepartment {
  readonly id: string;
  readonly isActive: boolean;
  readonly headUserId: string | null;
}

/** Unidade cujo titular decide (`DEPARTMENT_HEAD`); `null` para `USER`/`ROLE` ou sem resolução. */
export function stageApproverDepartmentId(
  config: StageApproverConfig,
  process: RequestingUnitsOf,
): string | null {
  if (config.approverType !== 'DEPARTMENT_HEAD') return null;
  switch (config.approverDepartmentResolution) {
    case 'FIXED':
      return config.approverFixedDepartmentId;
    case 'REQUESTING_SECRETARIAT':
      return process.requestingSecretariatId;
    case 'REQUESTING_DEPARTMENT':
      return process.requestingDepartmentId;
    case null:
      return null;
  }
}

/**
 * Aprovador da etapa `APPROVAL` (US-047 → US-051 · RN-TRAM-47/48/49): `USER` e `ROLE` diretos
 * (`allowDeputy = false`); `DEPARTMENT_HEAD` registra a unidade E o titular atual
 * (`approverUserId = headUserId`, `allowDeputy = true`). Unidade inativa ou sem titular, perfil ou
 * usuário ausentes → `ApproverUnresolvedError` (desfaz o encaminhamento inteiro).
 */
export function resolveStageApprover(
  config: StageApproverConfig,
  department: ApproverDepartment | null,
): ResolvedApprover {
  const none = { approverUserId: null, approverRoleId: null, approverDepartmentId: null };
  switch (config.approverType) {
    case 'USER':
      if (config.approverUserId === null) throw new ApproverUnresolvedError('USER');
      return {
        ...none,
        approverType: 'USER',
        approverUserId: config.approverUserId,
        allowDeputy: false,
      };
    case 'ROLE':
      if (config.approverRoleId === null) throw new ApproverUnresolvedError('ROLE');
      return {
        ...none,
        approverType: 'ROLE',
        approverRoleId: config.approverRoleId,
        allowDeputy: false,
      };
    case 'DEPARTMENT_HEAD':
      if (department === null || !department.isActive || department.headUserId === null) {
        throw new ApproverUnresolvedError('DEPARTMENT_HEAD');
      }
      return {
        approverType: 'DEPARTMENT_HEAD',
        approverUserId: department.headUserId,
        approverRoleId: null,
        approverDepartmentId: department.id,
        allowDeputy: true,
      };
    case null:
      throw new ApproverUnresolvedError('USER');
  }
}

/**
 * RN-TRAM-52: "Aprovação de {nome da etapa} — {código do principal documento coberto}" (sem
 * documento coberto, só a etapa), até 200 caracteres.
 */
export function stageApprovalTitle(stageName: string, principalCode: string | null): string {
  const full =
    principalCode === null
      ? `Aprovação de ${stageName}`
      : `Aprovação de ${stageName} — ${principalCode}`;
  return full.length <= TITLE_MAX ? full : `${full.slice(0, TITLE_MAX - 1)}…`;
}
