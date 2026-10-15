import { createParamDecorator, Inject, Injectable, Logger } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { trace } from '@opentelemetry/api';
import { z } from 'zod';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';

import { canReadOffboardingTenant } from './membership-policy.js';
import { hasSecondFactor } from './mfa-policy.js';
import {
  MEMBERSHIP_PORT,
  TENANT_STATUS_PORT,
  TOKEN_VERIFIER,
  TokenVerificationError,
  TokenVerifierUnavailableError,
  USER_PORT,
} from './ports.js';
import type {
  MembershipPort,
  MembershipRecord,
  TenantStatusPort,
  TokenVerifierPort,
  UserPort,
  VerifiedToken,
} from './ports.js';
import {
  ALLOW_UNBOUND_SUBJECT_METADATA,
  isPublicRoute,
  REQUIRE_MFA_METADATA,
  rejectRequest,
  routeFlag,
} from './route-access.js';
import { requireRequestContext, updateRequestContext } from '../context/request-context.js';
import type { AccessMode } from '../context/request-context.js';
import { ApiError } from '../errors/api-error.js';
import { headerValue } from '../http/http-types.js';
import type { HttpRequest } from '../http/http-types.js';
import { effectiveTenantScope, isOffboardingExport } from '../tenancy/tenant-scope.js';

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

/** Token verificado pelo guard de autenticação (rotas `@AllowUnboundSubject()`). */
const VERIFIED_TOKEN = Symbol('cf:verified-token');
type RequestWithToken = HttpRequest & { [VERIFIED_TOKEN]?: VerifiedToken };

/** Parâmetro do handler com o token verificado (só em rotas `@AllowUnboundSubject()`). */
export const VerifiedTokenParam = createParamDecorator(
  (_data: unknown, context: ExecutionContext): VerifiedToken => {
    const token = context.switchToHttp().getRequest<RequestWithToken>()[VERIFIED_TOKEN];
    if (!token) throw new ApiError('UNAUTHENTICATED');
    return token;
  },
);

/** 1 — JWT (assinatura, `iss`, `aud`, `exp`, `nbf`) e `User` ativo: 401 `UNAUTHENTICATED`/`SESSION_EXPIRED`. */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifierPort,
    @Inject(USER_PORT) private readonly users: UserPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithToken>();
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
      if (error instanceof TokenVerifierUnavailableError) {
        // `kid` desconhecido com o JWKS fora do ar: indisponibilidade, nunca 401 (RN-IAM-05).
        const rejection = rejectRequest(
          'authentication',
          'jwks_unavailable',
          'DEPENDENCY_UNAVAILABLE',
        );
        throw new ApiError(rejection.code, { headers: { 'Retry-After': '30' }, cause: error });
      }
      throw error;
    }

    // Início de sessão: o `sub` pode ainda não estar vinculado (primeiro login — RN-IAM-06).
    if (routeFlag(this.reflector, ALLOW_UNBOUND_SUBJECT_METADATA, context)) {
      request[VERIFIED_TOKEN] = verified;
      updateRequestContext({ amr: verified.amr, authTime: verified.authTime });
      return true;
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
      actor: { type: 'USER', userId: user.id, membershipId: null, name: user.displayName },
      amr: verified.amr,
      authTime: verified.authTime,
    });
    return true;
  }
}

const tenantIdSchema = z.uuid();

/** Métodos de leitura: os únicos aceitos numa instituição em encerramento, além das exportações. */
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Mensagens de V-01..V-03 da US-100 (o cliente nunca vê o tenant pedido nem o motivo interno). */
const TENANT_HEADER_DETAIL = 'Não foi possível identificar a instituição ativa. Entre novamente.';
const MEMBERSHIP_DETAIL = 'Você não tem acesso ativo a esta instituição.';
const SUSPENDED_DETAIL = 'O acesso a esta instituição está indisponível no momento.';

const tenantLogger = new Logger('Tenancy');

/** Rota da requisição para os logs de tenant (o padrão do Nest, sem IDs). */
function routeOf(request: HttpRequest): string {
  return request.route?.path ?? '-';
}

/**
 * `warn tenant.access_denied` (US-100 · Logs): sem o tenant pedido quando o usuário não tem vínculo
 * nele — `X-Tenant-Id` de quem não tem vínculo nunca vai para log acessível a tenants.
 */
function logAccessDenied(
  request: HttpRequest,
  reason: 'MEMBERSHIP_INACTIVE' | 'TENANT_SUSPENDED',
  tenantId: string | null,
): void {
  const { actor } = requireRequestContext();
  tenantLogger.warn(
    {
      event: 'tenant.access_denied',
      reason,
      userId: actor.userId,
      route: routeOf(request),
      ...(tenantId === null ? {} : { requestedTenantId: tenantId }),
    },
    'tenant.access_denied',
  );
}

