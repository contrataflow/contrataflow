import {
  dataEnvelope,
  permissionListQuerySchema,
  permissionSchema,
} from '@contrataflow/validation';
import type { PermissionDto, PermissionListQuery } from '@contrataflow/validation';
import { Controller, Get } from '@nestjs/common';
import { z } from 'zod';

import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import { ListPermissionsQuery } from '../application/list-permissions.query.js';

/** ROL-01 (api/14-tenant-administration.md · US-094): catálogo de permissões. */
@Controller('permissions')
@TenantScope('TENANT')
export class PermissionController {
  constructor(private readonly list: ListPermissionsQuery) {}

  @Get()
  @ApiOperation({
    operationId: 'ROL-01',
    summary: 'Listar o catálogo de permissões',
    tags: ['Perfis e permissões'],
    responses: {
      200: {
        description:
          'Catálogo global de permissões (o mesmo para todos os tenants), com filtros opcionais `module` e `riskLevel` — valor desconhecido é ignorado.',
        schema: dataEnvelope(z.array(permissionSchema)),
      },
    },
  })
  listPermissions(
    @ZodQuery(permissionListQuerySchema) query: PermissionListQuery,
  ): PermissionDto[] {
    return this.list.execute(query);
  }
}
