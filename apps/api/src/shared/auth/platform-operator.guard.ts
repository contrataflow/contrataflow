import { PLATFORM_TENANT_MANAGE } from '@contrataflow/types';
import { Inject, Injectable, SetMetadata } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { hasSecondFactor } from './mfa-policy.js';
import { PLATFORM_OPERATOR_PORT } from './ports.js';
import type { PlatformOperatorPort } from './ports.js';
import { isPublicRoute, rejectRequest } from './route-access.js';
import { requireRequestContext } from '../context/request-context.js';
import type { HttpRequest } from '../http/http-types.js';
import { effectiveTenantScope } from '../tenancy/tenant-scope.js';

export const PLATFORM_PERMISSION_METADATA = 'cf:auth:platform-permission';

/** Permissão de plataforma exigida pela rota `@TenantScope('PLATFORM')` (permissions.md §8). */
export const PlatformPermission = (permission: string): MethodDecorator & ClassDecorator =>
  SetMetadata(PLATFORM_PERMISSION_METADATA, permission);

/**
 * Rotas `/platform/*` (US-099 · DEC-139 · permissions.md §8): só operador da plataforma ativo
 * (`User.isPlatformOperator`) → senão 403 `PERMISSION_DENIED` (auditado como `access.denied` na
 * auditoria de plataforma, com a permissão em `reasonCode`); e SEMPRE com MFA, sem depender de
 * `security.mfaPolicy` → 403 `MFA_REQUIRED`. A permissão vem antes do MFA: quem não é operador não
 * é convidado a confirmar a identidade. Guard global, depois do vínculo; ignora as demais rotas.
 */
@Injectable()
export class PlatformOperatorGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PLATFORM_OPERATOR_PORT) private readonly operators: PlatformOperatorPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HttpRequest>();
    if (isPublicRoute(request) || effectiveTenantScope(this.reflector, context) !== 'PLATFORM') {
      return true;
    }
    const permission =
      this.reflector.getAllAndOverride<string | undefined>(PLATFORM_PERMISSION_METADATA, [
        context.getHandler(),
        context.getClass(),
      ]) ?? PLATFORM_TENANT_MANAGE;
    const { actor, amr } = requireRequestContext();
    const operator = actor.userId ? await this.operators.findOperatorById(actor.userId) : null;
    if (operator?.status !== 'ACTIVE' || !operator.isPlatformOperator) {
      throw rejectRequest('platform', 'not_platform_operator', 'PERMISSION_DENIED', {
        auditReasonCode: permission,
        detail: 'Acesso restrito a operadores da plataforma.',
      });
    }
    if (!hasSecondFactor(amr)) {
      throw rejectRequest('platform', 'mfa_missing', 'MFA_REQUIRED', {
        auditReasonCode: 'MFA_REQUIRED',
        detail: 'Confirme sua identidade com o segundo fator.',
      });
    }
    return true;
  }
}
