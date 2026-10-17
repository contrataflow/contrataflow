import type { PermissionCode } from '@contrataflow/types';
import { Injectable } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { AccessFacade } from '../../access/application/access.facade.js';
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
  'PROCESS_UPDATE',
  'PROCESS_DUPLICATE',
  'PROCESS_CREATE',
];

/** Quem consulta: visibilidade (DEC-024) e o que o motor precisa para as ações (POL-01/04/05). */
export interface ResolvedViewer {
  readonly visibility: ProcessViewer;
  readonly engine: EngineViewer;
}

/**
 * Resolve o usuário da requisição pelas permissões efetivas (US-097 — perfis com escopo e
 * vigência, em cache): escopo de visibilidade, lotações e chefias (custódia e POL-05) e as
 * permissões de ação. O `tx` é o da consulta (o retrato já está no contexto, carregado pelo guard).
 */
@Injectable()
export class ProcessViewerResolver {
  constructor(private readonly access: AccessFacade) {}

  async resolve(_tx: TenantTx): Promise<ResolvedViewer> {
    const userId = requireRequestContext().actor.userId;
    if (userId === null) throw new ApiError('UNAUTHENTICATED');
    const permissions = await this.access.effectivePermissions();
    const grants = (permission: PermissionCode) => permissions.has(permission);
    return {
      visibility: permissions.visibilityScope(),
      engine: {
        userId,
        departmentIds: [...permissions.snapshot.ownDepartmentIds],
        headOfDepartmentIds: [...permissions.snapshot.headOfDepartmentIds],
        permissions: new Set(ACTION_PERMISSIONS.filter(grants)),
        canAssignAnywhere: permissions.coversTenantWide('PROCESS_ASSIGN'),
      },
    };
  }
}
