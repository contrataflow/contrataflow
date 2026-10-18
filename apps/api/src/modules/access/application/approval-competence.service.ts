import { Inject, Injectable } from '@nestjs/common';

import { MembershipReferences } from '#shared/auth/membership-references.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { ROLE_ASSIGNMENT_REPOSITORY, ROLE_REPOSITORY } from './ports.js';
import type { RoleAssignmentRepository, RoleRepository } from './ports.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import {
  competenceSubtreeRoots,
  scopeCoversRequestingUnits,
} from '../domain/approval-competence.js';
import type { RequestingUnits } from '../domain/approval-competence.js';
import { isEffective } from '../domain/role-assignment.js';

/**
 * Detentores de um perfil aprovador com competência sobre o processo (US-051 · RN-TRAM-47/49 ·
 * DEC-022): atribuições gravadas, vigentes, do perfil ATIVO, de vínculos `ACTIVE` não vencidos, cujo
 * escopo cubra as unidades solicitantes (`scopeCoversRequestingUnits`). Lido no `tx` do chamador —
 * a RLS limita tudo ao tenant da transação, então nenhum detentor de outro tenant é encontrado. A
 * ponte por chave do registro (vínculo sem atribuição gravada — modo fake) não designa aprovador.
 */
@Injectable()
export class ApprovalCompetenceService {
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(ROLE_ASSIGNMENT_REPOSITORY) private readonly assignments: RoleAssignmentRepository,
    private readonly identity: IdentityFacade,
    private readonly references: MembershipReferences,
  ) {}

  /** Usuários competentes, em ordem estável; vazio = perfil sem detentor no escopo. */
  async roleHolders(
    tx: TenantTx,
    roleId: string,
    target: RequestingUnits,
    now: Date,
  ): Promise<string[]> {
    const role = await this.roles.findById(tx, roleId);
    if (!role?.isActive) return [];
    const effective = (await this.assignments.listByRole(tx, roleId)).filter((assignment) =>
      isEffective(assignment, now),
    );
    if (effective.length === 0) return [];
    const users = await this.identity.membershipUserIds(tx, [
      ...new Set(effective.map((assignment) => assignment.membershipId)),
    ]);
    const members = await this.identity.membersInTenant(tx, [...new Set(users.values())]);
    const activeMemberships = new Set(
      members
        .filter(
          (member) =>
            member.status === 'ACTIVE' &&
            (member.expiresAt === null || member.expiresAt.getTime() > now.getTime()),
        )
        .map((member) => member.membershipId),
    );
    const candidates = effective.flatMap((assignment) => {
      const userId = users.get(assignment.membershipId);
      return userId !== undefined && activeMemberships.has(assignment.membershipId)
        ? [{ assignment, userId }]
        : [];
    });
    // Lotações só de quem tem `OWN_DEPARTMENTS` (em sequência: a transação interativa executa uma
    // consulta por vez) e TODAS as subárvores numa ida só — orçamento de p95 da US-051.
    const own = new Map<string, readonly string[]>();
    for (const { assignment, userId } of candidates) {
      if (assignment.scopeType !== 'OWN_DEPARTMENTS' || own.has(userId)) continue;
      own.set(userId, await this.identity.departmentsOfUser(tx, userId));
    }
    const roots = [
      ...new Set(
        candidates.flatMap(({ assignment, userId }) =>
          competenceSubtreeRoots(assignment, own.get(userId) ?? []),
        ),
      ),
    ].sort();
    const subtrees =
      roots.length === 0
        ? new Map<string, readonly string[]>()
        : await this.references.subtreeIds(tx, roots);
    const holders = candidates
      .filter(({ assignment, userId }) =>
        scopeCoversRequestingUnits(assignment, target, {
          ownDepartmentIds: own.get(userId) ?? [],
          subtrees,
        }),
      )
      .map(({ userId }) => userId);
    return [...new Set(holders)].sort();
  }
}
