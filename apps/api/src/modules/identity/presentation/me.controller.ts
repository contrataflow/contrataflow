import {
  dataEnvelope,
  membershipSummarySchema,
  myProfileSchema,
  updateMyProfileSchema,
} from '@contrataflow/validation';
import type { MembershipSummaryDto, MyProfileDto, UpdateMyProfile } from '@contrataflow/validation';
import { Controller, Get, HttpCode, Patch, Res } from '@nestjs/common';
import { z } from 'zod';

import { ImplicitAccess } from '#shared/auth/authorization.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody } from '#shared/validation/zod-validation.pipe.js';

import { GetMyProfileQuery, ListMyMembershipsQuery } from '../application/me.queries.js';
import { UpdateMyProfileCommand } from '../application/update-my-profile.command.js';

/** ME-01 e ME-04 (api/01-session-me.md): capacidades implícitas do usuário autenticado. */
@Controller('me')
@TenantScope('TENANT')
export class MeController {
  constructor(
    private readonly profile: GetMyProfileQuery,
    private readonly myMemberships: ListMyMembershipsQuery,
    private readonly updateProfile: UpdateMyProfileCommand,
  ) {}

  @Get()
  @ApiOperation({
    operationId: 'ME-01',
    summary: 'Obter perfil do usuário autenticado',
    tags: ['Sessão e perfil'],
    responses: {
      200: {
        description: 'Perfil do usuário (ETag = versão).',
        schema: dataEnvelope(myProfileSchema),
      },
    },
  })
  async me(@Res({ passthrough: true }) response: HttpResponse): Promise<MyProfileDto> {
    const profile = await this.profile.execute();
    response.setHeader('ETag', `"${profile.version}"`);
    return profile;
  }

  @Patch()
  @HttpCode(200)
  @RequireIfMatch()
  @ImplicitAccess(
    'Capacidade implícita (permissions.md §7): qualquer vínculo ativo edita o próprio perfil; nunca o de outra pessoa (não há id na rota).',
  )
  @ApiOperation({
    operationId: 'ME-02',
    summary: 'Atualizar perfil do usuário autenticado',
    tags: ['Sessão e perfil'],
    auditActions: ['profile.update'],
    responses: {
      200: {
        description: 'Perfil atualizado (novo `ETag`).',
        schema: dataEnvelope(myProfileSchema),
      },
    },
  })
  async update(
    @ZodBody(updateMyProfileSchema) body: UpdateMyProfile,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<MyProfileDto> {
    const profile = await this.updateProfile.execute({
      patch: body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${profile.version}"`);
    return profile;
  }

  @Get('memberships')
  @TenantScope('CROSS_TENANT_LOOKUP')
  @ApiOperation({
    operationId: 'ME-04',
    summary: 'Listar vínculos (instituições) do usuário',
    tags: ['Sessão e perfil'],
    responses: {
      200: {
        description: 'Vínculos do usuário em todas as instituições, com `usable` consolidado.',
        schema: dataEnvelope(z.array(membershipSummarySchema)),
      },
    },
  })
  listMemberships(): Promise<MembershipSummaryDto[]> {
    return this.myMemberships.execute();
  }
}
