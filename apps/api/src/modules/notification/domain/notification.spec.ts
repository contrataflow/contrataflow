import { describe, expect, it } from 'vitest';

import { isExpired, isListed, isUnread } from './notification.js';

const NOW = new Date('2026-10-15T12:00:00Z');
const base = { archivedAt: null, expiresAt: null, readAt: null };

describe('Notification — lista e contador (RN-NTF-09/10)', () => {
  it('sem vencimento nunca expira; vencimento no passado (ou agora) expira', () => {
    expect(isExpired(base, NOW)).toBe(false);
    expect(isExpired({ expiresAt: new Date(NOW.getTime() + 1) }, NOW)).toBe(false);
    expect(isExpired({ expiresAt: NOW }, NOW)).toBe(true);
  });

  it('arquivada ou vencida sai da lista e do contador', () => {
    expect(isListed(base, NOW)).toBe(true);
    expect(isListed({ ...base, archivedAt: NOW }, NOW)).toBe(false);
    expect(isListed({ ...base, expiresAt: NOW }, NOW)).toBe(false);
    expect(isUnread({ ...base, archivedAt: NOW }, NOW)).toBe(false);
  });

  it('lida continua na lista, mas não conta como não lida', () => {
    const read = { ...base, readAt: NOW };
    expect(isListed(read, NOW)).toBe(true);
    expect(isUnread(read, NOW)).toBe(false);
    expect(isUnread(base, NOW)).toBe(true);
  });
});
