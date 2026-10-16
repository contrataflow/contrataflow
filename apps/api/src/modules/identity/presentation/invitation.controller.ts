import {
  acceptedInvitationSchema,
  dataEnvelope,
  invitationPreviewSchema,
  invitationResentSchema,
  invitationTokenBodySchema,
  invitationUserParamsSchema,
  inviteUserSchema,
  membershipListQuerySchema,
  pageEnvelope,
  tenantMembershipSchema,
} from '@contrataflow/validation';
import type {
  AcceptedInvitationDto,
  InvitationPreviewDto,
  InvitationResentDto,
  InvitationTokenBody,
  InviteUser,
  MembershipListQuery,
  TenantMembershipDto,
} from '@contrataflow/validation';
import { Controller, Delete, Get, HttpCode, Post, Res } from '@nestjs/common';

import { ImplicitAccess, RequirePermission } from '#shared/auth/authorization.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { pageResult } from '#shared/http/pagination.js';
import type { PageResult } from '#shared/http/pagination.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import {
  AcceptInvitationCommand,
  CancelInvitationCommand,
  InviteUserCommand,
  ListMembershipsQuery,
  PreviewInvitationQuery,
  ResendInvitationCommand,
} from '../application/invitation.commands.js';

const TAGS = ['Usuários e vínculos'];

/**
 * USR-01 e USR-03..05 (api/14-tenant-administration.md · US-091): vínculos do tenant e convites.
 * `USER_VIEW` lista; `USER_INVITE` (+ MFA conforme `security.mfaPolicy`, POL-14) convida, reenvia
 * e cancela — conferidos nos casos de uso.
 */
@Controller('users')
@TenantScope('TENANT')
export class UserInvitationController {
  constructor(
    private readonly list: ListMembershipsQuery,
    private readonly invite: InviteUserCommand,
    private readonly resend: ResendInvitationCommand,
    private readonly cancel: CancelInvitationCommand,
  ) {}

  @Get()
  @RequirePermission('USER_VIEW')
  @ApiOperation({
    operationId: 'USR-01',
    summary: 'Listar usuários e vínculos',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Vínculos do tenant por nome; filtros `status` (lista separada por vírgula = OU), `type` e `q` (nome ou e-mail, mín. 2 caracteres). `status=INVITED` = convites pendentes (SCR-029).',
        schema: pageEnvelope(tenantMembershipSchema),
      },
    },
  })
  async listUsers(
    @ZodQuery(membershipListQuerySchema) query: MembershipListQuery,
  ): Promise<PageResult<TenantMembershipDto>> {
    const page = await this.list.execute(query);
    return pageResult(page.items, query, page.totalItems);
  }

  @Post('invitations')
  @Idempotent()
  @RequirePermission('USER_INVITE')
  @ApiOperation({
    operationId: 'USR-03',
    summary: 'Convidar usuário',
    tags: TAGS,
    idempotent: true,
    auditActions: ['membership.invite'],
    responses: {
      201: {
        description:
          'Vínculo `INVITED` com validade do convite de 7 dias (`Location`); o e-mail com o link é enviado pelo worker (fila `email`). 409 `MEMBERSHIP_ALREADY_EXISTS` se a pessoa já tem vínculo `INVITED`/`ACTIVE`/`SUSPENDED`; 503 `DEPENDENCY_UNAVAILABLE` com o Authentik fora do ar (nada é gravado).',
        schema: dataEnvelope(tenantMembershipSchema),
      },
    },
  })
  async inviteUser(
    @ZodBody(inviteUserSchema) body: InviteUser,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<TenantMembershipDto> {
    const membership = await this.invite.execute({ body });
    response.setHeader('Location', `/api/v1/users/${membership.userId}`);
    return membership;
  }

  @Post('invitations/:userId/resend')
  @HttpCode(200)
  @RequirePermission('USER_INVITE')
  @ApiOperation({
    operationId: 'USR-04',
    summary: 'Reenviar convite',
    tags: TAGS,
    auditActions: ['membership.invite'],
    responses: {
      200: {
        description:
          'Nova validade de 7 dias e novo link (o anterior deixa de valer). Até 5 reenvios, com 1 minuto entre eles (429 `RATE_LIMITED`); sem convite pendente → 404 `USER_NOT_FOUND`.',
        schema: dataEnvelope(invitationResentSchema),
      },
    },
  })
  resendInvitation(
    @ZodParams(invitationUserParamsSchema) params: { userId: string },
  ): Promise<InvitationResentDto> {
    return this.resend.execute({ userId: params.userId });
  }

  @Delete('invitations/:userId')
  @HttpCode(204)
  @RequirePermission('USER_INVITE')
  @ApiOperation({
    operationId: 'USR-05',
    summary: 'Cancelar convite',
    tags: TAGS,
    auditActions: ['membership.revoke'],
    responses: {
      204: {
        description:
          'Convite cancelado (o vínculo nunca chega a valer); fora de `INVITED` → 409 `INVALID_STATE`.',
      },
    },
  })
  async cancelInvitation(
    @ZodParams(invitationUserParamsSchema) params: { userId: string },
  ): Promise<void> {
    await this.cancel.execute({ userId: params.userId });
  }
}

/**
 * USR-06 e USR-14 (SCR-102 · US-091): o convite do PRÓPRIO usuário autenticado, encontrado pelo
 * token entre tenants (`cf_find_invitation`) — sem exigir vínculo ativo nem a instituição ativa
 * da sessão. O token vai no corpo (nunca na URL da API, que entra em logs de acesso).
 */
@Controller('invitations')
@TenantScope('CROSS_TENANT_LOOKUP')
export class InvitationAcceptController {
  constructor(
    private readonly accept: AcceptInvitationCommand,
    private readonly preview: PreviewInvitationQuery,
  ) {}

  @Post('accept')
  @HttpCode(200)
  @ImplicitAccess(
    'Aceite do convite (US-091): o vínculo ainda não está ativo; autoriza o token do convite.',
  )
  @ApiOperation({
    operationId: 'USR-06',
    summary: 'Aceitar convite',
    tags: TAGS,
    auditActions: ['membership.activate'],
    responses: {
      200: {
        description:
          'Vínculo ativado na instituição do convite (`tenant`), para a troca da instituição ativa. 404 `INVITATION_INVALID` (inexistente, já aceito, cancelado ou de outra pessoa); 410 `INVITATION_EXPIRED`.',
        schema: dataEnvelope(acceptedInvitationSchema),
      },
    },
  })
  acceptInvitation(
    @ZodBody(invitationTokenBodySchema) body: InvitationTokenBody,
  ): Promise<AcceptedInvitationDto> {
    return this.accept.execute({ token: body.token });
  }

  @Post('preview')
  @HttpCode(200)
  @ImplicitAccess(
    'Prévia do convite (US-091): autoriza o token do convite, antes de existir vínculo ativo.',
  )
  @ApiOperation({
    operationId: 'USR-14',
    summary: 'Consultar convite antes do aceite',
    tags: TAGS,
    auditExempt: 'Leitura do próprio convite, sem efeito; o aceite (USR-06) é auditado.',
    responses: {
      200: {
        description:
          'Instituição, tipo, cargo, lotação e validades do convite (SCR-102), com as mesmas recusas do aceite.',
        schema: dataEnvelope(invitationPreviewSchema),
      },
    },
  })
  previewInvitation(
    @ZodBody(invitationTokenBodySchema) body: InvitationTokenBody,
  ): Promise<InvitationPreviewDto> {
    return this.preview.execute({ token: body.token });
  }
}
