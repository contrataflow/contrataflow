import {
  createRoleSchema,
  dataEnvelope,
  deactivateRoleSchema,
  duplicateRoleSchema,
  roleIdParamsSchema,
  roleListQuerySchema,
  roleSchema,
  roleWithPermissionsSchema,
  updateRolePermissionsSchema,
  updateRoleSchema,
} from '@contrataflow/validation';
import type {
  CreateRole,
  DeactivateRole,
  RoleDto,
  RoleListQuery,
  RoleWithPermissionsDto,
  UpdateRole,
  UpdateRolePermissions,
} from '@contrataflow/validation';
import { Controller, Get, HttpCode, Patch, Post, Put, Res } from '@nestjs/common';
import { z } from 'zod';

import { Policy, RequirePermission } from '#shared/auth/authorization.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import {
  CreateRoleCommand,
  DeactivateRoleCommand,
  DuplicateRoleCommand,
  UpdateRoleCommand,
  UpdateRolePermissionsCommand,
} from '../application/role.commands.js';
import { GetRoleQuery, ListRolesQuery } from '../application/role.queries.js';

const TAGS = ['Perfis e permissões'];

/**
 * ROL-02..08 (api/14-tenant-administration.md · US-095): perfis do tenant e matriz de permissões.
 * `ROLE_VIEW` lê; `ROLE_MANAGE` (+ MFA, POL-14) cria, edita, duplica e desativa — conferidos nos
 * casos de uso com as permissões efetivas do ator, junto de POL-12/13.
 */
@Controller('roles')
@TenantScope('TENANT')
export class RoleController {
  constructor(
    private readonly list: ListRolesQuery,
    private readonly detail: GetRoleQuery,
    private readonly create: CreateRoleCommand,
    private readonly update: UpdateRoleCommand,
    private readonly updatePermissions: UpdateRolePermissionsCommand,
    private readonly duplicate: DuplicateRoleCommand,
    private readonly deactivate: DeactivateRoleCommand,
  ) {}

  @Get()
  @RequirePermission('ROLE_VIEW', { detail: 'Você não tem permissão para gerenciar perfis.' })
  @ApiOperation({
    operationId: 'ROL-02',
    summary: 'Listar perfis',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Perfis do tenant (os 15 padrão primeiro, depois por nome) com a contagem de vínculos ativos; filtros `search` e `isActive`.',
        schema: dataEnvelope(z.array(roleSchema)),
      },
    },
  })
  listRoles(@ZodQuery(roleListQuerySchema) query: RoleListQuery): Promise<RoleDto[]> {
    return this.list.execute(query);
  }

  @Post()
  @RequirePermission('ROLE_MANAGE', { detail: 'Você não tem permissão para gerenciar perfis.' })
  @Policy('POL-13')
  @ApiOperation({
    operationId: 'ROL-03',
    summary: 'Criar perfil',
    tags: TAGS,
    auditActions: ['role.create'],
    responses: {
      201: {
        description: 'Perfil personalizado criado e ativo (`Location` e `ETag: "1"`).',
        schema: dataEnvelope(roleSchema),
      },
    },
  })
  async createRole(
    @ZodBody(createRoleSchema) body: CreateRole,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<RoleDto> {
    return this.created(await this.create.execute(body), response);
  }

  @Get(':id')
  @RequirePermission('ROLE_VIEW', { detail: 'Você não tem permissão para gerenciar perfis.' })
  @ApiOperation({
    operationId: 'ROL-04',
    summary: 'Consultar perfil',
    tags: TAGS,
    responses: {
      200: {
        description: 'Perfil com a matriz de permissões (`ETag` = versão).',
        schema: dataEnvelope(roleWithPermissionsSchema),
      },
    },
  })
  async getRole(
    @ZodParams(roleIdParamsSchema) params: { id: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<RoleWithPermissionsDto> {
    return this.versioned(await this.detail.execute(params.id), response);
  }

  @Patch(':id')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('ROLE_MANAGE', { detail: 'Você não tem permissão para gerenciar perfis.' })
  @ApiOperation({
    operationId: 'ROL-05',
    summary: 'Atualizar perfil',
    tags: TAGS,
    auditActions: ['role.update'],
    responses: {
      200: {
        description: 'Nome, descrição ou `allowExternalAssignment` atualizados (novo `ETag`).',
        schema: dataEnvelope(roleSchema),
      },
    },
  })
  async updateRole(
    @ZodParams(roleIdParamsSchema) params: { id: string },
    @ZodBody(updateRoleSchema) body: UpdateRole,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<RoleDto> {
    const role = await this.update.execute({
      id: params.id,
      patch: body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    return this.versioned(role, response);
  }

  @Put(':id/permissions')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('ROLE_MANAGE', { detail: 'Você não tem permissão para gerenciar perfis.' })
  @Policy('POL-13')
  @ApiOperation({
    operationId: 'ROL-06',
    summary: 'Atualizar permissões do perfil',
    tags: TAGS,
    auditActions: ['role.permissions_update'],
    responses: {
      200: {
        description:
          'Matriz substituída pela lista completa enviada (diff gravado; novo `ETag`). POL-13 e proteção do `ADMIN_ORGAO`.',
        schema: dataEnvelope(roleWithPermissionsSchema),
      },
    },
  })
  async updateRolePermissions(
    @ZodParams(roleIdParamsSchema) params: { id: string },
    @ZodBody(updateRolePermissionsSchema) body: UpdateRolePermissions,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<RoleWithPermissionsDto> {
    const role = await this.updatePermissions.execute({
      id: params.id,
      permissions: body.permissions,
      expectedVersion: ifMatch?.value ?? 0,
    });
    return this.versioned(role, response);
  }

  @Post(':id/duplicate')
  @RequirePermission('ROLE_MANAGE', { detail: 'Você não tem permissão para gerenciar perfis.' })
  @ApiOperation({
    operationId: 'ROL-07',
    summary: 'Duplicar perfil',
    tags: TAGS,
    auditActions: ['role.create'],
    responses: {
      201: {
        description: 'Cópia personalizada do perfil (`Location` e `ETag: "1"`).',
        schema: dataEnvelope(roleSchema),
      },
    },
  })
  async duplicateRole(
    @ZodParams(roleIdParamsSchema) params: { id: string },
    @ZodBody(duplicateRoleSchema) _body: object,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<RoleDto> {
    return this.created(await this.duplicate.execute(params.id), response);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('ROLE_MANAGE', { detail: 'Você não tem permissão para gerenciar perfis.' })
  @Policy('POL-12')
  @ApiOperation({
    operationId: 'ROL-08',
    summary: 'Desativar perfil',
    tags: TAGS,
    auditActions: ['role.deactivate'],
    responses: {
      200: {
        description:
          'Perfil inativo (atribuições preservadas, sem efeito); `ADMIN_ORGAO` nunca (POL-12).',
        schema: dataEnvelope(roleSchema),
      },
    },
  })
  async deactivateRole(
    @ZodParams(roleIdParamsSchema) params: { id: string },
    @ZodBody(deactivateRoleSchema) body: DeactivateRole,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<RoleDto> {
    const role = await this.deactivate.execute({
      id: params.id,
      body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    return this.versioned(role, response);
  }

  private created<T extends RoleDto>(role: T, response: HttpResponse): T {
    response.setHeader('Location', `/api/v1/roles/${role.id}`);
    return this.versioned(role, response);
  }

  private versioned<T extends RoleDto>(role: T, response: HttpResponse): T {
    response.setHeader('ETag', `"${role.version}"`);
    return role;
  }
}
