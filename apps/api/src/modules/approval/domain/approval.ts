import type { ApprovalPolicy, ApproverType } from '@contrataflow/validation';

/*
 * `Approval` (entities.md §4.6 · DEC-022) e a solicitação de aprovação da US-051 (RN-TRAM-43..52):
 * o aprovador é resolvido NA SOLICITAÇÃO — pela etapa `APPROVAL` (encaminhamento, US-047) ou pela
 * `DocumentType.approvalPolicy` (submissão avulsa, US-065) — e gravado; as decisões (US-052) usam
 * exatamente esse registro. Funções puras: o que a resolução precisa ler vem em `ApproverFacts`.
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

/**
 * Aprovador configurado: na etapa `APPROVAL` (`WorkflowStage` — RN-WF-16) ou na
 * `DocumentType.approvalPolicy` (entities.md §5.7 — `approverConfigOfPolicy`).
 */
export interface ApproverConfig {
  readonly approverType: ApproverType | null;
  readonly approverUserId: string | null;
  readonly approverRoleId: string | null;
  readonly approverDepartmentResolution:
    'FIXED' | 'REQUESTING_SECRETARIAT' | 'REQUESTING_DEPARTMENT' | null;
  readonly approverFixedDepartmentId: string | null;
}

/** Nome histórico (US-047): a configuração da etapa `APPROVAL`. */
export type StageApproverConfig = ApproverConfig;

/** A política do tipo de documento como configuração do aprovador (submissão avulsa). */
export function approverConfigOfPolicy(policy: ApprovalPolicy): ApproverConfig {
  return {
    approverType: policy.approverType,
    approverUserId: policy.approverUserId ?? null,
    approverRoleId: policy.approverRoleId ?? null,
    approverDepartmentResolution: policy.approverDepartmentResolution ?? null,
    approverFixedDepartmentId: policy.approverFixedDepartmentId ?? null,
  };
}

/** O processo como a resolução o lê: o órgão e as unidades solicitantes. */
export interface RequestingUnitsOf {
  readonly organizationId: string;
  readonly requestingSecretariatId: string;
  readonly requestingDepartmentId: string;
}

/** Unidade cujo titular decide (`DEPARTMENT_HEAD`), como a resolução a lê. */
export interface ApproverDepartment {
  readonly id: string;
  readonly isActive: boolean;
  readonly headUserId: string | null;
}

/** O que a resolução leu no `tx` da solicitação. */
export interface ApproverFacts {
  /** `DEPARTMENT_HEAD`: a unidade do tenant (`null` = inexistente — inclusive de outro tenant). */
  readonly department: ApproverDepartment | null;
  /** Usuários (aprovador `USER` ou titular) com vínculo `ACTIVE` não vencido no tenant. */
  readonly activeMemberIds: ReadonlySet<string>;
  /** `ROLE`: detentores competentes no escopo da unidade solicitante (RN-TRAM-47). */
  readonly roleHolderIds: readonly string[];
}

/** Por que não há aprovador (logs e métricas — nunca dados pessoais). */
export type UnresolvedReason =
  | 'NOT_CONFIGURED'
  | 'USER_NOT_ACTIVE'
  | 'DEPARTMENT_UNAVAILABLE'
  | 'NO_HEAD'
  | 'HEAD_NOT_ACTIVE'
  | 'ROLE_SCOPE_EMPTY';

export class ApproverUnresolvedError extends Error {
  constructor(
    readonly approverType: ApproverType | null,
    readonly reason: UnresolvedReason,
  ) {
    super(`Aprovador ${approverType ?? 'não configurado'} não resolvível (${reason}).`);
    this.name = 'ApproverUnresolvedError';
  }
}

