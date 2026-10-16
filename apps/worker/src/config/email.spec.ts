import { describe, expect, it } from 'vitest';

import { EmailConfigError, loadEmailConfig } from './email.js';

function keysOf(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof EmailConfigError) return error.keys;
    throw error;
  }
  return [];
}

const PROD = {
  SMTP_URL: 'smtps://user:pass@email-smtp.sa-east-1.amazonaws.com:465',
  EMAIL_FROM: 'ContrataFlow <nao-responda@contrataflow.gov.br>',
  APP_BASE_URL: 'https://app.contrataflow.gov.br',
};

describe('configuração de e-mail do worker (US-112)', () => {
  it('local sem SMTP_URL: e-mail desligado; fora de local/dev/test é obrigatório', () => {
    expect(loadEmailConfig({}, true)).toBeNull();
    expect(keysOf(() => loadEmailConfig({}, false))).toEqual(['SMTP_URL']);
    expect(keysOf(() => loadEmailConfig({ SMTP_URL: PROD.SMTP_URL }, false))).toEqual([
      'EMAIL_FROM',
      'APP_BASE_URL',
    ]);
  });

  it('padrões: transporte smtp, 10 envios/s e base local dos links', () => {
    expect(
      loadEmailConfig({ SMTP_URL: 'smtp://localhost:1025', EMAIL_FROM: 'a@b.test' }, true),
    ).toEqual({
      transport: 'smtp',
      smtpUrl: 'smtp://localhost:1025',
      from: 'a@b.test',
      appBaseUrl: 'http://localhost:3000',
      ratePerSecond: 10,
    });
    expect(loadEmailConfig({ ...PROD, EMAIL_RATE_PER_SECOND: '14' }, false)?.ratePerSecond).toBe(
      14,
    );
  });

  it('valores inválidos são recusados pela chave', () => {
    expect(keysOf(() => loadEmailConfig({ ...PROD, SMTP_URL: 'http://x' }, false))).toEqual([
      'SMTP_URL',
    ]);
    expect(keysOf(() => loadEmailConfig({ ...PROD, EMAIL_RATE_PER_SECOND: '0' }, false))).toEqual([
      'EMAIL_RATE_PER_SECOND',
    ]);
    expect(keysOf(() => loadEmailConfig({ ...PROD, EMAIL_TRANSPORT: 'ses' }, false))).toEqual([
      'EMAIL_TRANSPORT',
    ]);
    expect(keysOf(() => loadEmailConfig({ ...PROD, EMAIL_FROM: 'sem-arroba' }, false))).toEqual([
      'EMAIL_FROM',
    ]);
  });
});
