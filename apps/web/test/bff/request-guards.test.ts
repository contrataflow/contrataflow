import { describe, expect, it } from 'vitest';

import { clientIpFrom, isInCidr, isTrustedProxy } from '@/bff/client-ip';
import {
  clearCookie,
  decodeLoginTransaction,
  encodeLoginTransaction,
  readCookie,
  serializeCookie,
} from '@/bff/cookies';
import { isValidCorrelationId, resolveCorrelationId } from '@/bff/correlation';
import { checkCsrf, isMutatingMethod } from '@/bff/csrf';
import { safeReturnTo } from '@/bff/return-to';
import type { Ipv4Cidr } from '@/config/env';
import { parseCidr } from '@/config/env';

const ORIGIN = 'https://app.contrataflow.com.br';

describe('CSRF em métodos mutáveis (V-01/V-02 · DEC-135)', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post'])('%s é mutável', (method) => {
    expect(isMutatingMethod(method)).toBe(true);
  });

  it('GET passa sem cabeçalho', () => {
    expect(checkCsrf('GET', new Headers(), ORIGIN)).toEqual({ ok: true });
  });

  it('V-01: sem X-CF-Request → recusado', () => {
    const headers = new Headers({ 'Sec-Fetch-Site': 'same-origin' });
    expect(checkCsrf('POST', headers, ORIGIN)).toEqual({ ok: false, reason: 'MISSING_HEADER' });
    headers.set('X-CF-Request', '0');
    expect(checkCsrf('POST', headers, ORIGIN)).toEqual({ ok: false, reason: 'MISSING_HEADER' });
  });

  it('V-02: Sec-Fetch-Site de outra origem/site → recusado', () => {
    for (const site of ['same-site', 'cross-site', 'none']) {
      const headers = new Headers({ 'X-CF-Request': '1', 'Sec-Fetch-Site': site, Origin: ORIGIN });
      expect(checkCsrf('POST', headers, ORIGIN)).toEqual({ ok: false, reason: 'CROSS_ORIGIN' });
    }
  });

  it('sem Sec-Fetch-Site: Origin deve ser APP_BASE_URL', () => {
    const ok = new Headers({ 'X-CF-Request': '1', Origin: ORIGIN });
    expect(checkCsrf('DELETE', ok, ORIGIN)).toEqual({ ok: true });
    const evil = new Headers({ 'X-CF-Request': '1', Origin: 'https://evil.contrataflow.com.br' });
    expect(checkCsrf('DELETE', evil, ORIGIN)).toEqual({ ok: false, reason: 'CROSS_ORIGIN' });
    expect(checkCsrf('DELETE', new Headers({ 'X-CF-Request': '1' }), ORIGIN)).toEqual({
      ok: false,
      reason: 'CROSS_ORIGIN',
    });
  });

  it('same-origin com cabeçalho → aceito', () => {
    const headers = new Headers({ 'X-CF-Request': '1', 'Sec-Fetch-Site': 'same-origin' });
    expect(checkCsrf('PATCH', headers, ORIGIN)).toEqual({ ok: true });
  });
});

