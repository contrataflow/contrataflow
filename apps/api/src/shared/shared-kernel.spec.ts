import { Readable } from 'node:stream';

import { HttpException, Logger, NotFoundException, StreamableFile } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { MfaGuard } from './auth/pipeline.guards.js';
import { isPublicRoute, RequireMfa } from './auth/route-access.js';
import { resolveCorrelationId } from './context/correlation.js';
import {
  currentRequestContext,
  RequestContextMissingError,
  requireRequestContext,
  runWithRequestContext,
  runWithTenantScope,
  TenantContextImmutableError,
  updateRequestContext,
} from './context/request-context.js';
import { ApiError, businessRuleViolation } from './errors/api-error.js';
import { problemType } from './errors/error-catalog.js';
import { toApiError } from './errors/problem-details.filter.js';
import { DataWithMembers, toEnvelope } from './http/envelope.interceptor.js';
import type { HttpRequest } from './http/http-types.js';
import { readJsonBody } from './http/json-body.middleware.js';
import {
  cursorResult,
  decodeCursor,
  encodeCursor,
  pageResult,
  pageWindow,
} from './http/pagination.js';
import { parseIfMatch } from './http/precondition.js';
import { canonicalJson } from './idempotency/idempotency.interceptor.js';
import { InMemoryIdempotencyStore } from './idempotency/in-memory-idempotency.store.js';
import { InMemoryRateLimitStore } from './rate-limit/in-memory-rate-limit.store.js';
import { decide } from './rate-limit/rate-limit.guard.js';
import { fieldErrorCode, toFieldErrors } from './validation/zod-issues.js';
import { ZodValidationPipe } from './validation/zod-validation.pipe.js';

const context = { correlationId: 'c-1', ip: '127.0.0.1', userAgent: 'vitest' };

beforeAll(() => {
  Logger.overrideLogger(false);
});

describe('RequestContext (AsyncLocalStorage)', () => {
  it('existe só dentro da execução e é completado pelos guards', async () => {
    expect(currentRequestContext()).toBeUndefined();
    expect(() => requireRequestContext()).toThrow(RequestContextMissingError);
    expect(() => updateRequestContext({ tenantId: 'x' })).toThrow(RequestContextMissingError);

    await runWithRequestContext(context, async () => {
      expect(requireRequestContext()).toMatchObject({ ...context, tenantId: null, amr: [] });
      await Promise.resolve();
      updateRequestContext({ tenantId: 't-1' });
      expect(requireRequestContext().tenantId).toBe('t-1');
    });
  });

  it('RN-TEN-21: o tenant é imutável depois de definido; contexto filho não muda de tenant', async () => {
    const A = '0192a000-0000-7000-8000-00000000000a';
    const B = '0192a000-0000-7000-8000-00000000000b';
    await runWithRequestContext(context, async () => {
      updateRequestContext({ tenantId: A });
      expect(() => updateRequestContext({ tenantId: B })).toThrow(TenantContextImmutableError);
      updateRequestContext({ tenantId: A, accessMode: 'READ_EXPORT' });
      expect(requireRequestContext()).toMatchObject({ tenantId: A, accessMode: 'READ_EXPORT' });
      const scope = { tenantId: B, userId: 'u', membershipId: 'm' };
      expect(() => runWithTenantScope(scope, () => 'x')).toThrow(TenantContextImmutableError);
      expect(
        runWithTenantScope({ ...scope, tenantId: A }, () => requireRequestContext().tenantId),
      ).toBe(A);
      await Promise.resolve();
    });
  });

  it('não vaza entre execuções concorrentes', async () => {
    const seen = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        runWithRequestContext({ ...context, correlationId: `c-${index}` }, async () => {
          await new Promise((resolve) => setTimeout(resolve, (index * 7) % 5));
          return requireRequestContext().correlationId;
        }),
      ),
    );
    expect(seen).toEqual(Array.from({ length: 50 }, (_, index) => `c-${index}`));
  });

  it('X-Correlation-Id: aceita valores seguros e gera um novo para os demais', () => {
    expect(resolveCorrelationId('c-7f3a2b')).toBe('c-7f3a2b');
    expect(resolveCorrelationId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveCorrelationId('x'.repeat(129))).not.toBe('x'.repeat(129));
    expect(resolveCorrelationId('a\nb')).not.toBe('a\nb');
  });
});

