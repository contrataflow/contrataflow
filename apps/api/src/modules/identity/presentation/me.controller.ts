import { dataEnvelope, membershipSummarySchema, myProfileSchema } from '@contrataflow/validation';
import type { MembershipSummaryDto, MyProfileDto } from '@contrataflow/validation';
import { Controller, Get, Res } from '@nestjs/common';
import { z } from 'zod';

import { WithoutTenant } from '#shared/auth/route-access.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';

import { GetMyProfileQuery, ListMyMembershipsQuery } from '../application/me.queries.js';

/** ME-01 e ME-04 (api/01-session-me.md): capacidades implícitas do usuário autenticado. */
@Controller('me')
export class MeController {
  constructor(
    private readonly profile: GetMyProfileQuery,
    private readonly myMemberships: ListMyMembershipsQuery,
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

  @Get('memberships')
  @WithoutTenant()
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
