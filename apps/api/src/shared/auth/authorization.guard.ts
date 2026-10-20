import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext, Type } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';

import {
  AUTHORIZATION_PORT,
  POLICY_METADATA,
  REQUIRE_PERMISSION_METADATA,
} from './authorization.js';
import type {
  AuthorizationPort,
  ContextualPolicy,
  PermissionRequirement,
  PolicyDeclaration,
} from './authorization.js';
import { isPublicRoute } from './route-access.js';
import type { HttpRequest } from '../http/http-types.js';
import { effectiveTenantScope } from '../tenancy/tenant-scope.js';

/**
 * 5 — Autorização (US-097 · RN-IAM-100 · architecture.md §6.2), depois de autenticação, tenant,
 * vínculo, operador de plataforma e MFA: em toda rota `@TenantScope('TENANT')` com vínculo ativo,
 * carrega as permissões efetivas no contexto (cache Redis → banco) — também usadas pelo
 * `AccessFacade.assertCan` dos casos de uso — e aplica `@RequirePermission`/`@Policy` do handler.
 * Recusa = 403 (`PERMISSION_DENIED`, `MFA_REQUIRED` ou o código da política) ou 404 quando o
 * processo não é visível; toda recusa vira `access.denied` (RN-IAM-105, filtro RFC 9457).
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  private readonly policies = new Map<Type<ContextualPolicy>, Promise<ContextualPolicy>>();

  constructor(
    private readonly reflector: Reflector,
    private readonly moduleRef: ModuleRef,
    @Inject(AUTHORIZATION_PORT) private readonly authorization: AuthorizationPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HttpRequest>();
    if (isPublicRoute(request) || effectiveTenantScope(this.reflector, context) !== 'TENANT') {
      return true;
    }
    // Sem vínculo no contexto (o guard de vínculo já teria recusado), o serviço não concede nada:
    // rota com `@RequirePermission` recusa — falha fechada.
    const targets = [context.getHandler(), context.getClass()];
    await this.authorization.authorize({
      requirement:
        this.reflector.getAllAndOverride<PermissionRequirement | undefined>(
          REQUIRE_PERMISSION_METADATA,
          targets,
        ) ?? null,
      policies:
        this.reflector.getAllAndOverride<PolicyDeclaration[] | undefined>(
          POLICY_METADATA,
          targets,
        ) ?? [],
      params: request.params,
      route: request.route?.path ?? null,
      resolvePolicy: (type: Type<ContextualPolicy>) => this.policy(type),
    });
    return true;
  }

  /**
   * A política declarada: o provider registrado em algum módulo ou, sem ele, uma instância criada
   * com injeção de dependências (uma por classe).
   */
  private policy(type: Type<ContextualPolicy>): Promise<ContextualPolicy> {
    let instance = this.policies.get(type);
    if (!instance) {
      instance = Promise.resolve()
        .then(() => this.moduleRef.get(type, { strict: false }))
        .catch(() => this.moduleRef.create(type));
      this.policies.set(type, instance);
    }
    return instance;
  }
}
