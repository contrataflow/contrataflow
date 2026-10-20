import type { RoleDto, RoleListQuery, RoleWithPermissionsDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { ACCESS_TRANSACTIONS, ROLE_ASSIGNMENT_COUNTER, ROLE_REPOSITORY } from './ports.js';
import type { AccessTransactions, RoleAssignmentCounter, RoleRepository } from './ports.js';
import { authorizeActor, RoleActorResolver } from './role-actor.js';
import { roleNotFound, toRoleDto } from './role.errors.js';

/**
 * `ListRolesQuery` — ROL-02 (US-095 · RN-IAM-79): perfis do tenant (os 15 padrão primeiro, depois
 * por nome) com a contagem de vínculos ativos; filtros `search` e `isActive`. Exige `ROLE_VIEW`
 * (risco baixo, sem MFA).
 */
@Injectable()
export class ListRolesQuery {
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(ROLE_ASSIGNMENT_COUNTER) private readonly assignments: RoleAssignmentCounter,
    @Inject(ACCESS_TRANSACTIONS) private readonly transactions: AccessTransactions,
    private readonly actors: RoleActorResolver,
  ) {}

  execute(query: RoleListQuery): Promise<RoleDto[]> {
    return this.transactions.read(async (tx) => {
      authorizeActor(await this.actors.resolve(tx), 'ROLE_VIEW', 'NONE');
      const roles = await this.roles.list(tx, {
        ...(query.search ? { search: query.search } : {}),
        ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      });
      const counts = await this.assignments.countActive(
        tx,
        roles.map((role) => role.id),
      );
      return roles.map((role) => toRoleDto(role, counts.get(role.id) ?? 0));
    });
  }
}

/** `GetRoleQuery` — ROL-04: perfil com a matriz; outro tenant e inexistente → 404 `ROLE_NOT_FOUND`. */
@Injectable()
export class GetRoleQuery {
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(ROLE_ASSIGNMENT_COUNTER) private readonly assignments: RoleAssignmentCounter,
    @Inject(ACCESS_TRANSACTIONS) private readonly transactions: AccessTransactions,
    private readonly actors: RoleActorResolver,
  ) {}

  execute(id: string): Promise<RoleWithPermissionsDto> {
    return this.transactions.read(async (tx) => {
      authorizeActor(await this.actors.resolve(tx), 'ROLE_VIEW', 'NONE');
      const role = await this.roles.findById(tx, id);
      if (!role) throw roleNotFound();
      const counts = await this.assignments.countActive(tx, [role.id]);
      return toRoleDto(role, counts.get(role.id) ?? 0, await this.roles.permissionsOf(tx, role.id));
    });
  }
}
