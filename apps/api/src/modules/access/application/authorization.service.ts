import { CONTEXTUAL_POLICIES } from '@contrataflow/types';
import type { PermissionCode, PolicyId } from '@contrataflow/types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import type {
  AuthorizationPort,
  AuthorizationRequest,
  PolicyResult,
} from '#shared/auth/authorization.js';
import type { EffectivePermissionsSnapshot } from '#shared/auth/effective-permissions.js';
import { hasSecondFactor } from '#shared/auth/mfa-policy.js';
import { isProcessVisible, ProcessAccessRegistry } from '#shared/auth/process-access.js';
import type { ProcessAccessTarget, ProcessVisibilityScope } from '#shared/auth/process-access.js';
import { requireRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { DatabaseUnavailableError, isTransientDatabaseError } from '#shared/database/errors.js';
import { ApiError } from '#shared/errors/api-error.js';

import { EffectivePermissionsService } from './effective-permissions.service.js';
import { ACCESS_CLOCK, ACCESS_TRANSACTIONS } from './ports.js';
import type { AccessClock, AccessTransactions } from './ports.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import {
  decide,
  mfaPolicyNeeded,
  requiresMfa,
  sessionRequiresMfa,
} from '../domain/authorization-decision.js';
import { EffectivePermissionSet } from '../domain/effective-permissions.js';
import { PERMISSION_RISKS } from '../domain/permission-grants.js';

/*
 * `AuthorizationService` (US-097 · RN-IAM-100/104/105 · DEC-134): o mecanismo único de decisão.
 * O `AuthorizationGuard` chama `authorize` em toda rota `TENANT` com vínculo ativo: as permissões
 * efetivas entram no contexto (os `assertCan` dos casos de uso decidem por elas) e os requisitos
 * declarados na rota são aplicados — permissão (perfil com escopo ∪ participação), MFA (POL-14) e
 * as políticas contextuais avaliadas pelo guard. Recurso não visível = 404; visível sem permissão =
 * 403; toda recusa vira `access.denied` (filtro RFC 9457, com amostragem).
 */

const EMPTY_SNAPSHOT = (membershipId: string, userId: string): EffectivePermissionsSnapshot => ({
  membershipId,
  userId,
  grants: [],
  ownDepartmentIds: [],
  headOfDepartmentIds: [],
  computedAt: new Date(0).toISOString(),
});

const processIdSchema = z.uuid();

/**
 * Quem desmascara o valor estimado sigiloso, linha a linha (POL-09 · RN-PROC-25 · US-002): os
 * escopos de `PROCESS_VIEW_CONFIDENTIAL_BUDGET` e a custódia atual (responsável, ou fila de uma
 * lotação do vínculo).
 */
export interface ConfidentialBudgetAccess {
  /** Escopos expandidos da permissão; vazios quando ela não vale nesta sessão (MFA — FA-12). */
  readonly scope: ProcessVisibilityScope;
  /** Lotações ativas do vínculo (custódia de processo na fila da unidade, sem responsável). */
  readonly custodyDepartmentIds: readonly string[];
  /** A permissão existe, mas a sessão sem 2º fator não a usa: o step-up desmascararia (FA-12). */
  readonly stepUpAvailable: boolean;
}

/**
 * Inexistente, de outro tenant e não visível respondem igual (RN-IAM-104 · FA-05). É uma negação
 * de `PROCESS_VIEW` (DEC-024): auditada como `access.denied` (permissions.md §1 — US-060), com o
 * mesmo corpo nos três casos.
 */
export function processNotFound(): ApiError {
  return new ApiError('PROCESS_NOT_FOUND', {
    detail: 'Não encontramos o recurso solicitado.',
    auditReasonCode: 'PROCESS_VIEW',
    auditDenial: true,
  });
}

/** V-01 (US-090): o frontend aciona o *step-up* (`/api/auth/step-up`). */
function mfaRequired(): ApiError {
  return new ApiError('MFA_REQUIRED', {
    detail: 'Confirme sua identidade para continuar.',
    auditReasonCode: 'MFA_REQUIRED',
  });
}

const POLICY_DENIALS: ReadonlyMap<string, { readonly code: string; readonly status: number }> =
  new Map(
    CONTEXTUAL_POLICIES.map((policy) => [
      policy.id,
      { code: policy.denialCode, status: policy.denialStatus },
    ]),
  );

