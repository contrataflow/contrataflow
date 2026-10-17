import {
  membershipDetailMetaSchema,
  membershipDetailSchema,
  membershipReasonSchema,
  membershipUserParamsSchema,
  mfaResetResultSchema,
  mfaResetSchema,
  reactivateMembershipSchema,
  updateMembershipDepartmentsSchema,
  updateMembershipSchema,
} from '@contrataflow/validation';
import type {
  MembershipDetailMeta,
  MembershipReason,
  MfaReset,
  MfaResetResult,
  TenantMembershipDetailDto,
  UpdateMembership,
  UpdateMembershipDepartments,
} from '@contrataflow/validation';
import { Controller, Get, HttpCode, Patch, Post, Put, Res } from '@nestjs/common';
import { z } from 'zod';

import { Policy, RequirePermission } from '#shared/auth/authorization.js';
import { DataResult } from '#shared/http/envelope.interceptor.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams } from '#shared/validation/zod-validation.pipe.js';

import {
  ChangeMembershipStatusCommand,
  GetMembershipQuery,
  UpdateMembershipCommand,
  UpdateMembershipDepartmentsCommand,
} from '../application/membership.commands.js';
import type { MembershipDetailResult } from '../application/membership.commands.js';
import { ResetUserMfaCommand } from '../application/reset-user-mfa.command.js';
import type { MembershipTransition } from '../domain/membership-lifecycle.js';

const TAGS = ['Usuários e vínculos'];

/** `{ data: TenantMembershipDetail, meta: { allowedActions, isSelf } }` (api.md §1.5). */
const DETAIL_RESPONSE = z.object({
  data: membershipDetailSchema,
  meta: membershipDetailMetaSchema,
});

type DetailResponse = DataResult<TenantMembershipDetailDto, MembershipDetailMeta>;

/**
 * USR-07..12 (api/14-tenant-administration.md · US-092): detalhe e ciclo de vida do vínculo do
 * usuário no tenant ativo; USR-13 (US-090) redefine o MFA da conta no Authentik. `USER_VIEW` consulta; `USER_MANAGE` (+ MFA conforme
 * `security.mfaPolicy`, POL-14) edita, lota, suspende, reativa e revoga — conferidos nos casos de
 * uso, junto de POL-12/16. Toda mutação exige `If-Match` com a versão lida (RN-IAM-63) e devolve
 * o detalhe com o novo `ETag`.
 */
@Controller('users')
@TenantScope('TENANT')
export class UserMembershipController {
  constructor(
    private readonly detail: GetMembershipQuery,
    private readonly update: UpdateMembershipCommand,
    private readonly updateDepartments: UpdateMembershipDepartmentsCommand,
    private readonly changeStatus: ChangeMembershipStatusCommand,
    private readonly resetMfa: ResetUserMfaCommand,
  ) {}

