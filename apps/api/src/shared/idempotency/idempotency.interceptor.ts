import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';
import { catchError, from, mergeMap, of, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import { z } from 'zod';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';

import { IDEMPOTENCY_STORE, IDEMPOTENT_METADATA } from './idempotency.js';
import type { IdempotencyRecord, IdempotencyStorePort, StoredResponse } from './idempotency.js';
import { requireRequestContext } from '../context/request-context.js';
import { ApiError, validationError } from '../errors/api-error.js';
import { headerValue, requestPath } from '../http/http-types.js';
import type { HttpRequest, HttpResponse } from '../http/http-types.js';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const REPLAYED_HEADER = 'Idempotent-Replayed';

/** Corpo acima disto não é guardado; a reprodução devolve só status e cabeçalhos (§6.10). */
export const MAX_STORED_BODY_BYTES = 64 * 1024;

/**
 * Prazo da reserva `IN_PROGRESS`: maior que o timeout de transação (10 s), mas curto o bastante
 * para que uma réplica que caiu no meio da requisição não bloqueie a chave pelas 24 h do registro.
 */
export const IN_PROGRESS_TTL_MS = 60_000;

const REPLAYED_HEADERS = ['location', 'etag'] as const;
const keySchema = z.uuid();

/** `cf_idempotency_store_unavailable_total` (US-001 · Falha de integração — Redis fora). */
let storeUnavailable: Counter | undefined;

/** JSON com chaves ordenadas: o mesmo corpo gera o mesmo hash independentemente da ordem. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * `@Idempotent()` (RN-FND-35 · DEC-105 · architecture.md §6.10). Chave Redis
 * `cf:{env}:t:{tenantId}:idem:{sha256(userId + método + rota + Idempotency-Key)}`:
 * mesma chave e corpo → mesma resposta com `Idempotent-Replayed: true`; corpo diferente → 422
 * `IDEMPOTENCY_KEY_REUSED`; original em processamento → 409 `IDEMPOTENCY_IN_PROGRESS`; erro libera a
 * chave. Armazenamento indisponível → segue sem idempotência com log `warn` (CA-T-07).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Idempotency');

  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStorePort,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (
      this.reflector.get<boolean | undefined>(IDEMPOTENT_METADATA, context.getHandler()) !== true
    ) {
      return next.handle();
    }
    const http = context.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<HttpResponse>();

    const idempotencyKey = headerValue(request, IDEMPOTENCY_KEY_HEADER);
    if (idempotencyKey === undefined) return next.handle();
    if (!keySchema.safeParse(idempotencyKey).success) {
      return throwError(() =>
        validationError([
          {
            field: IDEMPOTENCY_KEY_HEADER,
            code: 'INVALID_FORMAT',
            message: 'Informe a chave de idempotência como UUID.',
          },
        ]),
      );
    }

    const { tenantId, actor } = requireRequestContext();
    const scope = tenantId ? `t:${tenantId}` : 'platform';
    const key = `cf:${this.config.appEnv}:${scope}:idem:${sha256(
      [actor.userId ?? '-', request.method, requestPath(request), idempotencyKey].join('\n'),
    )}`;
    const bodyHash = sha256(canonicalJson(request.body));

    return from(this.begin(key, bodyHash)).pipe(
      mergeMap((existing) => {
        if (existing === 'unavailable') return next.handle();
        if (existing) return this.replay(existing, bodyHash, response);
        return next.handle().pipe(
          mergeMap((body) =>
            from(this.complete(key, bodyHash, response, body)).pipe(mergeMap(() => of(body))),
          ),
          catchError((error: unknown) =>
            from(this.release(key)).pipe(mergeMap(() => throwError(() => error))),
          ),
        );
      }),
    );
  }

  private async begin(
    key: string,
    bodyHash: string,
  ): Promise<IdempotencyRecord | null | 'unavailable'> {
    try {
      return await this.store.begin(key, bodyHash, IN_PROGRESS_TTL_MS);
    } catch (error) {
      this.unavailable(error);
      return 'unavailable';
    }
  }

  private replay(
    existing: IdempotencyRecord,
    bodyHash: string,
    response: HttpResponse,
  ): Observable<unknown> {
    if (existing.bodyHash !== bodyHash)
      return throwError(() => new ApiError('IDEMPOTENCY_KEY_REUSED'));
    if (existing.state === 'IN_PROGRESS') {
      return throwError(
        () => new ApiError('IDEMPOTENCY_IN_PROGRESS', { headers: { 'Retry-After': '1' } }),
      );
    }
    const stored = existing.response;
    response.statusCode = stored.status;
    for (const [name, value] of Object.entries(stored.headers)) response.setHeader(name, value);
    response.setHeader(REPLAYED_HEADER, 'true');
    return of(stored.body);
  }

  private async complete(key: string, bodyHash: string, response: HttpResponse, body: unknown) {
    const headers: Record<string, string> = {};
    for (const name of REPLAYED_HEADERS) {
      const value = response.getHeader(name);
      if (typeof value === 'string') headers[name] = value;
    }
    const serialized = body === undefined ? '' : JSON.stringify(body);
    const stored: StoredResponse =
      Buffer.byteLength(serialized) <= MAX_STORED_BODY_BYTES
        ? { status: response.statusCode, headers, body }
        : { status: response.statusCode, headers };
    try {
      await this.store.complete(
        key,
        { state: 'DONE', bodyHash, response: stored },
        this.config.idempotency.ttlMs,
      );
    } catch (error) {
      this.unavailable(error);
    }
  }

  private async release(key: string): Promise<void> {
    try {
      await this.store.release(key);
    } catch (error) {
      this.unavailable(error);
    }
  }

  private unavailable(error: unknown): void {
    storeUnavailable ??= metrics
      .getMeter('contrataflow-api')
      .createCounter('cf_idempotency_store_unavailable_total', {
        description:
          'Requisições que seguiram sem idempotência por falha do armazenamento (Redis).',
      });
    storeUnavailable.add(1);
    this.logger.warn(
      `idempotency.store_unavailable cause=${error instanceof Error ? error.name : 'unknown'}`,
    );
  }
}
