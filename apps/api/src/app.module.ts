import { Module, RequestMethod } from '@nestjs/common';
import type { DynamicModule, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { ConfigModule } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { API_MODULES } from '#modules/index.js';
import {
  AuthenticationGuard,
  MembershipGuard,
  MfaGuard,
  TenantContextGuard,
} from '#shared/auth/pipeline.guards.js';
import { RequestContextMiddleware } from '#shared/context/request-context.middleware.js';
import { DatabaseModule } from '#shared/database/database.module.js';
import { ProblemDetailsExceptionFilter } from '#shared/errors/problem-details.filter.js';
import { EnvelopeInterceptor } from '#shared/http/envelope.interceptor.js';
import { JsonBodyMiddleware } from '#shared/http/json-body.middleware.js';
import { PreconditionGuard } from '#shared/http/precondition.js';
import { IdempotencyInterceptor } from '#shared/idempotency/idempotency.interceptor.js';
import { RateLimitGuard } from '#shared/rate-limit/rate-limit.guard.js';

/**
 * Módulo raiz (fluxo principal, passo 2 da US-080). Pipeline de toda requisição (RN-FND-33/34):
 * middleware de contexto → corpo JSON → autenticação → tenant → vínculo → MFA → rate limit →
 * If-Match → idempotência → `ZodValidationPipe` → handler → envelope; qualquer exceção → filtro
 * RFC 9457. Os guards e interceptors globais executam na ordem em que são registrados aqui.
 */
@Module({})
export class AppModule implements NestModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(config), DatabaseModule, ...API_MODULES],
      providers: [
        { provide: APP_FILTER, useClass: ProblemDetailsExceptionFilter },
        { provide: APP_GUARD, useClass: AuthenticationGuard },
        { provide: APP_GUARD, useClass: TenantContextGuard },
        { provide: APP_GUARD, useClass: MembershipGuard },
        { provide: APP_GUARD, useClass: MfaGuard },
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_GUARD, useClass: PreconditionGuard },
        // O primeiro interceptor é o mais externo: a idempotência guarda e reproduz a resposta já
        // envelopada.
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
        { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestContextMiddleware, JsonBodyMiddleware)
      .forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