describe('correlationId recebido do browser (regra da US-084)', () => {
  it.each(['c-7f3a2b9e', 'a.b:c_d-1', 'x'.repeat(64)])('aceita %s', (value) => {
    expect(isValidCorrelationId(value)).toBe(true);
    expect(resolveCorrelationId(value)).toBe(value);
  });

  it.each([
    '',
    'c-7f3a',
    'a b c',
    'com espaço',
    'quebra\nde-linha',
    'x'.repeat(65),
    '<script>',
    null,
    undefined,
  ])('descarta %j e gera um UUIDv7 (V-01)', (value) => {
    expect(isValidCorrelationId(value)).toBe(false);
    expect(resolveCorrelationId(value)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('IP do cliente (TRUSTED_PROXY_CIDRS — RN-FND-94)', () => {
  const trusted = ['10.0.0.0/8', '127.0.0.1/32'].map((cidr) => parseCidr(cidr)) as Ipv4Cidr[];

  it('usa o último salto não confiável (adicionado pelo ALB)', () => {
    expect(clientIpFrom('1.1.1.1, 200.1.2.3, 10.0.0.5', trusted)).toBe('200.1.2.3');
    expect(clientIpFrom('200.1.2.3', trusted)).toBe('200.1.2.3');
  });

  it('nunca aceita valor forjado pelo cliente à esquerda', () => {
    // O cliente enviou "9.9.9.9"; o ALB acrescentou o IP real 200.1.2.3.
    expect(clientIpFrom('9.9.9.9, 200.1.2.3', trusted)).toBe('200.1.2.3');
  });

  it('sem cabeçalho, só proxies ou salto ilegível → null', () => {
    expect(clientIpFrom(null, trusted)).toBeNull();
    expect(clientIpFrom('10.0.0.1, 127.0.0.1', trusted)).toBeNull();
    expect(clientIpFrom('lixo, 10.0.0.1', trusted)).toBeNull();
    expect(clientIpFrom(' , ', trusted)).toBeNull();
  });

  it('pertinência a CIDR', () => {
    const cidr: Ipv4Cidr = { network: 3232235520, prefix: 16 };
    expect(parseCidr('192.168.0.0/16')).toEqual(cidr);
    expect(isInCidr('192.168.255.1', cidr)).toBe(true);
    expect(isInCidr('192.169.0.1', cidr)).toBe(false);
    expect(isInCidr('não-ip', cidr)).toBe(false);
    expect(isTrustedProxy('127.0.0.1', trusted)).toBe(true);
    expect(isInCidr('8.8.8.8', { network: 0, prefix: 0 })).toBe(true);
  });
});

describe('returnTo (anti open redirect)', () => {
  it.each([
    ['/exemplo', '/exemplo'],
    ['/processos?status=DRAFT#topo', '/processos?status=DRAFT#topo'],
    [
      '/processos/0192a000-0000-7000-8000-00000000000a',
      '/processos/0192a000-0000-7000-8000-00000000000a',
    ],
  ])('aceita %s', (value, expected) => {
    expect(safeReturnTo(value)).toBe(expected);
  });

  it.each([
    null,
    '',
    'https://evil.com',
    '//evil.com',
    '/\\evil.com',
    '/%2f%2fevil.com',
    '%2F%2Fevil.com',
    'javascript:alert(1)',
    '/a\r\nSet-Cookie:x',
    '/api/auth/logout',
    '/%E0%A4%A',
    `/${'a'.repeat(2048)}`,
  ])('recusa %j', (value) => {
    expect(safeReturnTo(value)).toBeNull();
  });
});

describe('cookies do BFF (DEC-131)', () => {
  it('atributos obrigatórios: HttpOnly, Secure, SameSite=Lax, Path=/', () => {
    expect(serializeCookie('__Host-cf_session', 'abc')).toBe(
      '__Host-cf_session=abc; Path=/; HttpOnly; Secure; SameSite=Lax',
    );
    expect(clearCookie('__Host-cf_session')).toBe(
      '__Host-cf_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    );
  });

  it('lê o cookie pelo nome exato', () => {
    const headers = new Headers({ Cookie: 'a=1; __Host-cf_session=xyz; quebrado; vazio=' });
    expect(readCookie(headers, '__Host-cf_session')).toBe('xyz');
    expect(readCookie(headers, 'vazio')).toBeNull();
    expect(readCookie(headers, 'b')).toBeNull();
    expect(readCookie(new Headers(), 'a')).toBeNull();
  });

  it('transação de login: ida e volta; valor corrompido → null', () => {
    const value = encodeLoginTransaction({ state: 's', returnTo: '/x', stepUp: true });
    expect(decodeLoginTransaction(value)).toEqual({ state: 's', returnTo: '/x', stepUp: true });
    expect(decodeLoginTransaction(null)).toBeNull();
    expect(decodeLoginTransaction('%%%')).toBeNull();
    expect(decodeLoginTransaction(Buffer.from('{"state":1}').toString('base64url'))).toBeNull();
  });
});
