import type { TenantSelection } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { tenantEntryRequiresMfa } from '#shared/auth/mfa-policy.js';
import { runWithTenantScope } from '#shared/context/request-context.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import { IDENTITY_CLOCK, IDENTITY_REPOSITORY, SESSION_AUDIT, TENANT_MFA_POLICY } from './ports.js';
import type { Clock, IdentityRepository, SessionAuditPort, TenantMfaPolicyPort } from './ports.js';
import { isUsable } from '../domain/tenant-membership.js';
import type { TenantMembership } from '../domain/tenant-membership.js';
import { canSignIn, defaultTenantOf, displayName } from '../domain/user.js';
import type { User } from '../domain/user.js';

export interface RecordSessionTenantInput {
  readonly subject: string;
  /** Instituição pedida; `null` quando a troca chega só pelo vínculo (`membershipId`). */
  readonly tenantId: string | null;
  /** Vínculo escolhido em SCR-101 (US-093); `null` = resolve pelo `tenantId`. */
  readonly membershipId: string | null;
  /** `start`: instituição ativada ao entrar (`auth.session_start`); `switch`: troca (US-093). */
  readonly kind: 'start' | 'switch';
  readonly selection: TenantSelection;
  readonly firstLogin: boolean;
  readonly fromTenantId: string | null;
  /** "Usar como padrão" (FA-04 da US-093). */
  readonly setAsDefault: boolean;
  readonly amr: readonly string[];
  readonly sessionIdHash: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/**
 * `activated`: instituição ativada (auditada); `unchanged`: troca para a instituição já ativa —
 * no-op, sem auditoria (RN-IAM-70); `mfa_required`: o destino exige segundo fator que a sessão não
 * tem — nada foi gravado, a troca espera o *step-up* (RN-IAM-69).
 */
export type SessionTenantOutcome = 'activated' | 'unchanged' | 'mfa_required';

export interface RecordSessionTenantResult {
  readonly outcome: SessionTenantOutcome;
  readonly user: User;
  readonly membership: TenantMembership;
  readonly readOnly: boolean;
  readonly memberships: readonly TenantMembership[];
  /** Instituição padrão depois da chamada (`preferences.defaultTenantId`). */
  readonly defaultTenantId: string | null;
}

/**
 * `RecordSessionTenantCommand` (US-087 · passo 10 · RN-IAM-17 · US-093 · `ResolveSessionEvent`):
 * revalida, no banco, que o vínculo com a instituição escolhida é utilizável (RN-IAM-08/65/67/68),
 * registra o acesso ao vínculo (RN-IAM-16) e grava `auth.session_start` ou `auth.tenant_switch` na
 * própria instituição (RN-IAM-71). Vínculo de outra pessoa → 422 `REFERENCE_NOT_FOUND`;
 * inexistente/inativo → 403 `MEMBERSHIP_INACTIVE`; instituição indisponível → 403
 * `TENANT_SUSPENDED`. Na troca, o MFA é o da instituição de destino (RN-IAM-69).
 */
@Injectable()
export class RecordSessionTenantCommand {
  constructor(
    @Inject(IDENTITY_REPOSITORY) private readonly identities: IdentityRepository,
    @Inject(SESSION_AUDIT) private readonly audit: SessionAuditPort,
    @Inject(TENANT_MFA_POLICY) private readonly mfaPolicies: TenantMfaPolicyPort,
    @Inject(IDENTITY_CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: RecordSessionTenantInput): Promise<RecordSessionTenantResult> {
    const now = this.clock();
    const user = await this.identities.findUserBySubject(input.subject);
    if (!user) throw new ApiError('MEMBERSHIP_INACTIVE');
    if (!canSignIn(user)) throw blockedUserError();

    const memberships = await this.identities.listMemberships(user.id);
    const membership = targetMembership(memberships, input);
    const access = isUsable(membership, now);
    if (!access.usable) throw new ApiError(access.reason);

    const tenantId = membership.tenant.id;
    const unchanged = input.kind === 'switch' && input.fromTenantId === tenantId;
    const result = (outcome: SessionTenantOutcome, defaultTenantId: string | null) => ({
      outcome,
      user,
      membership,
      readOnly: access.readOnly,
      memberships,
      defaultTenantId,
    });

    if (input.kind === 'switch' && !unchanged) {
      const policy = await this.mfaPolicies.mfaPolicyOf(tenantId);
      if (tenantEntryRequiresMfa(policy, input.amr)) {
        return result('mfa_required', defaultTenantOf(user));
      }
    }

    let defaultTenantId = defaultTenantOf(user);
    if (input.setAsDefault && defaultTenantId !== tenantId) {
      await this.identities.setDefaultTenant(user.id, tenantId);
      defaultTenantId = tenantId;
    }
    if (unchanged) return result('unchanged', defaultTenantId);

    const scope = { tenantId, userId: user.id, membershipId: membership.id };
    await runWithTenantScope({ ...scope, actorName: displayName(user) }, async () => {
      await this.identities.touchMembershipAccess(tenantId, membership.id, now);
      const entry = {
        ...scope,
        sessionIdHash: input.sessionIdHash,
        ip: input.ip,
        userAgent: input.userAgent,
      };
      await (input.kind === 'start'
        ? this.audit.sessionStarted({
            ...entry,
            selection: input.selection,
            firstLogin: input.firstLogin,
            amr: input.amr,
          })
        : this.audit.tenantSwitched({
            ...entry,
            fromTenantId: input.fromTenantId,
            selection: input.selection,
          }));
    });
    return result('activated', defaultTenantId);
  }
}

/**
 * O vínculo pedido entre os do próprio usuário: pelo `membershipId` (V-01 — de outra pessoa ou
 * inexistente → 422 `REFERENCE_NOT_FOUND`, sem revelar se existe) ou pelo `tenantId` (sem vínculo
 * → 403 `MEMBERSHIP_INACTIVE`).
 */
function targetMembership(
  memberships: readonly TenantMembership[],
  input: Pick<RecordSessionTenantInput, 'membershipId' | 'tenantId'>,
): TenantMembership {
  if (input.membershipId !== null) {
    const chosen = memberships.find((candidate) => candidate.id === input.membershipId);
    if (!chosen || (input.tenantId !== null && chosen.tenant.id !== input.tenantId)) {
      throw validationError([
        {
          field: 'membershipId',
          code: 'REFERENCE_NOT_FOUND',
          message: 'Selecione uma instituição válida.',
        },
      ]);
    }
    return chosen;
  }
  const chosen = memberships.find((candidate) => candidate.tenant.id === input.tenantId);
  if (!chosen) throw new ApiError('MEMBERSHIP_INACTIVE');
  return chosen;
}

/** Usuário bloqueado pela plataforma (V-05): 403 `PERMISSION_DENIED` — ver Lacuna 6. */
export function blockedUserError(): ApiError {
  return new ApiError('PERMISSION_DENIED', {
    detail: 'Seu acesso ao ContrataFlow está bloqueado. Procure o suporte da sua instituição.',
    extensions: { reason: 'USER_BLOCKED' },
  });
}
