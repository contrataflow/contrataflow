import { dataEnvelope, myPermissionsSchema } from '@contrataflow/validation';
import type { MyPermissionsDto } from '@contrataflow/validation';
import { Controller, Get } from '@nestjs/common';

import { ImplicitAccess } from '#shared/auth/authorization.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';

import { GetMyPermissionsHandler } from '../application/get-my-permissions.query.js';

/** ME-03 (api/01-session-me.md · US-097): permissões efetivas do usuário no tenant ativo. */
@Controller('me')
@TenantScope('TENANT')
export class MyPermissionsController {
  constructor(private readonly myPermissions: GetMyPermissionsHandler) {}

  @Get('permissions')
  @ImplicitAccess(
    'Capacidade implícita (permissions.md §7): qualquer vínculo ativo vê as próprias permissões.',
  )
  @ApiOperation({
    operationId: 'ME-03',
    summary: 'Obter permissões efetivas do usuário',
    tags: ['Sessão e perfil'],
    responses: {
      200: {
        description:
          'Permissões efetivas do vínculo ativo por escopo (`TENANT`/`ORGANIZATION`/`DEPARTMENT`/`OWN_DEPARTMENTS`, com subárvore) e as capacidades implícitas (`headOfDepartmentIds`). Fonte única dos hooks de permissão do frontend — a decisão continua sendo da API.',
        schema: dataEnvelope(myPermissionsSchema),
      },
    },
  })
  getMyPermissions(): Promise<MyPermissionsDto> {
    return this.myPermissions.execute();
  }
}
