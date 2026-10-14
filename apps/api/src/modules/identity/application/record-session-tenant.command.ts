import type { TenantSelection } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { runWithTenantScope } from '#shared/context/request-context.js';
import { ApiError } from '#shared/errors/api-error.js';

import { IDENTITY_CLOCK, IDENTITY_REPOSITORY, SESSION_AUDIT } from './ports.js';
import type { Clock, IdentityRepository, SessionAuditPort } from './ports.js';
import { isUsable } from '../domain/tenant-membership.js';
import type { TenantMembership } from '../domain/tenant-membership.js';
import { canSignIn } from '../domain/user.js';
import type { User } from '../domain/user.js';

export interface RecordSessionTenantInput {
  readonly subject: string;
  readonly tenantId: string;
  /** `start`: instituição ativada ao entrar (`auth.session_start`); `switch`: troca (US-093). */
  readonly kind: 'start' | 'switch';
  readonly selection: TenantSelection;
  readonly firstLogin: boolean;
  readonly fromTenantId: string | null;
  readonly amr: readonly string[];
  readonly sessionIdHash: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface RecordSessionTenantResult {
  readonly user: User;
  readonly membership: TenantMembership;
  readonly readOnly: boolean;
  readonly memberships: readonly TenantMembership[];
}

/**
 * `RecordSessionTenantCommand` (US-087 · passo 10 · RN-IAM-17): confere que o vínculo com a
 * instituição escolhida é utilizável (RN-IAM-08), registra o acesso ao vínculo (RN-IAM-16) e grava
 * `auth.session_start` na própria instituição. Vínculo inexistente/inativo → 403
 * `MEMBERSHIP_INACTIVE`; instituição indisponível → 403 `TENANT_SUSPENDED`.
 */
@Injectable()
export class RecordSessionTenantCommand {
  constructor(
    @Inject(IDENTITY_REPOSITORY) private readonly identities: IdentityRepository,
    @Inject(SESSION_AUDIT) private readonly audit: SessionAuditPort,
    @Inject(IDENTITY_CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: RecordSessionTenantInput): Promise<RecordSessionTenantResult> {
    const now = this.clock();
    const user = await this.identities.findUserBySubject(input.subject);
    if (!user) throw new ApiError('MEMBERSHIP_INACTIVE');
    if (!canSignIn(user)) throw blockedUserError();

    const memberships = await this.identities.listMemberships(user.id);
    const membership = memberships.find((candidate) => candidate.tenant.id === input.tenantId);
    if (!membership) throw new ApiError('MEMBERSHIP_INACTIVE');
    const access = isUsable(membership, now);
    if (!access.usable) throw new ApiError(access.reason);

    const scope = { tenantId: input.tenantId, userId: user.id, membershipId: membership.id };
    await runWithTenantScope(scope, async () => {
      await this.identities.touchMembershipAccess(input.tenantId, membership.id, now);
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
        : this.audit.tenantSwitched({ ...entry, fromTenantId: input.fromTenantId }));
    });
    return { user, membership, readOnly: access.readOnly, memberships };
  }
}

/** Usuário bloqueado pela plataforma (V-05): 403 `PERMISSION_DENIED` — ver Lacuna 6. */
export function blockedUserError(): ApiError {
  return new ApiError('PERMISSION_DENIED', {
    detail: 'Seu acesso ao ContrataFlow está bloqueado. Procure o suporte da sua instituição.',
    extensions: { reason: 'USER_BLOCKED' },
  });
}
