import { describe, expect, it } from 'vitest';

import {
  notificationIdParamsSchema,
  notificationListQuerySchema,
  updateNotificationPreferencesSchema,
} from './notification.js';

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

describe('ME-06 — corpo das preferências de notificação (US-113 · V-01/V-03)', () => {
  const change = { notificationType: 'COMMENT_REPLY', channel: 'EMAIL', enabled: false };

  it('aceita combinações válidas, inclusive "usar padrão" (enabled nulo)', () => {
    expect(
      updateNotificationPreferencesSchema.safeParse({
        preferences: [change, { ...change, channel: 'IN_APP', enabled: null }],
      }).success,
    ).toBe(true);
  });

  it('tipo fora do registro → INVALID_ENUM com a mensagem da story', () => {
    const result = updateNotificationPreferencesSchema.safeParse({
      preferences: [{ ...change, notificationType: 'TIPO_INEXISTENTE' }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      code: 'invalid_value',
      message: 'Tipo de notificação inválido.',
    });
  });

  it.each([
    [{}],
    [{ preferences: [] }],
    [{ preferences: 'tudo' }],
    [{ preferences: [{ ...change, enabled: 'sim' }] }],
    [{ preferences: [{ ...change, userId: 'outro' }] }],
    [{ preferences: [change], userId: 'outro' }],
    [{ preferences: [{ notificationType: 'COMMENT_REPLY', channel: 'SMS', enabled: true }] }],
  ])('recusa o corpo %o', (body) => {
    expect(updateNotificationPreferencesSchema.safeParse(body).success).toBe(false);
  });

  it('corpo vazio traz "Nenhuma alteração reconhecida."', () => {
    const result = updateNotificationPreferencesSchema.safeParse({ preferences: [] });
    expect(result.error?.issues[0]?.message).toBe('Nenhuma alteração reconhecida.');
  });

  it('a mesma combinação duas vezes → DUPLICATE_IN_LIST', () => {
    const result = updateNotificationPreferencesSchema.safeParse({
      preferences: [change, { ...change, enabled: true }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: 'custom', path: ['preferences', 1] });
  });
});