describe('erros (RFC 9457)', () => {
  it('mapeia exceções do Nest e desconhecidas', () => {
    expect(toApiError(new NotFoundException()).error.code).toBe('NOT_FOUND');
    for (const [status, code] of [
      [401, 'UNAUTHENTICATED'],
      [403, 'PERMISSION_DENIED'],
      [405, 'NOT_FOUND'],
      [409, 'CONFLICT'],
      [413, 'PAYLOAD_TOO_LARGE'],
      [415, 'UNSUPPORTED_MEDIA_TYPE'],
      [422, 'VALIDATION_ERROR'],
      [429, 'RATE_LIMITED'],
      [503, 'DEPENDENCY_UNAVAILABLE'],
      [502, 'INTERNAL_ERROR'],
      [418, 'MALFORMED_REQUEST'],
    ] as const) {
      const { error, unexpected } = toApiError(new HttpException('x', status));
      expect(error.code).toBe(code);
      expect(unexpected).toBe(status >= 500);
    }
    expect(toApiError('texto')).toMatchObject({
      unexpected: true,
      error: { code: 'INTERNAL_ERROR' },
    });
  });

  it('códigos de domínio e violações', () => {
    const error = businessRuleViolation(
      [
        {
          code: 'DFD_ITEMS_REQUIRED',
          severity: 'BLOCKING',
          message: 'Informe ao menos um item.',
          ruleId: null,
          sectionKey: null,
          field: null,
          itemId: null,
          params: {},
        },
      ],
      // Código de domínio ainda fora do catálogo: o título cai no próprio código.
      'EXAMPLE_RULE_INCOMPLETE',
    );
    expect(error).toMatchObject({
      status: 422,
      code: 'EXAMPLE_RULE_INCOMPLETE',
      title: 'EXAMPLE_RULE_INCOMPLETE',
    });
    expect(
      new ApiError('STAGE_CHANGED', { status: 409, title: 'Etapa alterada', detail: 'd' }).status,
    ).toBe(409);
    expect(new ApiError('SEM_CATALOGO').status).toBe(500);
    expect(problemType('IDEMPOTENCY_KEY_REUSED')).toBe(
      'https://docs.contrataflow.com.br/errors/idempotency-key-reused',
    );
  });
});