  @Get(':userId')
  @RequirePermission('USER_VIEW')
  @ApiOperation({
    operationId: 'USR-07',
    summary: 'Consultar usuário/vínculo',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Vínculo com lotações nomeadas (principal primeiro), `ETag` = versão e `meta.allowedActions` conforme status, `USER_MANAGE` e POL-16 (`meta.isSelf`). Inexistente ou de outro tenant → 404 `USER_NOT_FOUND`.',
        schema: DETAIL_RESPONSE,
      },
    },
  })
  async getUser(
    @ZodParams(membershipUserParamsSchema) params: { userId: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DetailResponse> {
    return versioned(await this.detail.execute({ userId: params.userId }), response);
  }

  @Patch(':userId')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('USER_MANAGE')
  @ApiOperation({
    operationId: 'USR-08',
    summary: 'Atualizar dados do vínculo',
    tags: TAGS,
    auditActions: ['membership.update'],
    responses: {
      200: {
        description:
          'Cargo, matrícula e — só `EXTERNAL` — validade (hoje < validade ≤ hoje + `security.externalMembershipMaxDays`). Nome e e-mail são globais e não mudam aqui (RN-IAM-54). Novo `ETag`.',
        schema: DETAIL_RESPONSE,
      },
    },
  })
  async updateUser(
    @ZodParams(membershipUserParamsSchema) params: { userId: string },
    @ZodBody(updateMembershipSchema) body: UpdateMembership,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DetailResponse> {
    const result = await this.update.execute({
      userId: params.userId,
      body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    return versioned(result, response);
  }

  @Put(':userId/departments')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('USER_MANAGE')
  @ApiOperation({
    operationId: 'USR-09',
    summary: 'Atualizar lotações do vínculo',
    tags: TAGS,
    auditActions: ['membership.departments_update'],
    responses: {
      200: {
        description:
          'Lotação substituída em bloco: ≥ 1 unidade ativa do tenant, a principal entre elas (RN-IAM-56). Novo `ETag`.',
        schema: DETAIL_RESPONSE,
      },
    },
  })
  async updateUserDepartments(
    @ZodParams(membershipUserParamsSchema) params: { userId: string },
    @ZodBody(updateMembershipDepartmentsSchema) body: UpdateMembershipDepartments,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DetailResponse> {
    const result = await this.updateDepartments.execute({
      userId: params.userId,
      body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    return versioned(result, response);
  }

  @Post(':userId/suspend')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('USER_MANAGE')
  @Policy('POL-12', 'POL-16')
  @ApiOperation({
    operationId: 'USR-10',
    summary: 'Suspender vínculo',
    tags: TAGS,
    auditActions: ['membership.suspend'],
    responses: {
      200: {
        description:
          'Vínculo `ACTIVE` → `SUSPENDED` (motivo opcional). POL-16: o próprio vínculo → 403 `PERMISSION_DENIED`; POL-12: o último `ADMIN_ORGAO` ativo → 409 `LAST_ADMIN_REQUIRED`; fora de `ACTIVE` → 409 `INVALID_STATE`. As sessões do usuário na instituição são encerradas.',
        schema: DETAIL_RESPONSE,
      },
    },
  })
  suspendUser(
    @ZodParams(membershipUserParamsSchema) params: { userId: string },
    @ZodBody(membershipReasonSchema) body: MembershipReason,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DetailResponse> {
    return this.transition('SUSPEND', params.userId, body.reason, ifMatch, response);
  }

  @Post(':userId/reactivate')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('USER_MANAGE')
  @ApiOperation({
    operationId: 'USR-11',
    summary: 'Reativar vínculo',
    tags: TAGS,
    auditActions: ['membership.reactivate'],
    responses: {
      200: {
        description:
          'Vínculo `SUSPENDED` → `ACTIVE` (limpa a suspensão); fora de `SUSPENDED` → 409 `INVALID_STATE`.',
        schema: DETAIL_RESPONSE,
      },
    },
  })
  reactivateUser(
    @ZodParams(membershipUserParamsSchema) params: { userId: string },
    @ZodBody(reactivateMembershipSchema) _body: object,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DetailResponse> {
    return this.transition('REACTIVATE', params.userId, null, ifMatch, response);
  }

  @Post(':userId/revoke')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('USER_MANAGE')
  @Policy('POL-12', 'POL-16')
  @ApiOperation({
    operationId: 'USR-12',
    summary: 'Revogar vínculo',
    tags: TAGS,
    auditActions: ['membership.revoke'],
    responses: {
      200: {
        description:
          'Revogação definitiva (reverter exige novo convite), com motivo opcional; POL-16 → 403, POL-12 → 409 `LAST_ADMIN_REQUIRED`; já `REVOKED` → 409 `INVALID_STATE`. As sessões do usuário na instituição são encerradas.',
        schema: DETAIL_RESPONSE,
      },
    },
  })
  revokeUser(
    @ZodParams(membershipUserParamsSchema) params: { userId: string },
    @ZodBody(membershipReasonSchema) body: MembershipReason,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DetailResponse> {
    return this.transition('REVOKE', params.userId, body.reason, ifMatch, response);
  }

  @Post(':userId/mfa-reset')
  @HttpCode(200)
  @RequirePermission('USER_MANAGE')
  @Policy('POL-16')
  @ApiOperation({
    operationId: 'USR-13',
    summary: 'Redefinir MFA do usuário',
    tags: TAGS,
    auditActions: ['membership.mfa_reset'],
    responses: {
      200: {
        description:
          'Remove os fatores de MFA da conta no Authentik (novo *enrollment* no próximo desafio), com motivo obrigatório (10–500). Idempotente: repetir antes do novo cadastro conclui normalmente. Próprio vínculo → 422 `VALIDATION_ERROR` (`NOT_ALLOWED`, RN-IAM-43); vínculo revogado → 409 `INVALID_STATE`; Authentik fora do ar → 503 `DEPENDENCY_UNAVAILABLE`.',
        schema: z.object({ data: mfaResetResultSchema }),
      },
    },
  })
  async resetUserMfa(
    @ZodParams(membershipUserParamsSchema) params: { userId: string },
    @ZodBody(mfaResetSchema) body: MfaReset,
  ): Promise<MfaResetResult> {
    return this.resetMfa.execute({ userId: params.userId, reason: body.reason });
  }

  private async transition(
    action: MembershipTransition,
    userId: string,
    reason: string | null | undefined,
    ifMatch: IfMatchValue | null,
    response: HttpResponse,
  ): Promise<DetailResponse> {
    const result = await this.changeStatus.execute({
      action,
      userId,
      reason,
      expectedVersion: ifMatch?.value ?? 0,
    });
    return versioned(result, response);
  }
}

function versioned(result: MembershipDetailResult, response: HttpResponse): DetailResponse {
  response.setHeader('ETag', `"${String(result.data.version)}"`);
  return new DataResult(result.data, result.meta);
}
