import { describe, expect, it } from 'vitest';

import {
  REDACTED,
  SENSITIVE_KEYS,
  isSensitiveKey,
  maskEmail,
  redact,
  scrubText,
  serializeError,
} from './redaction.js';

const SECRET = 'valor-secreto-123';

describe('redação por campo (DEC-138 · RN-FND-73)', () => {
  it.each(SENSITIVE_KEYS.filter((key) => key !== 'email'))('redige o campo %s', (key) => {
    const output = redact({
      [key]: SECRET,
      nested: { deeper: { [key]: SECRET } },
      list: [{ [key]: SECRET }],
    });
    expect(JSON.stringify(output)).not.toContain(SECRET);
    expect(output).toMatchObject({ [key]: REDACTED, nested: { deeper: { [key]: REDACTED } } });
  });

  it('compara nomes sem caixa nem separadores', () => {
    for (const key of [
      'access_token',
      'Access-Token',
      'ACCESSTOKEN',
      'set-cookie',
      'draft_content',
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    expect(isSensitiveKey('errorCode')).toBe(false);
    expect(isSensitiveKey('tenantId')).toBe(false);
  });

  it('mascara e-mail em vez de omitir', () => {
    expect(redact({ email: 'joao.silva@dominio.gov.br' })).toEqual({
      email: 'j***@dominio.gov.br',
    });
    expect(maskEmail('sem-arroba')).toBe(REDACTED);
    expect(maskEmail(42)).toBe(REDACTED);
    expect(maskEmail('@dominio')).toBe(REDACTED);
  });

  it('redige cabeçalhos sensíveis de requisição e resposta', () => {
    const output = redact({
      req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1', 'user-agent': 'k6' } },
      res: { headers: { 'set-cookie': ['sid=1'] } },
    });
    expect(output).toEqual({
      req: { headers: { authorization: REDACTED, cookie: REDACTED, 'user-agent': 'k6' } },
      res: { headers: { 'set-cookie': REDACTED } },
    });
  });

  it('preserva campos permitidos, datas e tipos primitivos', () => {
    const at = new Date('2026-10-14T12:00:00.000Z');
    expect(redact({ tenantId: 't-1', statusCode: 200, ok: true, at, none: null })).toEqual({
      tenantId: 't-1',
      statusCode: 200,
      ok: true,
      at: '2026-10-14T12:00:00.000Z',
      none: null,
    });
  });

  it('interrompe ciclos e profundidade excessiva', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(redact(cyclic)).toEqual({ a: 1, self: '[Circular]' });
    let deep: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 10; index += 1) deep = { child: deep };
    expect(JSON.stringify(redact(deep))).toContain('[Truncated]');
  });
});

describe('redação por padrão de texto', () => {
  it.each([
    ['JWT', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJh recebido', 'eyJ'],
    ['Bearer', 'Authorization: Bearer abc.def-ghi', 'abc.def'],
    ['CPF', 'cpf 123.456.789-09 inválido', '123.456.789-09'],
    [
      'URL pré-assinada',
      'GET https://s3.local/bucket/x.pdf?X-Amz-Credential=AK&X-Amz-Signature=ff00 falhou',
      'X-Amz-Signature',
    ],
  ])('remove %s de textos livres', (_label, text, forbidden) => {
    expect(scrubText(text)).not.toContain(forbidden);
    expect(scrubText(text)).toContain(REDACTED);
  });

  it('mascara e-mail no meio do texto', () => {
    expect(scrubText('convite para maria@orgao.gov.br enviado')).toBe(
      'convite para m***@orgao.gov.br enviado',
    );
  });

  it('não altera UUIDs nem códigos técnicos', () => {
    const text = 'id=0193a1b2-7c00-7abc-8def-0123456789ab code=VALIDATION_ERROR';
    expect(scrubText(text)).toBe(text);
  });
});

describe('serializeError', () => {
  it('extrai tipo, mensagem redigida, código e stack', () => {
    const error = Object.assign(new TypeError('falha com maria@orgao.gov.br'), { code: 'E_X' });
    const serialized = serializeError(error);
    expect(serialized).toMatchObject({
      type: 'TypeError',
      message: 'falha com m***@orgao.gov.br',
      code: 'E_X',
    });
    expect(serialized.stack).toContain('TypeError');
    expect(serializeError(error, { stack: false }).stack).toBeUndefined();
  });

  it('aceita erro já serializado e valores que não são Error', () => {
    expect(serializeError({ type: 'X', message: 'm', stack: 's' }, { stack: false })).toEqual({
      type: 'X',
      message: 'm',
    });
    expect(serializeError({ message: 'm', code: 'C' })).toEqual({
      type: 'Error',
      message: 'm',
      code: 'C',
    });
    expect(serializeError('texto')).toEqual({ type: 'string', message: 'texto' });
  });

  it('é aplicado a erros aninhados no objeto logado', () => {
    const output = redact({ cause: new Error('x') }) as { cause: { type: string } };
    expect(output.cause.type).toBe('Error');
  });
});
