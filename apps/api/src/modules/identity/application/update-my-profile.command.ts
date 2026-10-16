import { PROFILE_PREFERENCE_UNKNOWN_MESSAGE } from '@contrataflow/validation';
import type { MyProfileDto, UpdateMyProfile } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { MembershipReferences } from '#shared/auth/membership-references.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import { MEMBERSHIP_REPOSITORY } from './membership-ports.js';
import type { MembershipRepository } from './membership-ports.js';
import { toMyProfile } from './my-profile.view.js';
import { IDENTITY_REPOSITORY, IDENTITY_TENANT_TRANSACTIONS } from './ports.js';
import type { IdentityRepository, IdentityTenantTransactions } from './ports.js';
import {
  InvalidPreferenceValueError,
  UnknownPreferenceKeysError,
  updateProfile,
} from '../domain/user.js';

export interface UpdateMyProfileInput {
  readonly patch: UpdateMyProfile;
  /** Versão do `If-Match` (DEC-104 · RN-IAM-112). */
  readonly expectedVersion: number;
}

function versionConflict(currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: 'Seus dados foram atualizados em outra aba. Recarregue.',
    extensions: { currentVersion },
  });
}

/**
 * `UpdateMyProfileCommand` — ME-02 (US-098): atualiza nome, nome social, telefone e preferências do
 * próprio `User` (RN-IAM-109..111), com `If-Match` (RN-IAM-112) e o `AuditLog` `profile.update`
 * (RN-IAM-113) na mesma transação. Capacidade implícita: sem permissão nem MFA. Nada alterado →
 * 200 sem nova versão nem auditoria.
 */
@Injectable()
export class UpdateMyProfileCommand {
  private readonly logger = new Logger('Identity');

  constructor(
    @Inject(IDENTITY_REPOSITORY) private readonly identities: IdentityRepository,
    @Inject(MEMBERSHIP_REPOSITORY) private readonly memberships: MembershipRepository,
    @Inject(IDENTITY_TENANT_TRANSACTIONS) private readonly transactions: IdentityTenantTransactions,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    private readonly references: MembershipReferences,
  ) {}

  async execute(input: UpdateMyProfileInput): Promise<MyProfileDto> {
    const context = requireRequestContext();
    const userId = context.actor.userId;
    if (!userId) throw new ApiError('UNAUTHENTICATED');

    const { profile, changed } = await this.transactions.run(async (tx) => {
      const user = await this.identities.findUserInTransaction(tx, userId);
      if (!user) throw new ApiError('UNAUTHENTICATED');
      if (user.version !== input.expectedVersion) throw versionConflict(user.version);

      let update;
      try {
        update = updateProfile(user, input.patch);
      } catch (error) {
        throw translate(error);
      }
      if (update.changes.length === 0) {
        const unchanged = await toMyProfile(tx, user, this.memberships, this.references);
        return { profile: unchanged, changed: false };
      }

      const saved = await this.identities.saveProfile(tx, userId, user.version, update);
      if (!saved) {
        // Corrida com outra aba entre a leitura e a gravação: a versão vencedora volta no erro.
        const latest = await this.identities.findUserInTransaction(tx, userId);
        throw versionConflict(latest?.version ?? user.version + 1);
      }
      await this.audit.record(tx, {
        action: 'profile.update',
        entityType: 'User',
        entityId: userId,
        changes: update.changes,
      });
      const next = await toMyProfile(
        tx,
        { ...user, ...update, version: user.version + 1 },
        this.memberships,
        this.references,
      );
      return { profile: next, changed: true };
    });

    if (changed) {
      this.logger.log(
        { event: 'profile.updated', userId, correlationId: context.correlationId },
        'profile.updated',
      );
    }
    return profile;
  }
}

function translate(error: unknown): unknown {
  if (error instanceof UnknownPreferenceKeysError) {
    return new ApiError('SETTING_KEY_UNKNOWN', {
      detail: PROFILE_PREFERENCE_UNKNOWN_MESSAGE,
      extensions: { keys: [...error.keys] },
    });
  }
  if (error instanceof InvalidPreferenceValueError) {
    return validationError(
      error.keys.map((key) => ({
        field: `preferences.${key}`,
        code: 'INVALID_ENUM' as const,
        message: 'Valor de preferência inválido.',
      })),
    );
  }
  return error;
}
