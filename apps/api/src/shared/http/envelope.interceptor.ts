import { Injectable, StreamableFile } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs';
import type { Observable } from 'rxjs';

import { CursorResult, PageResult } from './pagination.js';

/**
 * Recurso único com `meta` (`{ data, meta }`) — ex.: `meta.allowedActions` (api.md §1.5), que
 * poupa ao cliente uma chamada extra para saber o que pode fazer.
 */
export class DataResult<T, M extends object> {
  constructor(
    readonly data: T,
    readonly meta: M,
  ) {}
}

/**
 * Recurso único com membros IRMÃOS de `data` fixados no contrato da rota (ex.: `upload` de ATT-02 —
 * `{ data, upload }`, US-068). Nada de `meta` aqui: para isso, `DataResult`.
 */
export class DataWithMembers<T, X extends Readonly<Record<string, unknown>>> {
  constructor(
    readonly data: T,
    readonly members: X,
  ) {}
}

/**
 * Resposta cujo status depende do resultado (ex.: DOC-21 — `202` ao criar, `200` ao reaproveitar a
 * equivalente — US-067 · FA-01). O `@HttpCode` da rota continua sendo o padrão documentado.
 */
export class WithHttpStatus<T> {
  constructor(
    readonly status: number,
    readonly value: T,
  ) {}
}

/** Envelope de DEC-106 aplicado ao valor devolvido pelo handler. */
export function toEnvelope(value: unknown): unknown {
  if (value === undefined) return undefined;
  // Arquivo (exportação em *streaming* — AUD-03): o corpo é o próprio arquivo, sem envelope.
  if (value instanceof StreamableFile) return value;
  if (value instanceof WithHttpStatus) return toEnvelope((value as WithHttpStatus<unknown>).value);
  if (value instanceof PageResult || value instanceof CursorResult) {
    return { data: value.items, meta: value.meta };
  }
  if (value instanceof DataWithMembers) {
    const result = value as DataWithMembers<unknown, Readonly<Record<string, unknown>>>;
    return { ...result.members, data: result.data };
  }
  if (value instanceof DataResult) {
    const result = value as DataResult<unknown, object>;
    return { data: result.data, meta: result.meta };
  }
  return { data: value };
}

/**
 * Handlers devolvem o recurso (`{ data }`), um `PageResult`/`CursorResult`/`DataResult`
 * (`{ data, meta }`), um `DataWithMembers` (`{ data, …membros }`), um `StreamableFile` (arquivo, sem
 * envelope) ou nada (204). Nenhuma rota monta o envelope à mão (RN-FND-37).
 */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((value) => {
        if (value instanceof WithHttpStatus) {
          forceStatus(context, (value as WithHttpStatus<unknown>).status);
        }
        return toEnvelope(value);
      }),
    );
  }
}

interface StatusResponse {
  statusCode: number;
  status?: (code: number) => unknown;
}

/**
 * O Nest aplica o status da rota DEPOIS dos interceptors (`reply(res, body, httpCode)`); aqui a
 * próxima chamada a `status()` desta resposta passa a manter o status do resultado.
 */
function forceStatus(context: ExecutionContext, status: number): void {
  const response = context.switchToHttp().getResponse<StatusResponse>();
  response.statusCode = status;
  const original = response.status?.bind(response);
  if (original === undefined) return;
  response.status = () => {
    response.status = original;
    return original(status);
  };
}
