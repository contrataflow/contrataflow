import { describe, expect, it } from 'vitest';

import { notificationIdParamsSchema, notificationListQuerySchema } from './notification.js';

describe('NTF-01 — query da lista (US-111 · V-01)', () => {
  it('aplica os padrões: 20 itens, todas (lidas e não lidas)', () => {
    expect(notificationListQuerySchema.parse({})).toEqual({ limit: 20, unreadOnly: false });
  });

  it('converte a query string', () => {
    expect(
      notificationListQuerySchema.parse({ cursor: 'eyJpZCI6MX0', limit: '5', unreadOnly: 'true' }),
    ).toEqual({ cursor: 'eyJpZCI6MX0', limit: 5, unreadOnly: true });
  });

  it.each([
    [{ limit: 'abc' }],
    [{ limit: '0' }],
    [{ limit: '101' }],
    [{ cursor: 'a b' }],
    [{ unreadOnly: 'sim' }],
    [{ outro: '1' }],
  ])('recusa %o', (query) => {
    expect(notificationListQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('NTF-03/05 — id da notificação', () => {
  it('exige UUIDv7', () => {
    expect(
      notificationIdParamsSchema.safeParse({ id: '0192f111-0000-7000-8000-000000000001' }).success,
    ).toBe(true);
    expect(notificationIdParamsSchema.safeParse({ id: 'N1' }).success).toBe(false);
  });
});