/**
 * 2 — Contexto de tenant (US-100 · RN-TEN-19/20 · DEC-132), só nas rotas `@TenantScope('TENANT')`
 * (ou sem declaração — falha fechada):
 * - `X-Tenant-Id` ausente ou malformado → 400 `MALFORMED_REQUEST` (V-01);
 * - vínculo ANTES do status: sem vínculo no tenant (inclusive tenant inexistente) → 403
 *   `MEMBERSHIP_INACTIVE`, idêntico nos dois casos (V-02);
 * - com vínculo, status pelo `TenantStatusCache`: fora de `ACTIVE` → 403 `TENANT_SUSPENDED`;
 *   `OFFBOARDING` com `ADMIN_ORGAO`/`AUDITOR` → `accessMode = READ_EXPORT` (só leitura e as rotas
 *   `@OffboardingExport()` — RN-TEN-37).
 * O tenant entra no contexto (imutável), nos logs e no span da requisição.
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
    if (isPublicRoute(request) || effectiveTenantScope(this.reflector, context) !== 'TENANT') {
      return true;
    }

    const header = headerValue(request, TENANT_HEADER);
    if (!header || !tenantIdSchema.safeParse(header).success) {
      throw rejectRequest('tenant', 'missing_or_invalid_tenant_header', 'MALFORMED_REQUEST', {
        detail: TENANT_HEADER_DETAIL,
        errors: [
          {
            field: TENANT_HEADER,
            code: header ? 'INVALID_FORMAT' : 'REQUIRED',
            message: TENANT_HEADER_DETAIL,
          },
        ],
      });
    }
    const tenantId = header.toLowerCase();

    const userId = requireRequestContext().actor.userId;
    const membership = userId ? await this.memberships.findByUserAndTenant(userId, tenantId) : null;
    if (!membership) {
      logAccessDenied(request, 'MEMBERSHIP_INACTIVE', null);
      throw rejectRequest('tenant', 'no_membership', 'MEMBERSHIP_INACTIVE', {
        detail: MEMBERSHIP_DETAIL,
      });
    }

    const status = await this.tenants.findStatus(tenantId);
    const readOnly = status === 'OFFBOARDING' && canReadOffboardingTenant(membership.roleKeys);
    if (status !== 'ACTIVE' && !readOnly) {
      logAccessDenied(request, 'TENANT_SUSPENDED', tenantId);
      throw rejectRequest(
        'tenant',
        `tenant_${(status ?? 'missing').toLowerCase()}`,
        'TENANT_SUSPENDED',
        { detail: SUSPENDED_DETAIL },
      );
    }
    const accessMode: AccessMode = readOnly ? 'READ_EXPORT' : 'FULL';
    if (
      readOnly &&
      !READ_METHODS.has((request.method ?? 'GET').toUpperCase()) &&
      !isOffboardingExport(this.reflector, context)
    ) {
      logAccessDenied(request, 'TENANT_SUSPENDED', tenantId);
      throw rejectRequest('tenant', 'tenant_offboarding_command', 'TENANT_SUSPENDED', {
        detail: SUSPENDED_DETAIL,
      });
    }

    request[MEMBERSHIP] = membership;
    updateRequestContext({ tenantId, accessMode });
    trace.getActiveSpan()?.setAttribute('cf.tenant.id', tenantId);
    return true;
  }
}

/**
 * 3 — `TenantMembership` `ACTIVE` e não expirado: 403 `MEMBERSHIP_INACTIVE`. Completa o contexto de
 * tenant com o vínculo (fluxo principal, passo 5) e registra `tenant.context_opened`.
 */
@Injectable()
export class MembershipGuard implements CanActivate {
  private readonly logger = new Logger('Guards');

  constructor(
    private readonly reflector: Reflector,
    @Inject(MEMBERSHIP_PORT) private readonly memberships: MembershipPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithMembership>();
    if (isPublicRoute(request) || effectiveTenantScope(this.reflector, context) !== 'TENANT') {
      return true;
    }

    const membership = request[MEMBERSHIP];
    if (membership?.status !== 'ACTIVE') {
      logAccessDenied(request, 'MEMBERSHIP_INACTIVE', null);
      throw rejectRequest('membership', 'membership_not_active', 'MEMBERSHIP_INACTIVE', {
        detail: MEMBERSHIP_DETAIL,
      });
    }
    if (membership.expiresAt !== null && membership.expiresAt.getTime() <= Date.now()) {
      logAccessDenied(request, 'MEMBERSHIP_INACTIVE', null);
      throw rejectRequest('membership', 'membership_expired', 'MEMBERSHIP_INACTIVE', {
        detail: MEMBERSHIP_DETAIL,
      });
    }

    const current = requireRequestContext();
    const opened = updateRequestContext({
      actor: { ...current.actor, membershipId: membership.id },
    });
    const fields = {
      event: 'tenant.context_opened',
      tenantId: opened.tenantId,
      userId: opened.actor.userId,
      route: routeOf(request),
      accessMode: opened.accessMode,
    };
    // `debug` em produção (volume): o contexto aberto já está em todo log da requisição.
    if (this.config.nodeEnv === 'production') tenantLogger.debug(fields, 'tenant.context_opened');
    else tenantLogger.log(fields, 'tenant.context_opened');
    // Último acesso ao vínculo (RN-IAM-16) sem segurar a requisição.
    void this.memberships.recordAccess?.(membership, new Date()).catch((error: unknown) => {
      this.logger.warn(
        {
          event: 'identity.last_access_failed',
          errorName: error instanceof Error ? error.name : 'unknown',
        },
        'identity.last_access_failed',
      );
    });
    return true;
  }
}

/** 4 — MFA quando a rota exigir (`@RequireMfa()` — POL-14): 403 `MFA_REQUIRED`. */
@Injectable()
export class MfaGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (!routeFlag(this.reflector, REQUIRE_MFA_METADATA, context)) return true;
    const { amr } = requireRequestContext();
    if (!hasSecondFactor(amr)) {
      throw rejectRequest('mfa', 'mfa_missing', 'MFA_REQUIRED');
    }
    return true;
  }
}