/** Recusa de política: o código da política (ou o informado) e `reasonCode` = ID (RN-IAM-105). */
export function policyDenial(
  policyId: PolicyId,
  result: Extract<PolicyResult, { allowed: false }>,
): ApiError {
  const fallback = POLICY_DENIALS.get(policyId) ?? { code: 'PERMISSION_DENIED', status: 403 };
  const code = result.code ?? fallback.code;
  return new ApiError(code, {
    status: result.status ?? (result.code === undefined ? fallback.status : 403),
    ...(result.detail === undefined ? {} : { detail: result.detail }),
    auditReasonCode: policyId,
    auditDenial: true,
  });
}

@Injectable()
export class AuthorizationService implements AuthorizationPort {
  private readonly logger = new Logger('Authorization');

  constructor(
    private readonly effective: EffectivePermissionsService,
    private readonly identity: IdentityFacade,
    private readonly processes: ProcessAccessRegistry,
    @Inject(ACCESS_TRANSACTIONS) private readonly transactions: AccessTransactions,
    @Inject(ACCESS_CLOCK) private readonly clock: AccessClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
  ) {}

  /**
   * Permissões efetivas do vínculo da requisição: as do contexto (carregadas pelo guard) ou do
   * cache/banco, guardadas no contexto. Sem vínculo (job, ator de plataforma), nenhuma permissão.
   */
  async current(): Promise<EffectivePermissionSet> {
    const context = requireRequestContext();
    if (context.permissions) return new EffectivePermissionSet(context.permissions);
    const { membershipId, userId } = context.actor;
    if (membershipId === null || userId === null) {
      return new EffectivePermissionSet(EMPTY_SNAPSHOT(membershipId ?? '', userId ?? ''));
    }
    const snapshot = await this.effective.resolve({
      membershipId,
      userId,
      roleKeys: context.roleKeys ?? [],
    });
    updateRequestContext({ permissions: snapshot });
    return new EffectivePermissionSet(snapshot);
  }

  /**
   * POL-09 para listas (US-002 · FA-12): a permissão é `HIGH`; sem o 2º fator exigido por
   * `security.mfaPolicy`, ela NÃO é considerada para desmascarar — valores mascarados, sem 403.
   */
  async confidentialBudgetAccess(): Promise<ConfidentialBudgetAccess> {
    const permission = 'PROCESS_VIEW_CONFIDENTIAL_BUDGET';
    const permissions = await this.current();
    const scope = permissions.processScopeOf(permission);
    const custodyDepartmentIds = permissions.snapshot.ownDepartmentIds;
    const granted =
      scope.tenantWide || scope.organizationIds.length > 0 || scope.departmentIds.length > 0;
    const riskLevel = PERMISSION_RISKS[permission];
    if (
      granted &&
      mfaPolicyNeeded(riskLevel, hasSecondFactor(requireRequestContext().amr)) &&
      requiresMfa(riskLevel, await this.identity.mfaPolicy())
    ) {
      return {
        scope: { userId: scope.userId, tenantWide: false, organizationIds: [], departmentIds: [] },
        custodyDepartmentIds,
        stepUpAvailable: true,
      };
    }
    return { scope, custodyDepartmentIds, stepUpAvailable: false };
  }

  /**
   * A permissão (em algum escopo) libera um CAMPO sensível da resposta, sem negar a requisição nem
   * auditar (US-054 · RN-TRAM-74: `ip` da tramitação com `AUDIT_VIEW`). Como na POL-09 das listas,
   * permissão `HIGH` sem o 2º fator exigido por `security.mfaPolicy` não conta. Com o cache de
   * permissões fora nesta requisição, o campo fica oculto (postura segura até o cache voltar).
   */
  async revealsField(permission: PermissionCode): Promise<boolean> {
    const permissions = await this.current();
    if (requireRequestContext().permissionCacheUnavailable === true) return false;
    if (!permissions.has(permission)) return false;
    const riskLevel = PERMISSION_RISKS[permission];
    if (!mfaPolicyNeeded(riskLevel, hasSecondFactor(requireRequestContext().amr))) return true;
    return !requiresMfa(riskLevel, await this.identity.mfaPolicy());
  }

  async authorize(request: AuthorizationRequest): Promise<void> {
    await this.assertSessionMfa(request.route ?? null);
    const permissions = await this.current();
    let process: ProcessAccessTarget | null = null;
    const requirement = request.requirement;
    if (requirement) {
      if (requirement.scope !== 'ANY') {
        process = await this.visibleProcess(
          permissions,
          request.params[requirement.scope.processParam],
        );
      }
      await this.assertPermission(
        permissions,
        requirement.permission,
        process,
        requirement.detail,
        request.route ?? null,
      );
    }
    const { actor } = requireRequestContext();
    for (const declaration of request.policies) {
      // ID = política aplicada pelo caso de uso (precisa do corpo ou da transação).
      if (typeof declaration === 'string') continue;
      const policy = await request.resolvePolicy(declaration);
      const result = await policy.evaluate({
        userId: actor.userId ?? '',
        membershipId: actor.membershipId ?? '',
        params: request.params,
        process,
        has: (code) => permissions.has(code),
      });
      if (!result.allowed) throw policyDenial(policy.id, result);
    }
  }

