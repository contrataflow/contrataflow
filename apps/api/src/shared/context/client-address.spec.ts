import { describe, expect, it } from 'vitest';

import { normalizeIp, resolveClientAddress, trustedProxyList } from './client-address.js';
import {
  currentRequestContext,
  runAsSystem,
  runWithClientDetails,
  runWithRequestContext,
} from './request-context.js';

const SESSION = 'b'.repeat(64);

describe('IP do cliente (RN-AUD-05 · security.md §8)', () => {
  it('normaliza como o inet do PostgreSQL', () => {
    expect(normalizeIp('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('::FFFF:7f00:1')).toBe('127.0.0.1');
    expect(normalizeIp('2001:DB8:0:0:0:0:0:1')).toBe('2001:db8::1');
    expect(normalizeIp('::1')).toBe('::1');
    expect(normalizeIp('::0:1:2')).toBe('::0.1.0.2');
    expect(normalizeIp('fe80::1%eth0')).toBeNull();
    expect(normalizeIp('não é ip')).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
  });

  it('de proxy confiável: último salto do X-Forwarded-For e o hash da sessão', () => {
    const trusted = trustedProxyList(['10.0.0.0/8', '::1']);
    expect(
      resolveClientAddress(
        '::ffff:10.1.2.3',
        { forwardedFor: '198.51.100.1, 203.0.113.9', sessionIdHash: SESSION.toUpperCase() },
        trusted,
      ),
    ).toEqual({ ip: '203.0.113.9', sessionIdHash: SESSION });
    expect(
      resolveClientAddress('::1', { forwardedFor: undefined, sessionIdHash: 'curto' }, trusted),
    ).toEqual({ ip: '::1' });
  });

  it('de qualquer outra origem: só o IP do socket', () => {
    const trusted = trustedProxyList(['10.0.0.0/8']);
    expect(
      resolveClientAddress(
        '192.0.2.10',
        { forwardedFor: '203.0.113.9', sessionIdHash: SESSION },
        trusted,
      ),
    ).toEqual({ ip: '192.0.2.10' });
    expect(
      resolveClientAddress(undefined, { forwardedFor: '1.1.1.1', sessionIdHash: SESSION }, trusted),
    ).toEqual({ ip: '' });
  });
});

describe('contextos de job e de cliente informado pelo BFF (US-073)', () => {
  it('runAsSystem: ator SYSTEM com o nome do job e correlationId gerado (FA-01/FA-04)', () => {
    const context = runAsSystem({ name: 'Job X', tenantId: null }, () => currentRequestContext());
    expect(context).toMatchObject({
      actor: { type: 'SYSTEM', userId: null, membershipId: null, name: 'Job X' },
      tenantId: null,
      ip: '',
      userAgent: '',
    });
    expect(context?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      runAsSystem({ name: 'Job X', tenantId: null, correlationId: 'corr-herdada' }, () =>
        currentRequestContext(),
      )?.correlationId,
    ).toBe('corr-herdada');
  });

  it('runWithClientDetails troca IP, user-agent e sessão só no contexto filho', () => {
    runWithRequestContext({ correlationId: 'c-1', ip: '10.0.0.5', userAgent: 'bff' }, () => {
      const inner = runWithClientDetails(
        { ip: '203.0.113.7', userAgent: null, sessionIdHash: SESSION },
        () => currentRequestContext(),
      );
      expect(inner).toMatchObject({ ip: '203.0.113.7', userAgent: '', sessionIdHash: SESSION });
      expect(currentRequestContext()).toMatchObject({ ip: '10.0.0.5', userAgent: 'bff' });
      expect(currentRequestContext()?.sessionIdHash).toBeUndefined();
    });
    expect(() =>
      runWithClientDetails({ ip: null, userAgent: null, sessionIdHash: SESSION }, () => 1),
    ).toThrow(/RequestContext ausente/);
  });
});
