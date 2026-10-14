import type { ErrorCode } from '@contrataflow/types';
import { Logger, SetMetadata } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { ApiError } from '../errors/api-error.js';
import { requestPath } from '../http/http-types.js';
import type { HttpRequest } from '../http/http-types.js';

/**
 * Allowlist explícita de rotas públicas (FA-06): pulam autenticação, tenant e vínculo. Nenhuma
 * rota de negócio entra aqui; `/health/*` e `/metrics` são da US-085 (fora de `/api/v1`).
 */
export const PUBLIC_ROUTE_PREFIXES: readonly string[] = ['/health/', '/metrics'];

export function isPublicRoute(request: Pick<HttpRequest, 'originalUrl'>): boolean {
  const path = requestPath(request);
  return PUBLIC_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

export const WITHOUT_TENANT_METADATA = 'cf:auth:without-tenant';
export const REQUIRE_MFA_METADATA = 'cf:auth:require-mfa';

/**
 * Rota autenticada sem tenant ativo (ex.: `GET /me/memberships`, `/platform/*`): pula os guards
 * de tenant e de vínculo. Uso restrito às rotas que o catálogo de api.md marca assim.
 */
export const WithoutTenant = (): MethodDecorator & ClassDecorator =>
  SetMetadata(WITHOUT_TENANT_METADATA, true);

/** Rota que exige sessão com MFA (POL-14 — ponto de extensão; nenhuma rota usa na US-080). */
export const RequireMfa = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_MFA_METADATA, true);

export function routeFlag(reflector: Reflector, key: string, context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean | undefined>(key, [
      context.getHandler(),
      context.getClass(),
    ]) === true
  );
}

const logger = new Logger('Guards');

/** Recusa do pipeline: log `warn guard.rejected` (sem dados do token) e o erro canônico. */
export function rejectRequest(guard: string, reason: string, code: ErrorCode): ApiError {
  logger.warn(`guard.rejected guard=${guard} reason=${reason} code=${code}`);
  return new ApiError(code);
}