describe('validação Zod → errors[] (api.md §2.1.1)', () => {
  const schema = z.strictObject({
    name: z.string().min(1),
    code: z.string().max(3),
    tags: z.array(z.string()).min(2),
    kind: z.enum(['A', 'B']),
    email: z.email(),
    items: z.array(z.object({ quantity: z.number().max(10) })),
    cnpj: z.string().refine(() => false, { params: { code: 'INVALID_CNPJ' } }),
    other: z.string().refine(() => false),
  });

  it('traduz cada tipo de issue para a taxonomia e o caminho', () => {
    const pipe = new ZodValidationPipe(schema);
    let caught: unknown;
    try {
      pipe.transform({
        name: '',
        code: 'ABCD',
        tags: ['x'],
        kind: 'C',
        email: 'nao',
        items: [{ quantity: 11 }],
        cnpj: '1',
        other: 'x',
        extra: 1,
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as ApiError).errors.map(({ field, code }) => `${field}:${code}`)).toEqual([
      'name:REQUIRED',
      'code:TOO_LONG',
      'tags:TOO_SHORT',
      'kind:INVALID_ENUM',
      'email:INVALID_FORMAT',
      'items[0].quantity:OUT_OF_RANGE',
      'cnpj:INVALID_CNPJ',
      'other:INVALID_FORMAT',
      'extra:NOT_ALLOWED',
    ]);
  });

  it('devolve o valor convertido e aceita prefixo de campo', () => {
    expect(new ZodValidationPipe(z.object({ n: z.coerce.number() })).transform({ n: '2' })).toEqual(
      { n: 2 },
    );
    const issues = z.object({ a: z.string() }).safeParse({}).error?.issues ?? [];
    expect(toFieldErrors(issues, 'body')).toEqual([
      { field: 'body.a', code: 'REQUIRED', message: expect.any(String) as string },
    ]);
    expect(
      fieldErrorCode({ code: 'invalid_union', errors: [], path: [], message: 'x', input: 1 }),
    ).toBe('INVALID_FORMAT');
  });
});

describe('paginação, envelope e If-Match', () => {
  it('janela, resultado por página e por cursor', () => {
    const window = pageWindow({ page: 3, pageSize: 50 }, 20);
    expect(window).toEqual({ page: 3, pageSize: 20, skip: 40, take: 20 });
    expect(pageResult(['a'], window, 41).meta).toEqual({
      page: 3,
      pageSize: 20,
      totalItems: 41,
      totalPages: 3,
    });
    const feed = cursorResult([1, 2, 3], 2, (item) => ({ after: item }));
    expect(feed.items).toEqual([1, 2]);
    const position = z.object({ after: z.int() });
    expect(decodeCursor(feed.meta.nextCursor ?? '', position)).toEqual({ after: 2 });
    expect(cursorResult([1], 2, (item) => ({ after: item })).meta).toEqual({
      nextCursor: null,
      hasMore: false,
    });
    expect(decodeCursor(encodeCursor({ id: 'x' }), z.object({ id: z.string() }))).toEqual({
      id: 'x',
    });
    expect(() => decodeCursor('!!', position)).toThrow(ApiError);
    expect(() => decodeCursor(encodeCursor({ after: 'x' }), position)).toThrow(ApiError);
    expect(() => decodeCursor(Buffer.from('[1]').toString('base64url'), position)).toThrow(
      ApiError,
    );
  });

  it('envelope de DEC-106', () => {
    expect(toEnvelope({ id: 1 })).toEqual({ data: { id: 1 } });
    expect(toEnvelope(undefined)).toBeUndefined();
    // Membros irmãos fixados no contrato (ATT-02: `{ data, upload }`); `data` não é sobrescrito.
    expect(toEnvelope(new DataWithMembers({ id: 1 }, { upload: { url: 'u' }, data: 'x' }))).toEqual(
      { data: { id: 1 }, upload: { url: 'u' } },
    );
    expect(toEnvelope(pageResult([1], { page: 1, pageSize: 1 }, 1))).toEqual({
      data: [1],
      meta: { page: 1, pageSize: 1, totalItems: 1, totalPages: 1 },
    });
    // Arquivo em *streaming* (AUD-03 · US-075): o corpo é o arquivo, sem envelope.
    const file = new StreamableFile(Buffer.from('a,b'));
    expect(toEnvelope(file)).toBe(file);
  });

  it('If-Match: versão, revisão de seção, ETag fraca e valores inválidos', () => {
    expect(parseIfMatch('"12"')).toEqual({ kind: 'version', value: 12 });
    expect(parseIfMatch('"s3"')).toEqual({ kind: 'section', value: 3 });
    expect(parseIfMatch('W/"4"')).toEqual({ kind: 'version', value: 4 });
    expect(parseIfMatch('12')).toBeNull();
    expect(parseIfMatch(undefined)).toBeNull();
  });
});

describe('corpo JSON', () => {
  const body = (payload: string, headers: Record<string, string>) =>
    Object.assign(Readable.from([Buffer.from(payload)]), { headers }) as unknown as HttpRequest;

  it('lê JSON com charset utf-8, ignora corpo vazio e recusa outro charset', async () => {
    await expect(
      readJsonBody(
        body('{"a":1}', {
          'content-length': '7',
          'content-type': 'application/json; charset=UTF-8',
        }),
      ),
    ).resolves.toEqual({ a: 1 });
    await expect(
      readJsonBody(
        body('{"a":1}', {
          'transfer-encoding': 'chunked',
          'content-type': 'application/merge-patch+json',
        }),
      ),
    ).resolves.toEqual({ a: 1 });
    await expect(readJsonBody(body('', { 'content-length': '0' }))).resolves.toBeUndefined();
    await expect(
      readJsonBody(
        body('{}', { 'content-length': '2', 'content-type': 'application/json; charset=latin1' }),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    await expect(
      readJsonBody(
        body('{"a":12}', { 'content-length': '8', 'content-type': 'application/json' }),
        4,
      ),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
});

describe('idempotência e rate limit (funções puras e armazenamentos em memória)', () => {
  it('canonicalJson ignora ordem de chaves e undefined', () => {
    expect(canonicalJson({ b: [1, { d: 1, c: undefined }], a: 'x' })).toBe(
      canonicalJson({ a: 'x', b: [1, { d: 1 }] }),
    );
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('armazenamento de idempotência em memória: reserva atômica, conclusão, liberação e expiração', async () => {
    const store = new InMemoryIdempotencyStore();
    await expect(store.begin('k', 'h', 60_000)).resolves.toBeNull();
    await expect(store.begin('k', 'h', 60_000)).resolves.toEqual({
      state: 'IN_PROGRESS',
      bodyHash: 'h',
    });
    await store.complete(
      'k',
      { state: 'DONE', bodyHash: 'h', response: { status: 201, headers: {} } },
      60_000,
    );
    await expect(store.begin('k', 'h', 60_000)).resolves.toMatchObject({ state: 'DONE' });
    await store.release('k');
    await expect(store.begin('k', 'h', -1)).resolves.toBeNull();
    await expect(store.begin('k', 'h', 60_000)).resolves.toBeNull();
  });

  it('janela deslizante: pondera a janela anterior pelo tempo decorrido', () => {
    expect(decide({ current: 1, previous: 10 }, 10, 60_000, 30_000)).toMatchObject({
      allowed: true,
      remaining: 4,
      resetSeconds: 30,
    });
    expect(decide({ current: 6, previous: 10 }, 10, 60_000, 30_000).allowed).toBe(false);
    expect(decide({ current: 11, previous: 0 }, 10, 60_000, 59_999)).toMatchObject({
      allowed: false,
      remaining: 0,
      resetSeconds: 1,
    });
  });

  it('armazenamento de rate limit em memória lê a janela anterior', async () => {
    const store = new InMemoryRateLimitStore();
    await store.increment('k', 1);
    await store.increment('k', 1);
    await expect(store.increment('k', 2)).resolves.toEqual({ current: 1, previous: 2 });
  });
});

describe('rotas públicas e MFA', () => {
  it('allowlist de rotas públicas (FA-06)', () => {
    expect(isPublicRoute({ originalUrl: '/health/ready' })).toBe(true);
    expect(isPublicRoute({ originalUrl: '/metrics?x=1' })).toBe(true);
    expect(isPublicRoute({ originalUrl: '/api/v1/health/ready' })).toBe(false);
  });

  it('MfaGuard: só atua com @RequireMfa e exige amr de segundo fator', async () => {
    class Handlers {
      @RequireMfa()
      sensitive() {
        // só os metadados importam
      }
      plain() {
        // só os metadados importam
      }
    }
    const guard = new MfaGuard(new Reflector());
    const at = (name: 'sensitive' | 'plain') =>
      ({
        getHandler: () => Reflect.get(Handlers.prototype, name) as object,
        getClass: () => Handlers,
      }) as unknown as ExecutionContext;

    await runWithRequestContext(context, () => {
      expect(guard.canActivate(at('plain'))).toBe(true);
      updateRequestContext({ amr: ['pwd'] });
      expect(() => guard.canActivate(at('sensitive'))).toThrow(
        expect.objectContaining({ code: 'MFA_REQUIRED' }),
      );
      updateRequestContext({ amr: ['pwd', 'otp'] });
      expect(guard.canActivate(at('sensitive'))).toBe(true);
      return Promise.resolve();
    });
  });
});
