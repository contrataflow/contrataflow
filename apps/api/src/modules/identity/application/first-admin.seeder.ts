import { UserInvited } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { runAsSystem } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';
import type {
  FirstAdminInvitation,
  FirstAdminInvitationPort,
  TenantSeedContext,
  TenantSeeder,
  TenantSeedResult,
  TenantSeedStatus,
} from '#shared/tenancy/tenant-seeding.js';

import { FIRST_ADMIN_STORE, IDENTITY_CLOCK, IDENTITY_TENANT_TRANSACTIONS } from './ports.js';
import type {
  Clock,
  FirstAdminStore,
  IdentityTenantTransactions,
  InternalMember,
} from './ports.js';
import { inviteExpiryFrom } from '../domain/invitation.js';

const INVITATION_ACTOR = 'Convite do primeiro administrador';

/**
 * Seeder `identity.firstAdmin` (US-099 · fluxo principal, passo 7 · RN-TEN-08/14 · FA-10): reutiliza
 * ou cria o `User` pelo e-mail (identidade global — nada do outro tenant é lido) e cria o vínculo
 * `INTERNAL` `INVITED`, ainda sem token, no tenant novo. Nunca cria vínculo para o operador.
 *
 * O envio (`dispatch`, depois da ativação do tenant — e o `tenant:resend-invite`) é o mesmo do
 * convite da US-091: validade de 7 dias, hash zerado, `membership.invite` e `UserInvited` no
 * outbox, que o worker transforma no e-mail com o link (fila `email`). Pendência: o perfil
 * `ADMIN_ORGAO` no escopo `TENANT` do primeiro administrador entra com a gestão de atribuições
 * (US-096).
 */
@Injectable()
export class FirstAdminSeeder implements TenantSeeder, FirstAdminInvitationPort {
  readonly key = 'identity.firstAdmin';
  readonly module = 'identity';
  readonly version = '2026.10.1';
  readonly dependsOn: readonly string[] = ['access.defaultRoles'];
  /** Depende dos dados do provisionamento: não se aplica a tenants existentes (FA-08). */
  readonly applyToExistingTenants = false;

  constructor(
    @Inject(FIRST_ADMIN_STORE) private readonly store: FirstAdminStore,
    @Inject(IDENTITY_TENANT_TRANSACTIONS) private readonly transactions: IdentityTenantTransactions,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    @Inject(IDENTITY_CLOCK) private readonly clock: Clock,
  ) {}

  async seed(ctx: TenantSeedContext): Promise<TenantSeedResult> {
    const admin = ctx.request?.firstAdmin;
    if (!admin) throw new Error('identity.firstAdmin exige os dados do provisionamento.');
    const user = await this.store.findOrCreateUser({
      id: newId(),
      email: admin.email,
      name: admin.name,
      now: ctx.now,
    });
    const membershipCreated = await this.transactions.run((tx) =>
      this.store.insertInvitedMembership(tx, {
        id: newId(),
        tenantId: ctx.tenantId,
        userId: user.id,
        now: ctx.now,
      }),
    );
    const created = Number(user.created) + Number(membershipCreated);
    return { created, skipped: 2 - created };
  }

  async verify(ctx: TenantSeedContext): Promise<TenantSeedStatus> {
    const members = await this.members();
    const email = ctx.request?.firstAdmin.email;
    const done = email === undefined ? members.length > 0 : hasEmail(members, email);
    return { status: done ? 'DONE' : 'PENDING', details: { memberships: members.length } };
  }

  describe(tenantId: string): Promise<FirstAdminInvitation | null> {
    return runAsSystem({ name: INVITATION_ACTOR, tenantId }, async () => {
      const [first] = await this.members();
      return first ? toInvitation(first, first.invitedAt !== null) : null;
    });
  }

  /**
   * RN-TEN-08: (re)envia o convite do administrador ainda `INVITED`; vínculo já ativo não recebe
   * nada. Falha de banco propaga (o tenancy registra e devolve a situação atual).
   */
  dispatch(tenantId: string): Promise<FirstAdminInvitation | null> {
    return runAsSystem({ name: INVITATION_ACTOR, tenantId }, () =>
      this.transactions.run(async (tx) => {
        const [first] = await this.store.internalMembers(tx);
        if (!first) return null;
        if (first.status !== 'INVITED') return toInvitation(first, first.invitedAt !== null);
        const now = this.clock();
        const inviteExpiresAt = inviteExpiryFrom(now);
        const renewed = await this.store.renewInvitation(tx, {
          membershipId: first.membershipId,
          now,
          inviteExpiresAt,
        });
        if (!renewed) return toInvitation(first, first.invitedAt !== null);
        await this.audit.record(tx, {
          action: 'membership.invite',
          entityType: 'TenantMembership',
          entityId: first.membershipId,
          metadata: {
            type: 'INTERNAL',
            firstAdmin: true,
            inviteExpiresAt: inviteExpiresAt.toISOString(),
            resend: first.invitedAt !== null,
          },
        });
        await this.outbox.record(
          tx,
          UserInvited.of({
            aggregateId: first.membershipId,
            payload: {
              membershipId: first.membershipId,
              userId: first.userId,
              type: 'INTERNAL',
              inviteExpiresAt: inviteExpiresAt.toISOString(),
              resend: first.invitedAt !== null,
            },
          }),
        );
        return toInvitation(first, true);
      }),
    );
  }

  private members(): Promise<InternalMember[]> {
    return this.transactions.read((tx) => this.store.internalMembers(tx));
  }
}

function toInvitation(member: InternalMember, dispatched: boolean): FirstAdminInvitation {
  return { email: member.email, membershipStatus: member.status, invitationDispatched: dispatched };
}

function hasEmail(members: readonly InternalMember[], email: string): boolean {
  return members.some((member) => member.email.toLowerCase() === email.toLowerCase());
}
