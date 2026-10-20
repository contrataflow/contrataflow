import { Inject, Injectable, Logger } from '@nestjs/common';

import type { VerifiedToken } from '#shared/auth/ports.js';

import { AUTHENTIK_DIRECTORY, IDENTITY_CLOCK, IDENTITY_REPOSITORY } from './ports.js';
import type { AuthentikDirectoryPort, Clock, IdentityRepository } from './ports.js';
import type { TenantMembership } from '../domain/tenant-membership.js';
import { canSignIn, maskEmail } from '../domain/user.js';
import type { User } from '../domain/user.js';

export type StartSessionResult =
  | {
      readonly kind: 'started';
      readonly user: User;
      /** O `sub` foi vinculado nesta chamada (RN-IAM-06). */
      readonly firstLogin: boolean;
      readonly memberships: readonly TenantMembership[];
    }
  /** Nenhum `User` corresponde ao `sub` — cadastro público desativado: "sem vínculo". */
  | { readonly kind: 'unknown_user' }
  /** `User.status` `BLOCKED`/`DEACTIVATED` (RN-IAM-07). */
  | { readonly kind: 'blocked' };

/**
 * `StartSessionCommand` (US-087 · fluxo principal, passo 7): resolve o `User` pelo `sub`, faz o
 * vínculo do primeiro login (RN-IAM-06), confere o status (RN-IAM-07), atualiza `lastLoginAt`
 * (RN-IAM-16) e devolve os vínculos com o status de cada instituição. Nenhum `User` é criado.
 */
@Injectable()
export class StartSessionCommand {
  private readonly logger = new Logger('Identity');

  constructor(
    @Inject(IDENTITY_REPOSITORY) private readonly identities: IdentityRepository,
    @Inject(AUTHENTIK_DIRECTORY) private readonly authentik: AuthentikDirectoryPort,
    @Inject(IDENTITY_CLOCK) private readonly clock: Clock,
  ) {}

  async execute(token: VerifiedToken): Promise<StartSessionResult> {
    const now = this.clock();
    const bound = await this.identities.findUserBySubject(token.subject);
    const user = bound ?? (await this.findUnboundCandidate(token));
    if (!user) {
      this.logger.warn({ event: 'identity.subject_unmatched' }, 'identity.subject_unmatched');
      return { kind: 'unknown_user' };
    }
    if (!canSignIn(user)) {
      this.logger.warn(
        { event: 'auth.login_blocked', userId: user.id, status: user.status },
        'auth.login_blocked',
      );
      return { kind: 'blocked' };
    }

    let record = await this.identities.recordLogin(user.id, now, bound ? null : token.subject);
    if (record.kind === 'subject_conflict') {
      // Corrida de dois primeiros logins: vale o vínculo que o banco aceitou, se for desta pessoa.
      const winner = await this.identities.findUserBySubject(token.subject);
      if (winner?.id !== user.id) {
        this.logger.warn(
          { event: 'identity.subject_conflict', userId: user.id },
          'identity.subject_conflict',
        );
        return { kind: 'unknown_user' };
      }
      record = await this.identities.recordLogin(user.id, now, null);
    }
    const firstLogin = record.kind === 'recorded' && record.bound;
    if (firstLogin) {
      this.logger.log(
        { event: 'identity.subject_bound', userId: user.id },
        'identity.subject_bound',
      );
    }
    const memberships = await this.identities.listMemberships(user.id);
    return { kind: 'started', user, firstLogin, memberships };
  }

  /**
   * Primeiro login (RN-IAM-06): `User` sem `sub` cujo `authentikUserId` é o usuário do Authentik
   * identificado pelo `sub` (confirmado pela API do Authentik); na ausência de `authentikUserId`,
   * o e-mail verificado — só se houver vínculo `INVITED` ou `ACTIVE`.
   */
  private async findUnboundCandidate(token: VerifiedToken): Promise<User | null> {
    const authentikUserId = await this.authentik.findUserPkBySubject(token.subject);
    if (authentikUserId !== null) {
      const invited = await this.identities.findUnboundUserByAuthentikId(authentikUserId);
      if (invited) return invited;
    }
    if (token.email === null || !token.emailVerified) return null;
    const candidate = await this.identities.findUnboundUserByEmail(token.email);
    if (!candidate) return null;
    const memberships = await this.identities.listMemberships(candidate.id);
    const invited = memberships.some(
      (membership) => membership.status === 'INVITED' || membership.status === 'ACTIVE',
    );
    if (!invited) {
      this.logger.warn(
        { event: 'identity.email_match_without_membership', email: maskEmail(token.email) },
        'identity.email_match_without_membership',
      );
      return null;
    }
    return candidate;
  }
}
