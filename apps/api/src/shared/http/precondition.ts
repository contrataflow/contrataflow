import { createParamDecorator, Injectable, SetMetadata } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { headerValue } from './http-types.js';
import type { HttpRequest } from './http-types.js';
import { ApiError } from '../errors/api-error.js';

export const REQUIRE_IF_MATCH_METADATA = 'cf:http:require-if-match';

/**
 * Mutação sobre recurso versionado (DEC-104): exige `If-Match`. Sem o cabeçalho → 428
 * `PRECONDITION_REQUIRED` (V-10). A comparação com a versão (412) é do caso de uso.
 */
export const RequireIfMatch = (): MethodDecorator => SetMetadata(REQUIRE_IF_MATCH_METADATA, true);

/** `"12"` → `{ kind: 'version', value: 12 }`; `"s3"` → revisão de seção (api.md §1.3). */
export type IfMatchValue = { kind: 'version'; value: number } | { kind: 'section'; value: number };

export function parseIfMatch(header: string | undefined): IfMatchValue | null {
  const match = /^(?:W\/)?"(s?)(\d{1,9})"$/.exec(header?.trim() ?? '');
  if (!match) return null;
  return { kind: match[1] === 's' ? 'section' : 'version', value: Number(match[2]) };
}

/** Guard global; só atua nas rotas com `@RequireIfMatch()`. */
@Injectable()
export class PreconditionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (
      this.reflector.get<boolean | undefined>(REQUIRE_IF_MATCH_METADATA, context.getHandler()) !==
      true
    ) {
      return true;
    }
    const request = context.switchToHttp().getRequest<HttpRequest>();
    if (parseIfMatch(headerValue(request, 'if-match')) === null) {
      throw new ApiError('PRECONDITION_REQUIRED');
    }
    return true;
  }
}

/** `@IfMatch()` no parâmetro do handler: versão esperada já interpretada. */
export const IfMatch = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  parseIfMatch(headerValue(context.switchToHttp().getRequest<HttpRequest>(), 'if-match')),
);
