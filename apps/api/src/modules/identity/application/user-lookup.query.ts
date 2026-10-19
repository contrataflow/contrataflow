import { DEPARTMENT_MEMBER_LOOKUP_LIMIT, USER_LOOKUP_LIMIT } from '@contrataflow/validation';
import type { UserLookupItem, UserLookupQuery as UserLookupParams } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { INVITATION_REPOSITORY } from './invitation-ports.js';
import type { InvitationRepository } from './invitation-ports.js';
import { IDENTITY_CLOCK, IDENTITY_TENANT_TRANSACTIONS } from './ports.js';
import type { Clock, IdentityTenantTransactions } from './ports.js';
import { displayName } from '../domain/user.js';

/**
 * `UserLookupQuery` — USR-02 (capacidade implícita: vínculo ativo no tenant): pessoas para
 * seletores (US-012 — participantes do processo). Só vínculos `ACTIVE` e não vencidos, sem contas
 * de serviço, por nome; `membershipType`/`membershipExpiresAt` orientam o papel Consultor
 * (RN-PROC-127). A mesma busca por nome/e-mail da lista de usuários (USR-01).
 */
@Injectable()
export class UserLookupQuery {
  constructor(
    @Inject(INVITATION_REPOSITORY) private readonly memberships: InvitationRepository,
    @Inject(IDENTITY_TENANT_TRANSACTIONS) private readonly transactions: IdentityTenantTransactions,
    @Inject(IDENTITY_CLOCK) private readonly clock: Clock,
  ) {}

  async execute(query: UserLookupParams): Promise<UserLookupItem[]> {
    const now = this.clock();
    // US-050: com `departmentId`, os lotados na unidade (membros do diálogo de atribuição).
    const limit =
      query.departmentId === undefined ? USER_LOOKUP_LIMIT : DEPARTMENT_MEMBER_LOOKUP_LIMIT;
    const page = await this.transactions.read((tx) =>
      this.memberships.listTenantMemberships(tx, {
        q: query.q,
        departmentId: query.departmentId,
        statuses: ['ACTIVE'],
        offset: 0,
        // Folga para os vencidos e os de serviço filtrados abaixo.
        limit: limit * 2,
      }),
    );
    return page.items
      .filter(
        (view) =>
          view.type !== 'SERVICE' &&
          (view.expiresAt === null || view.expiresAt.getTime() > now.getTime()),
      )
      .map((view): UserLookupItem => ({
        id: view.userId,
        name: displayName(view),
        email: view.email,
        membershipType: view.type === 'EXTERNAL' ? 'EXTERNAL' : 'INTERNAL',
        membershipExpiresAt: view.expiresAt?.toISOString() ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
      .slice(0, limit);
  }
}
