import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';

import { describeRenditionError } from './rendition-errors';

/*
 * US-067 · "Casos de erro" de DOC-20..23 na SCR-105/106: 404, 409 `RENDITION_NOT_READY`, 403, 429 com
 * `Retry-After`, 503, sessão expirada e o inesperado com o `correlationId`.
 */

const PATH = '/processos/p/documentos/d';
const apiError = (
  status: number,
  code: string,
  extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {},
) => new ApiError({ status, code, correlationId: 'c-1', ...extra });

describe('describeRenditionError', () => {
  it('404 vira notFound (não distingue inexistente de sem acesso)', () => {
    expect(describeRenditionError(apiError(404, 'NOT_FOUND'), PATH)).toEqual({ kind: 'notFound' });
  });

  it('409 RENDITION_NOT_READY vira notReady com o detail', () => {
    const error = apiError(409, 'RENDITION_NOT_READY', {
      problem: {
        type: 'x',
        title: 'RENDITION_NOT_READY',
        status: 409,
        detail: 'Esta prévia expirou. Gere novamente.',
        code: 'RENDITION_NOT_READY',
      } as never,
    });
    expect(describeRenditionError(error, PATH)).toEqual({
      kind: 'notReady',
      detail: 'Esta prévia expirou. Gere novamente.',
    });
  });

  it('429 leva o Retry-After', () => {
    expect(
      describeRenditionError(apiError(429, 'RATE_LIMITED', { retryAfterSeconds: 7 }), PATH),
    ).toEqual({ kind: 'rateLimited', retryAfterSeconds: 7 });
  });

  it('503 vira unavailable; 403 vira forbidden', () => {
    expect(describeRenditionError(apiError(503, 'DEPENDENCY_UNAVAILABLE'), PATH).kind).toBe(
      'unavailable',
    );
    expect(describeRenditionError(apiError(403, 'PERMISSION_DENIED'), PATH).kind).toBe('forbidden');
  });

  it('sessão expirada é silenciosa e MFA redireciona', () => {
    expect(describeRenditionError(apiError(401, 'SESSION_EXPIRED'), PATH)).toEqual({
      kind: 'silent',
    });
    expect(describeRenditionError(apiError(403, 'MFA_REQUIRED'), PATH).kind).toBe('redirect');
  });

  it('o resto é inesperado, com o correlationId quando há', () => {
    expect(describeRenditionError(apiError(500, 'INTERNAL_ERROR'), PATH)).toEqual({
      kind: 'unexpected',
      correlationId: 'c-1',
    });
    expect(describeRenditionError(new Error('x'), PATH)).toEqual({
      kind: 'unexpected',
      correlationId: null,
    });
  });
});
