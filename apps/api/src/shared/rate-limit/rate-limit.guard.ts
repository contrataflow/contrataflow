import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';

import { RATE_LIMIT_METADATA, RATE_LIMIT_STORE } from './rate-limit.js';
import type { RateLimitClass, RateLimitOptions, RateLimitStorePort } from './rate-limit.js';
import { isPublicRoute } from '../auth/route-access.js';
import { requireRequestContext } from '../context/request-context.js';
import { ApiError } from '../errors/api-error.js';
import type { HttpRequest, HttpResponse } from '../http/http-types.js';

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Segundos até o contador voltar a liberar (`RateLimit-Reset`/`Retry-After`). */
  readonly resetSeconds: number;
}

/** Janela deslizante aproximada (contador atual + anterior ponderado). Função pura, testável. */
export function decide(
  counts: { current: number; previous: number },
  limit: number,
  windowMs: number,
  elapsedMs: number,
): RateLimitDecision {
  const weight = Math.max(0, 1 - elapsedMs / windowMs);
  const estimated = counts.previous * weight + counts.current;
  return {
    allowed: estimated <= limit,
    limit,
    remaining: Math.max(0, Math.floor(limit - estimated)),
    resetSeconds: Math.max(1, Math.ceil((windowMs - elapsedMs) / 1000)),
  };
}

/**
 * Rate limit por classe de rota e global por tenant (RN-FND-36 · api.md §1.6), logo após os guards
 * de tenant/vínculo (a chave é usuário + tenant). Excedente → 429 `RATE_LIMITED` com
 * `RateLimit-*` e `Retry-After`. Armazenamento indisponível → falha **aberta** com log `warn`
 * (CA-T-07); o WAF continua limitando por IP.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger('RateLimit');

  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStorePort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    if (isPublicRoute(request)) return true;

    const { actor, tenantId } = requireRequestContext();
    const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(
      RATE_LIMIT_METADATA,
      [context.getHandler(), context.getClass()],
    );
    const rateLimitClass: RateLimitClass =
      options?.class ?? (request.method === 'GET' || request.method === 'HEAD' ? 'read' : 'write');
    const scope = tenantId ? `t:${tenantId}` : 'platform';
    const subject = options?.keyParam
      ? `${actor.userId ?? '-'}:${request.params[options.keyParam] ?? '-'}`
      : (actor.userId ?? '-');
    const prefix = `cf:${this.config.appEnv}:${scope}:rl`;

    const checks: [string, number][] = [
      [`${prefix}:${rateLimitClass}:${subject}`, this.config.rateLimit.perClass[rateLimitClass]],
    ];
    if (tenantId) checks.push([`${prefix}:tenant`, this.config.rateLimit.perTenant]);

    const { windowMs } = this.config.rateLimit;
    const now = Date.now();
    const windowIndex = Math.floor(now / windowMs);
    const elapsedMs = now - windowIndex * windowMs;

    let decisions: RateLimitDecision[];
    try {
      decisions = await Promise.all(
        checks.map(async ([key, limit]) =>
          decide(
            await this.store.increment(key, windowIndex, windowMs),
            limit,
            windowMs,
            elapsedMs,
          ),
        ),
      );
    } catch (error) {
      this.logger.warn(
        `throttler.store_unavailable failOpen=true cause=${error instanceof Error ? error.name : 'unknown'}`,
      );
      return true;
    }

    const [classDecision] = decisions as [RateLimitDecision, ...RateLimitDecision[]];
    const blocking = decisions.find((decision) => !decision.allowed);
    const headers = rateLimitHeaders(blocking ?? classDecision);
    if (blocking) {
      throw new ApiError('RATE_LIMITED', {
        headers: { ...headers, 'Retry-After': String(blocking.resetSeconds) },
      });
    }
    const response = http.getResponse<HttpResponse>();
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    return true;
  }
}

function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  return {
    'RateLimit-Limit': String(decision.limit),
    'RateLimit-Remaining': String(decision.remaining),
    'RateLimit-Reset': String(decision.resetSeconds),
  };
}
