import {
  dataEnvelope,
  sessionEventRequestSchema,
  sessionEventResponseSchema,
} from '@contrataflow/validation';
import type {
  SessionEventRequest,
  SessionEventResult,
  SessionMembershipDto,
} from '@contrataflow/validation';
import { Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';

import { VerifiedTokenParam } from '#shared/auth/pipeline.guards.js';
import type { VerifiedToken } from '#shared/auth/ports.js';
import { AllowUnboundSubject, WithoutTenant } from '#shared/auth/route-access.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { ZodBody } from '#shared/validation/zod-validation.pipe.js';

import { InternalServiceGuard } from './internal-service.guard.js';
import { toMembershipSummary } from '../application/me.queries.js';
import { IDENTITY_CLOCK } from '../application/ports.js';
import type { Clock } from '../application/ports.js';
import {
  blockedUserError,
  RecordSessionTenantCommand,
} from '../application/record-session-tenant.command.js';
import { StartSessionCommand } from '../application/start-session.command.js';
import type { TenantMembership } from '../domain/tenant-membership.js';
import { defaultTenantOf, displayName } from '../domain/user.js';

/** Prefixo das rotas internas, fora de `/api/v1` (o proxy do BFF nunca as alcança). */
export const INTERNAL_ROUTE_PREFIX = 'internal';

/**
 * Contrato BFF → API de sessão (US-087 · Lacuna 1 — authentication.md §3): `POST
 * /internal/session-events`, só na rede privada, com o access token do usuário e a credencial de
 * serviço do BFF. Não faz parte do OpenAPI público (`internal: true`).
 */
@Controller(INTERNAL_ROUTE_PREFIX)
@UseGuards(InternalServiceGuard)
export class SessionEventsController {
  constructor(
    private readonly startSession: StartSessionCommand,
    private readonly recordTenant: RecordSessionTenantCommand,
    @Inject(IDENTITY_CLOCK) private readonly clock: Clock,
  ) {}

  @Post('session-events')
  @HttpCode(200)
  @WithoutTenant()
  @AllowUnboundSubject()
  @ApiOperation({
    operationId: 'INTERNAL-SESSION-EVENTS',
    summary: 'Registra o início de sessão, a ativação ou a troca de instituição (BFF → API)',
    internal: true,
    auditActions: ['auth.session_start', 'auth.tenant_switch'],
    responses: {
      200: {
        description: 'Identidade resolvida, vínculos e instituição ativada.',
        schema: dataEnvelope(sessionEventResponseSchema),
      },
    },
  })
  async record(
    @VerifiedTokenParam() token: VerifiedToken,
    @ZodBody(sessionEventRequestSchema) body: SessionEventRequest,
  ): Promise<SessionEventResult> {
    if (body.tenantId === undefined && body.membershipId === undefined) {
      if (body.type !== 'SESSION_STARTED') {
        throw validationError([
          { field: 'membershipId', code: 'REQUIRED', message: 'Selecione uma instituição válida.' },
        ]);
      }
      return this.start(token);
    }
    const result = await this.recordTenant.execute({
      subject: token.subject,
      tenantId: body.tenantId ?? null,
      membershipId: body.membershipId ?? null,
      kind: body.type === 'SESSION_STARTED' ? 'start' : 'switch',
      selection: body.selection ?? 'MANUAL',
      firstLogin: body.firstLogin ?? false,
      fromTenantId: body.fromTenantId ?? null,
      setAsDefault: body.setAsDefault ?? false,
      amr: token.amr,
      sessionIdHash: body.sessionIdHash,
      ip: body.ip,
      userAgent: body.userAgent,
    });
    // Troca suspensa pelo MFA do destino (RN-IAM-69): nenhuma instituição ativada.
    const mfaRequired = result.outcome === 'mfa_required';
    return {
      user: { id: result.user.id, displayName: displayName(result.user) },
      firstLogin: body.firstLogin ?? false,
      memberships: this.memberships(result.memberships),
      activeMembership: mfaRequired
        ? null
        : {
            membershipId: result.membership.id,
            tenantId: result.membership.tenant.id,
            readOnly: result.readOnly,
          },
      defaultTenantId: result.defaultTenantId,
      mfaRequired,
    };
  }

  private async start(token: VerifiedToken): Promise<SessionEventResult> {
    const result = await this.startSession.execute(token);
    // Sem `User` correspondente: "sem vínculo" — nenhum usuário é criado no login (RN-IAM-06).
    if (result.kind === 'unknown_user') throw new ApiError('MEMBERSHIP_INACTIVE');
    if (result.kind === 'blocked') throw blockedUserError();
    return {
      user: { id: result.user.id, displayName: displayName(result.user) },
      firstLogin: result.firstLogin,
      memberships: this.memberships(result.memberships),
      activeMembership: null,
      defaultTenantId: defaultTenantOf(result.user),
      mfaRequired: false,
    };
  }

  private memberships(memberships: readonly TenantMembership[]): SessionMembershipDto[] {
    const now = this.clock();
    return memberships.map((membership) => {
      const summary = toMembershipSummary(membership, now);
      return { ...summary, tenant: { ...summary.tenant, timezone: membership.tenant.timezone } };
    });
  }
}
