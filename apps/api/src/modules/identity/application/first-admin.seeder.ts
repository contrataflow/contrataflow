import { Inject, Injectable } from '@nestjs/common';

import { runAsSystem } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type {
  FirstAdminInvitation,
  FirstAdminInvitationPort,
  TenantSeedContext,
  TenantSeeder,
  TenantSeedResult,
  TenantSeedStatus,
} from '#shared/tenancy/tenant-seeding.js';

import { FIRST_ADMIN_STORE, IDENTITY_TENANT_TRANSACTIONS } from './ports.js';
import type { FirstAdminStore, IdentityTenantTransactions, InternalMember } from './ports.js';

const INVITATION_ACTOR = 'Convite do primeiro administrador';

/**
 * Seeder `identity.firstAdmin` (US-099 · fluxo principal, passo 7 · RN-TEN-08/14 · FA-10): reutiliza
 * ou cria o `User` pelo e-mail (identidade global — nada do outro tenant é lido) e cria o vínculo
 * `INTERNAL` `INVITED`, ainda sem token, no tenant novo. Nunca cria vínculo para o operador.
 *
 * Pendências de stories seguintes: o perfil `ADMIN_ORGAO` no escopo `TENANT` entra quando existir
 * `role_assignments` (US-096); o token e o e-mail do convite, com a fachada de convite (US-091) e
 * os e-mails transacionais (US-112) — até lá `dispatch` informa `invitationDispatched = false` e o
 * operador reenvia com `tenant:resend-invite` quando o envio existir.
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
      return first
        ? { email: first.email, membershipStatus: first.status, invitationDispatched: false }
        : null;
    });
  }

  /** Sem a fachada de convite (US-091) não há token nem e-mail: nada é enfileirado ainda. */
  dispatch(tenantId: string): Promise<FirstAdminInvitation | null> {
    return this.describe(tenantId);
  }

  private members(): Promise<InternalMember[]> {
    return this.transactions.read((tx) => this.store.internalMembers(tx));
  }
}

function hasEmail(members: readonly InternalMember[], email: string): boolean {
  return members.some((member) => member.email.toLowerCase() === email.toLowerCase());
}
