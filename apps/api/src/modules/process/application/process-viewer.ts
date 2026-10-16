import type { PermissionCode } from '@contrataflow/types';
import { Injectable } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import type {
  EngineViewer,
  ProcessActionPermission,
} from '../../workflow/application/workflow.facade.js';
import type { ProcessViewer } from '../domain/process-visibility.js';

/** Permissões de ação consultadas para montar o catálogo (omitidas sem nenhum escopo). */
const ACTION_PERMISSIONS: readonly ProcessActionPermission[] = [
  'PROCESS_FORWARD',
  'PROCESS_RETURN',
  'PROCESS_COMPLETE',
  'PROCESS_CLAIM',
  'PROCESS_ASSIGN',
  'PROCESS_CANCEL',
  'PROCESS_SUSPEND',
];

/** Quem consulta: visibilidade (DEC-024) e o que o motor precisa para as ações (POL-01/04/05). */
export interface ResolvedViewer {
  readonly visibility: ProcessViewer;
  readonly engine: EngineViewer;
}

/**
 * Resolve o usuário da requisição no `tx` da consulta: perfis do contexto (ponte até as permissões
 * efetivas — US-097), lotações (`identity`) e chefias (`organization`).
 */
@Injectable()
export class ProcessViewerResolver {
  constructor(
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
    private readonly organization: OrganizationFacade,
  ) {}

  async resolve(tx: TenantTx): Promise<ResolvedViewer> {
    const context = requireRequestContext();
    const userId = context.actor.userId;
    if (userId === null) throw new ApiError('UNAUTHENTICATED');
    const roleKeys = context.roleKeys ?? [];
    const grants = (permission: PermissionCode) => this.access.rolesGrant(roleKeys, permission);
    const wholeTenant = this.access.rolesCoverAllDepartments(roleKeys);
    // Em sequência: a transação interativa executa uma consulta por vez.
    const departmentIds = await this.identity.departmentsOfUser(tx, userId);
    const headOfDepartmentIds = await this.organization.departmentsHeadedBy(tx, userId);
    return {
      visibility: {
        userId,
        hasProcessView: grants('PROCESS_VIEW'),
        viewsWholeTenant: wholeTenant,
        departmentIds,
      },
      engine: {
        userId,
        departmentIds,
        headOfDepartmentIds,
        permissions: new Set(ACTION_PERMISSIONS.filter(grants)),
        canAssignAnywhere: wholeTenant && grants('PROCESS_ASSIGN'),
      },
    };
  }
}