  /**
   * Permissão (perfil com escopo que cubra o processo, quando houver, ∪ participação) e MFA
   * (POL-14) — RN-IAM-100. `MFA_REQUIRED` também grava `auth.mfa_required` (SECURITY).
   */
  async assertPermission(
    permissions: EffectivePermissionSet,
    permission: PermissionCode,
    process: ProcessAccessTarget | null,
    detail = 'Você não tem permissão para esta ação.',
    route: string | null = null,
  ): Promise<void> {
    const { amr } = requireRequestContext();
    const riskLevel = PERMISSION_RISKS[permission];
    const secondFactor = hasSecondFactor(amr);
    const grantedByRole = process
      ? permissions.roleCoversProcess(permission, process)
      : permissions.has(permission);
    const grantedByParticipation = process
      ? permissions.participationGrants(permission, process, this.clock())
      : false;
    const granted = grantedByRole || grantedByParticipation;
    const decision = decide({
      authenticated: true,
      tenantActive: true,
      membershipActive: true,
      riskLevel,
      grantedByRole,
      grantedByParticipation,
      mfaPolicy:
        granted && mfaPolicyNeeded(riskLevel, secondFactor)
          ? await this.identity.mfaPolicy()
          : 'NONE',
      hasSecondFactor: secondFactor,
    });
    if (decision.allowed) return;
    if (decision.code === 'MFA_REQUIRED') {
      await this.recordMfaRequired(permission, route);
      throw mfaRequired();
    }
    throw new ApiError(decision.code, {
      ...(decision.code === 'PERMISSION_DENIED' ? { detail } : {}),
      auditReasonCode: permission,
    });
  }

  /** Processo do parâmetro de rota, se visível (DEC-024); senão 404 igual ao inexistente. */
  private async visibleProcess(
    permissions: EffectivePermissionSet,
    processId: string | undefined,
  ): Promise<ProcessAccessTarget> {
    if (processId === undefined || !processIdSchema.safeParse(processId).success) {
      throw new ApiError('MALFORMED_REQUEST', { detail: 'Requisição inválida.' });
    }
    const target = await this.readProcess(processId);
    if (target === null || !isProcessVisible(permissions.visibilityScope(), target)) {
      throw processNotFound();
    }
    return target;
  }

  private async readProcess(processId: string): Promise<ProcessAccessTarget | null> {
    try {
      return await this.transactions.read((tx) => this.processes.load(tx, processId));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      this.logger.error(
        {
          event: 'authorization.decision_failed',
          errorCode: isTransientDatabaseError(error) ? 'DEPENDENCY_UNAVAILABLE' : 'INTERNAL_ERROR',
          correlationId: requireRequestContext().correlationId,
        },
        'authorization.decision_failed',
      );
      if (isTransientDatabaseError(error)) throw new DatabaseUnavailableError(error);
      throw error;
    }
  }

  /**
   * RN-IAM-39 (US-090): com `security.mfaPolicy = ALL`, toda requisição da instituição exige o
   * segundo fator — não só as permissões `HIGH`. A política só é lida (cache de 60 s por tenant,
   * apagado ao mudar a configuração — RN-IAM-42) quando a sessão não comprova o fator.
   */
  private async assertSessionMfa(route: string | null): Promise<void> {
    if (hasSecondFactor(requireRequestContext().amr)) return;
    if (!sessionRequiresMfa(await this.identity.mfaPolicy())) return;
    await this.recordMfaRequired(null, route);
    throw mfaRequired();
  }

  /** `auth.mfa_required` (SECURITY): falha ao gravar não muda a recusa. */
  private async recordMfaRequired(
    permission: PermissionCode | null,
    route: string | null,
  ): Promise<void> {
    try {
      await this.audit.recordStandalone({
        action: 'auth.mfa_required',
        result: 'DENIED',
        reasonCode: 'MFA_REQUIRED',
        metadata: {
          permissionCode: permission,
          ...(route === null ? {} : { route }),
        },
      });
    } catch {
      // Já registrado (`audit.write_failed`) pelo serviço; a recusa continua.
    }
  }
}