/** Unidade cujo titular decide (`DEPARTMENT_HEAD`); `null` para `USER`/`ROLE` ou sem resolução. */
export function approverDepartmentId(
  config: ApproverConfig,
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
 * RN-TRAM-47/48/49: `USER` — o usuário configurado, com vínculo ativo; `ROLE` — o perfil (nenhuma
 * pessoa é escolhida aqui), desde que haja ao menos um detentor competente no escopo da unidade
 * solicitante; `DEPARTMENT_HEAD` — a unidade e o titular atual (`approverUserId = headUserId`, com
 * vínculo ativo no tenant), `allowDeputy = true`. `allowDeputy = false` para `USER`/`ROLE`.
 * Sem aprovador → `ApproverUnresolvedError` (desfaz a ação de origem inteira).
 */
export function resolveApprover(config: ApproverConfig, facts: ApproverFacts): ResolvedApprover {
  const none = { approverUserId: null, approverRoleId: null, approverDepartmentId: null };
  switch (config.approverType) {
    case 'USER': {
      const userId = config.approverUserId;
      if (userId === null) throw new ApproverUnresolvedError('USER', 'NOT_CONFIGURED');
      if (!facts.activeMemberIds.has(userId)) {
        throw new ApproverUnresolvedError('USER', 'USER_NOT_ACTIVE');
      }
      return { ...none, approverType: 'USER', approverUserId: userId, allowDeputy: false };
    }
    case 'ROLE': {
      const roleId = config.approverRoleId;
      if (roleId === null) throw new ApproverUnresolvedError('ROLE', 'NOT_CONFIGURED');
      if (facts.roleHolderIds.length === 0) {
        throw new ApproverUnresolvedError('ROLE', 'ROLE_SCOPE_EMPTY');
      }
      return { ...none, approverType: 'ROLE', approverRoleId: roleId, allowDeputy: false };
    }
    case 'DEPARTMENT_HEAD': {
      const { department } = facts;
      if (config.approverDepartmentResolution === null) {
        throw new ApproverUnresolvedError('DEPARTMENT_HEAD', 'NOT_CONFIGURED');
      }
      if (!department?.isActive) {
        throw new ApproverUnresolvedError('DEPARTMENT_HEAD', 'DEPARTMENT_UNAVAILABLE');
      }
      if (department.headUserId === null) {
        throw new ApproverUnresolvedError('DEPARTMENT_HEAD', 'NO_HEAD');
      }
      if (!facts.activeMemberIds.has(department.headUserId)) {
        throw new ApproverUnresolvedError('DEPARTMENT_HEAD', 'HEAD_NOT_ACTIVE');
      }
      return {
        approverType: 'DEPARTMENT_HEAD',
        approverUserId: department.headUserId,
        approverRoleId: null,
        approverDepartmentId: department.id,
        allowDeputy: true,
      };
    }
    case null:
      throw new ApproverUnresolvedError(null, 'NOT_CONFIGURED');
  }
}

/** Usuários cujo vínculo a resolução precisa conferir (aprovador `USER` ou titular). */
export function approverCandidateIds(
  config: ApproverConfig,
  department: ApproverDepartment | null,
): string[] {
  if (config.approverType === 'USER' && config.approverUserId !== null) {
    return [config.approverUserId];
  }
  if (config.approverType === 'DEPARTMENT_HEAD' && department?.headUserId) {
    return [department.headUserId];
  }
  return [];
}

const TITLE_MAX = 200;

const clip = (full: string) =>
  full.length <= TITLE_MAX ? full : `${full.slice(0, TITLE_MAX - 1)}…`;

/** RN-TRAM-52: "Aprovação avulsa — {nome do tipo} {código}" (até 200 caracteres). */
export function documentApprovalTitle(
  typeName: string,
  code: string | null,
  title: string,
): string {
  const label = code === null ? `${typeName} "${title}"` : `${typeName} ${code}`;
  return clip(`Aprovação avulsa — ${label}`);
}

/**
 * RN-TRAM-52: "Aprovação de {nome da etapa} — {código do principal documento coberto}" (sem
 * documento coberto, só a etapa), até 200 caracteres.
 */
export function stageApprovalTitle(stageName: string, principalCode: string | null): string {
  return clip(
    principalCode === null
      ? `Aprovação de ${stageName}`
      : `Aprovação de ${stageName} — ${principalCode}`,
  );
}
