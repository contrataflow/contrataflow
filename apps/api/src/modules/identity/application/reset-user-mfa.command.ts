import { MEMBERSHIP_INVALID_STATE_MESSAGE, MFA_RESET_SELF_MESSAGE } from '@contrataflow/validation';
import type { MfaResetResult } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { MembershipReferences } from '#shared/auth/membership-references.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { ApiError } from '#shared/errors/api-error.js';

import { AuthentikUnavailableError } from './invitation-ports.js';
import { MembershipCommand } from './invitation.commands.js';
import { MEMBERSHIP_REPOSITORY } from './membership-ports.js';
import type { MembershipRepository } from './membership-ports.js';
import {
  AUTHENTIK_MFA,
  IDENTITY_CLOCK,
  IDENTITY_REPOSITORY,
  IDENTITY_TENANT_TRANSACTIONS,
  TENANT_MFA_POLICY,
} from './ports.js';
import type {
  AuthentikAccountRef,
  AuthentikMfaPort,
  Clock,
  IdentityRepository,
  IdentityTenantTransactions,
  TenantMfaPolicyPort,
} from './ports.js';
import { canResetMfa } from '../domain/membership-lifecycle.js';

/** Mensagem da story para o Authentik fora do ar (Casos de erro). */
export const AUTHENTIK_MFA_UNAVAILABLE_DETAIL =
  'O serviço de autenticação está indisponível. Tente novamente em instantes.';

/** Tentativas da chamada ao Authentik (a remoção é idempotente — repetir é seguro). */
const RESET_ATTEMPTS = 2;

/**
 * `ResetUserMfaCommand` — USR-13 (US-090 · RN-IAM-43/44), na ordem: `USER_MANAGE` (+ MFA do
 * administrador pela política — POL-14) → vínculo do usuário no tenant (404 `USER_NOT_FOUND`,
 * RLS) → autoproteção (422 `VALIDATION_ERROR`/`NOT_ALLOWED`) → vínculo não revogado (409
 * `INVALID_STATE`) → remoção dos fatores no Authentik FORA de transação, com nova tentativa
 * (falha → 503 `DEPENDENCY_UNAVAILABLE`) → auditoria `membership.mfa_reset` (`SECURITY`) numa
 * transação própria do tenant. Sem escrita local além da auditoria e sem evento de domínio: o
 * status de MFA vive no Authentik e no `amr` do token. Redefinições repetidas antes do novo
 * cadastro concluem normalmente (Duplicidade). Se a auditoria falhar depois da remoção, o erro
 * sobe (503) e a repetição pelo administrador — idempotente — grava o registro.
 */
@Injectable()
export class ResetUserMfaCommand extends MembershipCommand {
  constructor(
    references: MembershipReferences,
    @Inject(TENANT_MFA_POLICY) mfaPolicies: TenantMfaPolicyPort,
    @Inject(IDENTITY_CLOCK) clock: Clock,
    @Inject(MEMBERSHIP_REPOSITORY) private readonly memberships: MembershipRepository,
    @Inject(IDENTITY_REPOSITORY) private readonly users: IdentityRepository,
    @Inject(IDENTITY_TENANT_TRANSACTIONS)
    private readonly transactions: IdentityTenantTransactions,
    @Inject(AUTHENTIK_MFA) private readonly authentik: AuthentikMfaPort,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
  ) {
    super(references, mfaPolicies, clock);
  }

  async execute(input: {
    readonly userId: string;
    readonly reason: string;
  }): Promise<MfaResetResult> {
    await this.authorize('USER_MANAGE');
    const context = requireRequestContext();
    const target = await this.transactions.read(async (tx) => {
      const state = await this.memberships.findStateByUser(tx, input.userId);
      if (!state) throw new ApiError('USER_NOT_FOUND', { detail: 'Usuário não encontrado.' });
      const isSelf = state.id === context.actor.membershipId;
      if (isSelf) {
        throw new ApiError('VALIDATION_ERROR', {
          detail: MFA_RESET_SELF_MESSAGE,
          errors: [{ field: 'userId', code: 'NOT_ALLOWED', message: MFA_RESET_SELF_MESSAGE }],
        });
      }
      if (!canResetMfa(state.status, isSelf)) {
        throw new ApiError('INVALID_STATE', { detail: MEMBERSHIP_INVALID_STATE_MESSAGE });
      }
      const user = await this.users.findUserInTransaction(tx, input.userId);
      return {
        membershipId: state.id,
        account: {
          authentikUserId: user?.authentikUserId ?? null,
          externalSubject: user?.externalSubject ?? null,
        },
      };
    });

    const { removedDevices } = await this.removeFactors(input.userId, target.account);
    const resetAt = this.clock();
    await this.transactions.run((tx) =>
      this.audit.record(tx, {
        action: 'membership.mfa_reset',
        entityType: 'TenantMembership',
        entityId: target.membershipId,
        metadata: { targetUserId: input.userId, reason: input.reason },
      }),
    );
    this.logger.log(
      {
        event: 'identity.mfa_reset',
        targetUserId: input.userId,
        actorUserId: context.actor.userId,
        removedDevices,
        tenantId: context.tenantId,
        correlationId: context.correlationId,
      },
      'identity.mfa_reset',
    );
    return { userId: input.userId, resetAt: resetAt.toISOString() };
  }

  private async removeFactors(
    userId: string,
    account: AuthentikAccountRef,
  ): Promise<{ readonly removedDevices: number }> {
    let failure: AuthentikUnavailableError | null = null;
    for (let attempt = 1; attempt <= RESET_ATTEMPTS; attempt += 1) {
      try {
        return await this.authentik.resetMfa(account);
      } catch (error) {
        if (!(error instanceof AuthentikUnavailableError)) throw error;
        failure = error;
      }
    }
    this.logger.warn(
      {
        event: 'identity.mfa_reset_failed',
        targetUserId: userId,
        attempts: RESET_ATTEMPTS,
        errorName: failure?.cause instanceof Error ? failure.cause.name : 'unknown',
        correlationId: requireRequestContext().correlationId,
      },
      'identity.mfa_reset_failed',
    );
    throw new ApiError('DEPENDENCY_UNAVAILABLE', {
      detail: AUTHENTIK_MFA_UNAVAILABLE_DETAIL,
      headers: { 'Retry-After': '30' },
      cause: failure,
    });
  }
}
