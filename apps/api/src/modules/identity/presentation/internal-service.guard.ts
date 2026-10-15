import { createHash, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { rejectRequest } from '#shared/auth/route-access.js';
import { headerValue } from '#shared/http/http-types.js';
import type { HttpRequest } from '#shared/http/http-types.js';

/** Cabeçalho com a credencial de serviço do BFF nas rotas `/internal/*`. */
export const SERVICE_TOKEN_HEADER = 'X-CF-Service-Token';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Rotas `/internal/*` (BFF → API pela rede privada — US-087): além do access token do usuário,
 * exigem a credencial de serviço do BFF (`INTERNAL_SERVICE_TOKEN`), comparada em tempo constante.
 * Sem credencial configurada, toda chamada é recusada (falha fechada) com 403 `PERMISSION_DENIED`.
 */
@Injectable()
export class InternalServiceGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.internal.serviceToken;
    const received = headerValue(
      context.switchToHttp().getRequest<HttpRequest>(),
      SERVICE_TOKEN_HEADER,
    );
    if (!expected || !received || !timingSafeEqual(digest(received), digest(expected))) {
      throw rejectRequest('internal-service', 'invalid_service_token', 'PERMISSION_DENIED');
    }
    return true;
  }
}
