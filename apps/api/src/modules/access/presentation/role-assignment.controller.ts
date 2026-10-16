import {
  assignRoleSchema,
  dataEnvelope,
  revokeRoleAssignmentSchema,
  roleAssignmentIdParamsSchema,
  roleAssignmentListMetaSchema,
  roleAssignmentSchema,
  roleAssignmentUserParamsSchema,
  roleIdParamsSchema,
} from '@contrataflow/validation';
import type {
  AssignRole,
  RevokeRoleAssignment,
  RoleAssignmentDto,
  RoleAssignmentListMeta,
} from '@contrataflow/validation';
import { Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import { z } from 'zod';

import { DataResult } from '#shared/http/envelope.interceptor.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams } from '#shared/validation/zod-validation.pipe.js';

import {
  AssignRoleCommand,
  ListRoleAssignmentsQuery,
  ListUserRoleAssignmentsQuery,
  RevokeRoleAssignmentCommand,
} from '../application/role-assignment.commands.js';

const TAGS = ['Perfis e permissões'];

/**
 * ROL-09..12 (api/14-tenant-administration.md · US-096): atribuições de perfil com escopo e
 * vigência. `ROLE_VIEW`/`USER_VIEW` listam; `ROLE_ASSIGN` (+ MFA conforme `security.mfaPolicy`,
 * POL-14) atribui e revoga — conferidos nos casos de uso, junto de POL-12/13/15/16.
 */
@Controller()
@TenantScope('TENANT')
export class RoleAssignmentController {
  constructor(
    private readonly listByRole: ListRoleAssignmentsQuery,
    private readonly listByUser: ListUserRoleAssignmentsQuery,
    private readonly assign: AssignRoleCommand,
    private readonly revoke: RevokeRoleAssignmentCommand,
  ) {}

  @Get('roles/:id/assignments')
  @ApiOperation({
    operationId: 'ROL-09',
    summary: 'Listar atribuições de um perfil',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Atribuições não revogadas do perfil (vínculo, escopo, vigência, quem concedeu). Perfil inexistente ou de outro tenant → 404 `ROLE_NOT_FOUND`.',
        schema: dataEnvelope(z.array(roleAssignmentSchema)),
      },
    },
  })
  listRoleAssignments(
    @ZodParams(roleIdParamsSchema) params: { id: string },
  ): Promise<RoleAssignmentDto[]> {
    return this.listByRole.execute(params.id);
  }

  @Get('users/:userId/role-assignments')
  @ApiOperation({
    operationId: 'ROL-10',
    summary: 'Listar atribuições de um usuário',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Atribuições não revogadas do vínculo do usuário no tenant (inclusive a do convite), com `meta.canAssign` (`ROLE_ASSIGN`) e `meta.isSelf` (POL-16). Usuário sem vínculo no tenant → 404 `USER_NOT_FOUND`.',
        schema: z.object({
          data: z.array(roleAssignmentSchema),
          meta: roleAssignmentListMetaSchema,
        }),
      },
    },
  })
  async listUserRoleAssignments(
    @ZodParams(roleAssignmentUserParamsSchema) params: { userId: string },
  ): Promise<DataResult<RoleAssignmentDto[], RoleAssignmentListMeta>> {
    const result = await this.listByUser.execute(params.userId);
    return new DataResult(result.data, result.meta);
  }

  @Post('users/:userId/role-assignments')
  @Idempotent()
  @ApiOperation({
    operationId: 'ROL-11',
    summary: 'Atribuir perfil a um vínculo',
    tags: TAGS,
    idempotent: true,
    auditActions: ['role.assign'],
    responses: {
      201: {
        description:
          'Atribuição criada (`Location` e `ETag: "1"`); o cache de permissões do vínculo é invalidado no commit. POL-13 → 403 `PRIVILEGE_ESCALATION_FORBIDDEN`; POL-15 → 422 `EXTERNAL_HIGH_RISK_ROLE`; atribuição ativa idêntica → 409 `ROLE_ASSIGNMENT_ALREADY_EXISTS`; vínculo inativo → 403 `MEMBERSHIP_INACTIVE`.',
        schema: dataEnvelope(roleAssignmentSchema),
      },
    },
  })
  async assignRole(
    @ZodParams(roleAssignmentUserParamsSchema) params: { userId: string },
    @ZodBody(assignRoleSchema) body: AssignRole,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<RoleAssignmentDto> {
    const assignment = await this.assign.execute({ userId: params.userId, body });
    response.setHeader('Location', `/api/v1/role-assignments/${assignment.id}`);
    return versioned(assignment, response);
  }

  @Post('role-assignments/:id/revoke')
  @HttpCode(200)
  @RequireIfMatch()
  @ApiOperation({
    operationId: 'ROL-12',
    summary: 'Revogar atribuição de perfil',
    tags: TAGS,
    auditActions: ['role.revoke'],
    responses: {
      200: {
        description:
          'Atribuição revogada (fica no histórico; novo `ETag`). POL-16 → 403 `PERMISSION_DENIED`; POL-12 → 409 `LAST_ADMIN_REQUIRED`; já revogada → 409 `INVALID_STATE`; inexistente ou de outro tenant → 404 `ROLE_ASSIGNMENT_NOT_FOUND`.',
        schema: dataEnvelope(roleAssignmentSchema),
      },
    },
  })
  async revokeRoleAssignment(
    @ZodParams(roleAssignmentIdParamsSchema) params: { id: string },
    @ZodBody(revokeRoleAssignmentSchema) body: RevokeRoleAssignment,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<RoleAssignmentDto> {
    const assignment = await this.revoke.execute({
      id: params.id,
      reason: body.reason,
      expectedVersion: ifMatch?.value ?? 0,
    });
    return versioned(assignment, response);
  }
}

function versioned(assignment: RoleAssignmentDto, response: HttpResponse): RoleAssignmentDto {
  response.setHeader('ETag', `"${String(assignment.version)}"`);
  return assignment;
}
