import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SESSION_POLICY,
  SESSION_END_REASONS,
  isMembershipEndReason,
  isSessionEndReason,
  isSessionExpiryReason,
  resolveSessionPolicy,
  sessionEndAuditAction,
  sessionKeyspace,
} from './session.js';

describe('motivos de encerramento de sessão (RN-IAM-28)', () => {
  it('expiração → auth.session_expired; demais → auth.session_end', () => {
    const actions = Object.fromEntries(
      SESSION_END_REASONS.map((reason) => [reason, sessionEndAuditAction(reason)]),
    );
    expect(actions).toEqual({
      LOGOUT: 'auth.session_end',
      SESSION_LIMIT: 'auth.session_end',
      MEMBERSHIP_SUSPENDED: 'auth.session_end',
      MEMBERSHIP_REVOKED: 'auth.session_end',
      MEMBERSHIP_EXPIRED: 'auth.session_end',
      IDLE: 'auth.session_expired',
      ABSOLUTE: 'auth.session_expired',
      REFRESH_FAILED: 'auth.session_expired',
    });
  });

  it('guardas de tipo', () => {
    expect(isSessionEndReason('LOGOUT')).toBe(true);
    expect(isSessionEndReason('logout')).toBe(false);
    expect(isSessionEndReason(1)).toBe(false);
    expect(isSessionExpiryReason('IDLE')).toBe(true);
    expect(isSessionExpiryReason('LOGOUT')).toBe(false);
    expect(isMembershipEndReason('MEMBERSHIP_REVOKED')).toBe(true);
    expect(isMembershipEndReason('IDLE')).toBe(false);
  });
});

describe('limites da sessão (DEC-131 · entities.md §6)', () => {
  it('padrão 30 min / 12 h', () => {
    expect(DEFAULT_SESSION_POLICY).toEqual({ idleMinutes: 30, absoluteHours: 12 });
    expect(resolveSessionPolicy()).toEqual(DEFAULT_SESSION_POLICY);
    expect(resolveSessionPolicy(null)).toEqual(DEFAULT_SESSION_POLICY);
  });

  it('aceita a faixa 5..120 / 1..24 e recusa o resto (cai no padrão)', () => {
    expect(resolveSessionPolicy({ idleMinutes: 5, absoluteHours: 24 })).toEqual({
      idleMinutes: 5,
      absoluteHours: 24,
    });
    expect(resolveSessionPolicy({ idleMinutes: 120, absoluteHours: 1 })).toEqual({
      idleMinutes: 120,
      absoluteHours: 1,
    });
    expect(resolveSessionPolicy({ idleMinutes: 4, absoluteHours: 25 })).toEqual(
      DEFAULT_SESSION_POLICY,
    );
    expect(resolveSessionPolicy({ idleMinutes: 30.5, absoluteHours: 0 })).toEqual(
      DEFAULT_SESSION_POLICY,
    );
  });
});

describe('chaves do Redis de sessões', () => {
  it('prefixo cf:{env}:sess: e chaves auxiliares que não colidem com o hash da sessão', () => {
    const keys = sessionKeyspace('test');
    const key = 'a'.repeat(64);
    expect(keys.prefix).toBe('cf:test:sess:');
    expect(keys.record(key)).toBe(`cf:test:sess:${key}`);
    expect(keys.ended(key)).toBe(`cf:test:sess:end:${key}`);
    expect(keys.user('u1')).toBe('cf:test:sess:user:u1');
    expect(keys.membership('m1')).toBe('cf:test:sess:membership:m1');
    expect(keys.expiry).toBe('cf:test:sess:expiry');
    expect(keys.refreshLock(key)).toBe(`cf:test:sess:lock:${key}`);
    expect(keys.sweepLock).toBe('cf:test:sess:sweep:lock');
  });
});
