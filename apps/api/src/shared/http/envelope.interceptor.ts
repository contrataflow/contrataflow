import { Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs';
import type { Observable } from 'rxjs';

import { CursorResult, PageResult } from './pagination.js';

/** Envelope de DEC-106 aplicado ao valor devolvido pelo handler. */
export function toEnvelope(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value instanceof PageResult || value instanceof CursorResult) {
    return { data: value.items, meta: value.meta };
  }
  return { data: value };
}

/**
 * Handlers devolvem o recurso (`{ data }`), um `PageResult`/`CursorResult` (`{ data, meta }`) ou
 * nada (204). Nenhuma rota monta o envelope à mão (RN-FND-37).
 */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map(toEnvelope));
  }
}
