import { describe, expect, it } from 'vitest';

import { NONCE_HEADER, PATHNAME_HEADER, edgeHeaders } from '@/bff/edge';
import {
  API_CSP,
  PERMISSIONS_POLICY,
  applyApiSecurityHeaders,
  baseSecurityHeaders,
  buildPageCsp,
  generateNonce,
} from '@/bff/security-headers';

const CSP_OPTIONS = {
  connectSources: ['https://q.s3.sa-east-1.amazonaws.com'],
  formActionSources: ['https://auth.contrataflow.com.br'],
  reportUri: '/api/csp-report',
  secure: true,
  development: false,
};

describe('CSP das páginas (security.md §8 · RN-FND-94)', () => {
  it('contém todas as diretivas com o nonce da requisição', () => {
    const csp = buildPageCsp({ ...CSP_OPTIONS, nonce: 'abc123' });
    expect(csp.split('; ')).toEqual([
      "default-src 'self'",
      "script-src 'self' 'nonce-abc123' 'strict-dynamic'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self' https://q.s3.sa-east-1.amazonaws.com",
      "frame-src 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self' https://auth.contrataflow.com.br",
      'upgrade-insecure-requests',
      'report-uri /api/csp-report',
      'report-to csp-endpoint',
    ]);
  });

  it("http://localhost sem upgrade-insecure-requests; 'unsafe-eval' só no next dev", () => {
    const local = buildPageCsp({ ...CSP_OPTIONS, nonce: 'n', secure: false, development: true });
    expect(local).not.toContain('upgrade-insecure-requests');
    expect(local).toContain("script-src 'self' 'nonce-n' 'strict-dynamic' 'unsafe-eval'");
    expect(buildPageCsp({ ...CSP_OPTIONS, nonce: 'n' })).not.toContain('unsafe-eval');
  });

  it('gera nonce imprevisível e diferente a cada requisição', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => generateNonce()));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(atob(nonce)).toHaveLength(16);
  });
});

describe('cabeçalhos comuns', () => {
  it('HSTS, nosniff, Referrer-Policy, Permissions-Policy, X-Frame-Options e COOP', () => {
    expect(baseSecurityHeaders('/api/csp-report')).toEqual({
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': PERMISSIONS_POLICY,
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Reporting-Endpoints': 'csp-endpoint="/api/csp-report"',
    });
    expect(PERMISSIONS_POLICY).toBe(
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    );
  });

  it('respostas de /api/* sem cache e com CSP sem script', () => {
    const headers = applyApiSecurityHeaders(new Headers({ 'Cache-Control': 'public' }));
    expect(headers.get('Cache-Control')).toBe('private, no-store');
    expect(headers.get('Content-Security-Policy')).toBe(API_CSP);
    expect(headers.get('X-Frame-Options')).toBe('DENY');
  });
});

describe('proxy.ts (edge)', () => {
  it('página: nonce na requisição e na resposta, caminho original para o returnTo', () => {
    const incoming = new Headers({ [NONCE_HEADER]: 'forjado', [PATHNAME_HEADER]: '/forjado' });
    const { requestHeaders, responseHeaders } = edgeHeaders(
      '/exemplo',
      '?page=2',
      incoming,
      CSP_OPTIONS,
      'nonce-fixo',
    );
    expect(requestHeaders.get(PATHNAME_HEADER)).toBe('/exemplo?page=2');
    expect(requestHeaders.get(NONCE_HEADER)).toBe('nonce-fixo');
    expect(requestHeaders.get('Content-Security-Policy')).toContain("'nonce-nonce-fixo'");
    expect(responseHeaders['Content-Security-Policy']).toBe(
      requestHeaders.get('Content-Security-Policy'),
    );
    expect(responseHeaders['Cache-Control']).toBe('private, no-store');
    expect(responseHeaders['Strict-Transport-Security']).toContain('max-age=63072000');
  });

  it('/api/*: CSP sem script e nenhum nonce (nem o forjado pelo browser)', () => {
    const { requestHeaders, responseHeaders } = edgeHeaders(
      '/api/v1/processes',
      '',
      new Headers({ [NONCE_HEADER]: 'forjado' }),
      CSP_OPTIONS,
    );
    expect(requestHeaders.get(NONCE_HEADER)).toBeNull();
    expect(responseHeaders['Content-Security-Policy']).toBe(API_CSP);
    expect(responseHeaders['X-Content-Type-Options']).toBe('nosniff');
  });
});
