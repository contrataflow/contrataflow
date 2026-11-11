import type { PermissionCode } from '@contrataflow/types';

import { AuthorizationService } from '#modules/access/application/authorization.service.js';
import type { EffectivePermissionsService } from '#modules/access/application/effective-permissions.service.js';
import { InMemoryAccessTransactions } from '#modules/access/infrastructure/access-transactions.js';
import type { IdentityFacade } from '#modules/identity/application/identity.facade.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import type { PermissionRequirement } from '#shared/auth/authorization.js';
import type {
  EffectiveGrant,
  EffectivePermissionsSnapshot,
  PermissionScopeType,
} from '#shared/auth/effective-permissions.js';
import { ProcessAccessRegistry } from '#shared/auth/process-access.js';
import type { ProcessAccessTarget } from '#shared/auth/process-access.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';

/*
 * O `AuthorizationService` REAL (o mesmo que o `AuthorizationGuard` chama) com as bordas trocadas
 * por dados: o retrato de permissões efetivas é o informado, o processo do parâmetro de rota vem
 * de um alvo em memória e a política de MFA é `NONE` (POL-14 tem a sua própria bateria). Sem banco
 * nem Nest: a bateria `test:authz` roda em segundos.
 */

export const NOW = new Date('2026-11-10T12:00:00.000Z');
export const PROCESS_ID = '0192f000-0000-7000-8000-0000000a0635';
const TENANT_ID = '0192f000-0000-7000-8000-0000000a0600';

export type Outcome = 'ALLOW' | 'PERMISSION_DENIED' | 'PROCESS_NOT_FOUND' | 'MFA_REQUIRED';

/** Vínculo de teste: usuário, lotações e as concessões já expandidas (§1.2). */
export interface Viewer {
  readonly userId: string;
  readonly ownDepartmentIds: readonly string[];
  readonly grants: readonly EffectiveGrant[];
}

/** Concessão de um conjunto de permissões num escopo, com as unidades já expandidas. */
export function grant(
  type: PermissionScopeType,
  permissions: readonly PermissionCode[],
  options: { organizationId?: string; departmentIds?: readonly string[] } = {},
): EffectiveGrant {
  return {
    scope: {
      type,
      organizationId: type === 'ORGANIZATION' ? (options.organizationId ?? null) : null,
      departmentId: type === 'DEPARTMENT' ? (options.departmentIds?.[0] ?? null) : null,
      includeSubtree: false,
      departmentIds:
        type === 'DEPARTMENT' || type === 'OWN_DEPARTMENTS'
          ? [...(options.departmentIds ?? [])]
          : [],
    },
    permissions,
  };
}

export class AuthorizationHarness {
  private snapshot: EffectivePermissionsSnapshot | null = null;
  private target: ProcessAccessTarget | null = null;
  private readonly service: AuthorizationService;

  constructor() {
    const registry = new ProcessAccessRegistry();
    registry.register({ load: () => Promise.resolve(this.target) });
    this.service = new AuthorizationService(
      {
        resolve: () =>
          this.snapshot
            ? Promise.resolve(this.snapshot)
            : Promise.reject(new Error('retrato não definido')),
      } as unknown as EffectivePermissionsService,
      { mfaPolicy: () => Promise.resolve('NONE') } as unknown as IdentityFacade,
      registry,
      new InMemoryAccessTransactions(),
      () => NOW,
      { recordStandalone: () => Promise.resolve(undefined) } as unknown as AuditTrailPort,
    );
  }

  /** Decisão da rota com o requisito informado, para o vínculo sobre o processo (ou nenhum). */
  async decide(
    viewer: Viewer,
    requirement: PermissionRequirement,
    target: ProcessAccessTarget | null,
  ): Promise<Outcome> {
    this.snapshot = {
      membershipId: `m-${viewer.userId}`,
      userId: viewer.userId,
      grants: viewer.grants,
      ownDepartmentIds: viewer.ownDepartmentIds,
      headOfDepartmentIds: [],
      computedAt: NOW.toISOString(),
    };
    this.target = target;
    const params =
      requirement.scope === 'ANY' ? {} : { [requirement.scope.processParam]: PROCESS_ID };
    try {
      await runWithRequestContext({ correlationId: 'authz', ip: '', userAgent: '' }, () => {
        updateRequestContext({
          tenantId: TENANT_ID,
          actor: { type: 'USER', userId: viewer.userId, membershipId: `m-${viewer.userId}` },
          amr: ['pwd'],
        });
        return this.service.authorize({
          requirement,
          policies: [],
          params,
          resolvePolicy: () => Promise.reject(new Error('sem política na matriz')),
        });
      });
      return 'ALLOW';
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'PERMISSION_DENIED' || code === 'PROCESS_NOT_FOUND' || code === 'MFA_REQUIRED') {
        return code;
      }
      throw error;
    }
  }
}
