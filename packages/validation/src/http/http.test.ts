import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  cursorEnvelope,
  cursorQuerySchema,
  dataEnvelope,
  pageEnvelope,
  pageQuerySchema,
  problemDetailsSchema,
} from './index.js';

describe('pageQuerySchema', () => {
  it('aplica os padrões e converte a query string', () => {
    expect(pageQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(pageQuerySchema.parse({ page: '3', pageSize: '100' })).toEqual({
      page: 3,
      pageSize: 100,
    });
  });

  it.each([
    [{ pageSize: '101' }, 'pageSize'],
    [{ page: '0' }, 'page'],
    [{ page: 'abc' }, 'page'],
    [{ page: '1.5' }, 'page'],
  ])('recusa %o', (query, field) => {
    const result = pageQuerySchema.safeParse(query);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([field]);
  });

  it('é estrito: parâmetro desconhecido é recusado', () => {
    expect(pageQuerySchema.safeParse({ foo: '1' }).success).toBe(false);
  });

  it('pode ser estendido com filtros do endpoint', () => {
    const schema = pageQuerySchema.extend({ status: z.string().optional() });
    expect(schema.parse({ status: 'DRAFT' })).toEqual({ page: 1, pageSize: 20, status: 'DRAFT' });
  });
});

describe('cursorQuerySchema', () => {
  it('aplica o limite padrão de 50 e aceita cursor opaco base64url', () => {
    expect(cursorQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(cursorQuerySchema.parse({ cursor: 'eyJpZCI6MX0', limit: '10' })).toEqual({
      cursor: 'eyJpZCI6MX0',
      limit: 10,
    });
  });

  it('recusa limite acima de 100 e cursor fora do alfabeto base64url', () => {
    expect(cursorQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(cursorQuerySchema.safeParse({ cursor: 'a b' }).success).toBe(false);
  });
});

describe('envelopes', () => {
  const item = z.object({ id: z.string() });

  it('recurso único', () => {
    expect(dataEnvelope(item).safeParse({ data: { id: 'a' } }).success).toBe(true);
  });

  it('lista paginada e feed', () => {
    expect(
      pageEnvelope(item).safeParse({
        data: [{ id: 'a' }],
        meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
      }).success,
    ).toBe(true);
    expect(
      cursorEnvelope(item).safeParse({ data: [], meta: { nextCursor: null, hasMore: false } })
        .success,
    ).toBe(true);
  });
});

describe('problemDetailsSchema', () => {
  it('aceita o exemplo de VALIDATION_ERROR da US-080', () => {
    const body = {
      type: 'https://docs.contrataflow.com.br/errors/validation-error',
      title: 'Dados inválidos',
      status: 422,
      detail: 'Revise os campos destacados.',
      instance: '/api/v1/_internal/echo',
      code: 'VALIDATION_ERROR',
      correlationId: 'c-7f3a2b',
      errors: [{ field: 'name', code: 'REQUIRED', message: 'Informe o nome.' }],
      violations: [],
    };
    expect(problemDetailsSchema.parse(body)).toEqual(body);
  });

  it('recusa código fora de SCREAMING_SNAKE_CASE e código de campo desconhecido', () => {
    const base = {
      type: 'https://docs.contrataflow.com.br/errors/x',
      title: 't',
      status: 400,
      detail: 'd',
      instance: '/',
      correlationId: 'c',
      violations: [],
    };
    expect(problemDetailsSchema.safeParse({ ...base, code: 'bad', errors: [] }).success).toBe(
      false,
    );
    expect(
      problemDetailsSchema.safeParse({
        ...base,
        code: 'VALIDATION_ERROR',
        errors: [{ field: 'x', code: 'NOPE', message: 'm' }],
      }).success,
    ).toBe(false);
  });
});
