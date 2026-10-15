import { describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  apiErrorFromResponse,
  fallbackCode,
  isApiError,
  parseRetryAfter,
} from './api-error';
import { applyErrorEffect } from './error-effects';
import type { ErrorEffectDeps } from './error-effects';
import { loginHref, resolveErrorAction, stepUpHref } from './error-policy';

const PROBLEM = {
  type: 'https://docs.contrataflow.com.br/errors/validation-error',
  title: 'Erro de validação',
  status: 422,
  detail: 'Dados inválidos.',
  instance: '/api/v1/x',
  code: 'VALIDATION_ERROR',
  correlationId: 'c-1',
  errors: [{ field: 'name', code: 'REQUIRED', message: 'Campo obrigatório.' }],
  violations: [],
};

describe('ApiError (RFC 9457)', () => {
  it('interpreta problem+json completo', () => {
    const error = apiErrorFromResponse(422, new Headers(), PROBLEM);
    expect(isApiError(error)).toBe(true);
    expect(error).toMatchObject({
      status: 422,
      code: 'VALIDATION_ERROR',
      correlationId: 'c-1',
      message: 'Dados inválidos.',
      errors: PROBLEM.errors,
    });
    expect(error.problem?.instance).toBe('/api/v1/x');
  });

  it('corpo fora do padrão: código do corpo, do status e correlação do cabeçalho', () => {
    const headers = new Headers({ 'X-Correlation-Id': 'c-h', 'Retry-After': '7' });
    expect(apiErrorFromResponse(429, headers, { code: 'RATE_LIMITED' })).toMatchObject({
      code: 'RATE_LIMITED',
      correlationId: 'c-h',
      retryAfterSeconds: 7,
    });
    expect(apiErrorFromResponse(502, new Headers(), null)).toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      correlationId: null,
    });
    expect(new ApiError({ status: 500, code: 'X' }).message).toBe('Falha na chamada à API (X).');
    expect(isApiError(new Error('x'))).toBe(false);
  });

  it.each([
    [400, 'MALFORMED_REQUEST'],
    [401, 'UNAUTHENTICATED'],
    [403, 'PERMISSION_DENIED'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [412, 'VERSION_CONFLICT'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [422, 'VALIDATION_ERROR'],
    [429, 'RATE_LIMITED'],
    [500, 'INTERNAL_ERROR'],
    [503, 'DEPENDENCY_UNAVAILABLE'],
    [504, 'DEPENDENCY_UNAVAILABLE'],
  ])('código genérico de %i', (status, code) => {
    expect(fallbackCode(status)).toBe(code);
  });

  it('Retry-After em segundos ou data HTTP', () => {
    const now = Date.parse('2026-10-14T12:00:00Z');
    expect(parseRetryAfter('12', now)).toBe(12);
    expect(parseRetryAfter('Wed, 14 Oct 2026 12:00:30 GMT', now)).toBe(30);
    expect(parseRetryAfter('Wed, 14 Oct 2026 11:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('amanhã', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});

describe('política de erros (architecture.md §8.12 · RN-FND-93)', () => {
  const path = '/processos?page=2';
  const action = (status: number, code: string, retryAfterSeconds: number | null = null) =>
    resolveErrorAction({ status, code, retryAfterSeconds }, path);

  it.each([
    // Sessão expirada: modal (US-088), a tela e o que foi digitado continuam.
    [401, 'SESSION_EXPIRED', { kind: 'session-expired' }],
    [
      401,
      'UNAUTHENTICATED',
      { kind: 'redirect', href: '/api/auth/login?returnTo=%2Fprocessos%3Fpage%3D2' },
    ],
    [
      403,
      'MFA_REQUIRED',
      { kind: 'redirect', href: '/api/auth/step-up?returnTo=%2Fprocessos%3Fpage%3D2' },
    ],
    [403, 'MEMBERSHIP_INACTIVE', { kind: 'redirect', href: '/erro/vinculo-inativo' }],
    [403, 'TENANT_SUSPENDED', { kind: 'redirect', href: '/erro/acesso-indisponivel' }],
    [403, 'USER_BLOCKED', { kind: 'redirect', href: '/erro/403' }],
    [403, 'CSRF_REJECTED', { kind: 'reload' }],
    [403, 'NOT_DESIGNATED_APPROVER', { kind: 'inline' }],
    [404, 'NOT_FOUND', { kind: 'not-found' }],
    [409, 'CONFLICT', { kind: 'conflict' }],
    [409, 'IDEMPOTENCY_IN_PROGRESS', { kind: 'inline' }],
    [412, 'VERSION_CONFLICT', { kind: 'conflict' }],
    [422, 'VALIDATION_ERROR', { kind: 'inline' }],
    [500, 'INTERNAL_ERROR', { kind: 'boundary' }],
    // Indisponibilidade: banner com "Tentar novamente", nunca "sessão expirada" (RN-IAM-33).
    [503, 'DEPENDENCY_UNAVAILABLE', { kind: 'unavailable' }],
    [504, 'GATEWAY_TIMEOUT', { kind: 'boundary' }],
  ])('%i %s', (status, code, expected) => {
    expect(action(status, code)).toEqual(expected);
  });

  it('US-100: 400 sem instituição ativa (X-Tenant-Id) refaz a seleção; outro 400 fica na tela', () => {
    const tenantHeader = {
      status: 400,
      code: 'MALFORMED_REQUEST',
      retryAfterSeconds: null,
      errors: [
        {
          field: 'X-Tenant-Id',
          code: 'REQUIRED' as const,
          message: 'Não foi possível identificar a instituição ativa. Entre novamente.',
        },
      ],
    };
    expect(resolveErrorAction(tenantHeader, path)).toEqual({
      kind: 'redirect',
      href: '/selecionar-orgao',
    });
    expect(resolveErrorAction({ ...tenantHeader, errors: [] }, path)).toEqual({ kind: 'inline' });
  });

  it('429 carrega o Retry-After', () => {
    expect(action(429, 'RATE_LIMITED', 8)).toEqual({ kind: 'rate-limited', retryAfterSeconds: 8 });
    expect(stepUpHref('/a')).toBe('/api/auth/step-up?returnTo=%2Fa');
    expect(loginHref('/a', { reauthenticate: true })).toBe(
      '/api/auth/login?returnTo=%2Fa&reauth=1',
    );
  });
});

describe('efeitos globais', () => {
  function deps(): ErrorEffectDeps & { calls: Record<string, unknown[]> } {
    const calls: Record<string, unknown[]> = { navigate: [], notify: [], conflict: [] };
    return {
      calls,
      currentPath: () => '/exemplo',
      navigate: (href) => calls.navigate?.push(href),
      openConflict: () => calls.conflict?.push(true),
      notify: (input) => calls.notify?.push(input),
      messages: {
        rateLimited: (seconds) => `aguarde ${String(seconds)}`,
        csrf: 'csrf',
        csrfHint: 'recarregue',
        unexpected: 'inesperado',
        notFound: 'não encontrado',
        correlation: (id) => `Código: ${id}`,
      },
    };
  }

  it('401 UNAUTHENTICATED leva ao login; SESSION_EXPIRED e 503 não navegam (modal/banner)', () => {
    const d = deps();
    applyErrorEffect(new ApiError({ status: 401, code: 'UNAUTHENTICATED' }), 'query', d);
    applyErrorEffect(new ApiError({ status: 401, code: 'SESSION_EXPIRED' }), 'mutation', d);
    applyErrorEffect(new ApiError({ status: 503, code: 'DEPENDENCY_UNAVAILABLE' }), 'mutation', d);
    expect(d.calls.navigate).toEqual(['/api/auth/login?returnTo=%2Fexemplo']);
    expect(d.calls.notify).toEqual([]);
  });

  it('mutação: conflito abre o diálogo; 5xx vira toast com correlationId', () => {
    const d = deps();
    applyErrorEffect(new ApiError({ status: 412, code: 'VERSION_CONFLICT' }), 'mutation', d);
    applyErrorEffect(
      new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c-9' }),
      'mutation',
      d,
    );
    applyErrorEffect(new ApiError({ status: 404, code: 'NOT_FOUND' }), 'mutation', d);
    applyErrorEffect(new Error('desconhecido'), 'mutation', d);
    expect(d.calls.conflict).toEqual([true]);
    expect(d.calls.notify).toEqual([
      { title: 'inesperado', description: 'Código: c-9', tone: 'error' },
      { title: 'não encontrado', tone: 'error' },
      { title: 'inesperado', tone: 'error' },
    ]);
  });

  it('consulta: 404/5xx/conflito ficam com o boundary; 429 e CSRF avisam', () => {
    const d = deps();
    const notify = vi.spyOn(d, 'notify');
    for (const [status, code] of [
      [404, 'NOT_FOUND'],
      [500, 'INTERNAL_ERROR'],
      [409, 'CONFLICT'],
      [422, 'VALIDATION_ERROR'],
    ] as const) {
      applyErrorEffect(new ApiError({ status, code }), 'query', d);
    }
    applyErrorEffect(new Error('x'), 'query', d);
    expect(notify).not.toHaveBeenCalled();
    applyErrorEffect(
      new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSeconds: 5 }),
      'query',
      d,
    );
    applyErrorEffect(new ApiError({ status: 403, code: 'CSRF_REJECTED' }), 'query', d);
    expect(d.calls.notify).toEqual([
      { title: 'aguarde 5', tone: 'info' },
      { title: 'csrf', description: 'recarregue', tone: 'error' },
    ]);
    expect(d.calls.conflict).toEqual([]);
  });
});
