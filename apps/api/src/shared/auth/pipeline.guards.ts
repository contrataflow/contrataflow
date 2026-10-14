import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { z } from 'zod';

import {
  MEMBERSHIP_PORT,
  TENANT_STATUS_PORT,
  TOKEN_VERIFIER,
  TokenVerificationError,
  USER_PORT,
} from './ports.js';
import type {
  MembershipPort,
  MembershipRecord,
  TenantStatusPort,
  TokenVerifierPort,
  UserPort,
} from './ports.js';
import {
  isPublicRoute,
  REQUIRE_MFA_METADATA,
  rejectRequest,
  routeFlag,
  WITHOUT_TENANT_METADATA,
} from './route-access.js';
import { requireRequestContext, updateRequestContext } from '../context/request-context.js';
import { headerValue } from '../http/http-types.js';
import type { HttpRequest } from '../http/http-types.js';

/*
 * Guards globais em ordem fixa (RN-FND-33 · architecture.md §6.2), registrados nessa ordem no
 * AppModule: autenticação → tenant → vínculo → MFA (→ rate limit). Cada um curto-circuita com o
 * erro canônico de api.md §2.1 e registra `warn guard.rejected`.
 */

export const TENANT_HEADER = 'X-Tenant-Id';

/** Vínculo resolvido pelo guard de tenant e conferido pelo guard de vínculo. */
const MEMBERSHIP = Symbol('cf:membership');
type RequestWithMembership = HttpRequest & { [MEMBERSHIP]?: MembershipRecord };

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;

/** 1 — JWT (assinatura, `iss`, `aud`, `exp`, `nbf`) e `User` ativo: 401 `UNAUTHENTICATED`/`SESSION_EXPIRED`. */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifierPort,
    @Inject(USER_PORT) private readonly users: UserPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HttpRequest>();
    if (isPublicRoute(request)) return true;

    const token = BEARER.exec(headerValue(request, 'authorization') ?? '')?.[1];
    if (!token) throw rejectRequest('authentication', 'missing_token', 'UNAUTHENTICATED');

    let verified;
    try {
      verified = await this.verifier.verify(token);
    } catch (error) {
      if (error instanceof TokenVerificationError && error.reason === 'EXPIRED') {
        throw rejectRequest('authentication', 'token_expired', 'SESSION_EXPIRED');
      }
      if (error instanceof TokenVerificationError) {
        throw rejectRequest('authentication', 'invalid_token', 'UNAUTHENTICATED');
      }
      throw error;
    }

    const user = await this.users.findByExternalSubject(verified.subject);
    if (user?.status !== 'ACTIVE') {
      throw rejectRequest(
        'authentication',
        user ? 'user_not_active' : 'unknown_user',
        'UNAUTHENTICATED',
      );
    }

    updateRequestContext({
      actor: { type: 'USER', userId: user.id, membershipId: null },
      amr: verified.amr,
      authTime: verified.authTime,
    });
    return true;
  }
}

const tenantIdSchema = z.uuid();

/**
 * 2 — `X-Tenant-Id` (DEC-132) e tenant `ACTIVE`: 403 `TENANT_SUSPENDED`. Sem vínculo no tenant
 * do cabeçalho (inclusive tenant inexistente) → 403 `MEMBERSHIP_INACTIVE`, sem revelar se o
 * tenant existe nem o seu status.
 */
@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(MEMBERSHIP_PORT) private readonly memberships: MembershipPort,
    @Inject(TENANT_STATUS_PORT) private readonly tenants: TenantStatusPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithMembership>();
    if (isPublicRoute(request) || routeFlag(this.reflector, WITHOUT_TENANT_METADATA, context)) {
      return true;
    }

    const tenantId = headerValue(request, TENANT_HEADER);
    if (!tenantId || !tenantIdSchema.safeParse(tenantId).success) {
      throw rejectRequest('tenant', 'missing_or_invalid_tenant_header', 'MEMBERSHIP_INACTIVE');
    }

    const userId = requireRequestContext().actor.userId;
    const membership = userId ? await this.memberships.findByUserAndTenant(userId, tenantId) : null;
    if (!membership) throw rejectRequest('tenant', 'no_membership', 'MEMBERSHIP_INACTIVE');

    // OFFBOARDING (somente leitura para ADMIN_ORGAO/AUDITOR — DEC-132) depende dos perfis do
    // módulo `access`; até lá todo status diferente de ACTIVE é recusado.
    const status = await this.tenants.findStatus(tenantId);
    if (status !== 'ACTIVE') {
      throw rejectRequest(
        'tenant',
        `tenant_${(status ?? 'missing').toLowerCase()}`,
        'TENANT_SUSPENDED',
      );
    }

    request[MEMBERSHIP] = membership;
    updateRequestContext({ tenantId });
    return true;
  }
}

/** 3 — `TenantMembership` `ACTIVE` e não expirado: 403 `MEMBERSHIP_INACTIVE`. */
@Injectable()
export class MembershipGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithMembership>();
    if (isPublicRoute(request) || routeFlag(this.reflector, WITHOUT_TENANT_METADATA, context)) {
      return true;
    }

    const membership = request[MEMBERSHIP];
    if (membership?.status !== 'ACTIVE') {
      throw rejectRequest('membership', 'membership_not_active', 'MEMBERSHIP_INACTIVE');
    }
    if (membership.expiresAt !== null && membership.expiresAt.getTime() <= Date.now()) {
      throw rejectRequest('membership', 'membership_expired', 'MEMBERSHIP_INACTIVE');
    }

    const current = requireRequestContext();
    updateRequestContext({ actor: { ...current.actor, membershipId: membership.id } });
    return true;
  }
}

/** Valores de `amr` que comprovam segundo fator (RFC 8176). */
export const MFA_AMR_VALUES: readonly string[] = ['mfa', 'otp', 'hwk', 'swk', 'fpt', 'face'];

/** 4 — MFA quando a rota exigir (`@RequireMfa()` — POL-14): 403 `MFA_REQUIRED`. */
@Injectable()
export class MfaGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (!routeFlag(this.reflector, REQUIRE_MFA_METADATA, context)) return true;
    const { amr } = requireRequestContext();
    if (!amr.some((method) => MFA_AMR_VALUES.includes(method))) {
      throw rejectRequest('mfa', 'mfa_missing', 'MFA_REQUIRED');
    }
    return true;
  }
}
