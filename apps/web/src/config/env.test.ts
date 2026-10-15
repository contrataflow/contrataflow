import { afterEach, describe, expect, it, vi } from 'vitest';

import { BASE_ENV } from '@test/support/bff';

import {
  PUBLIC_ENV_ALLOWLIST,
  WebConfigError,
  assertPublicEnv,
  cspSources,
  isDevelopmentBuild,
  loadWebConfig,
  parseCidr,
  resetWebConfigForTests,
  webConfig,
} from './env';

afterEach(() => {
  vi.unstubAllEnvs();
  resetWebConfigForTests();
});

describe('configuração do web (Campos da US-086)', () => {
  it('normaliza a configuração válida com os padrões da story', () => {
    const config = loadWebConfig({
      ...BASE_ENV,
      API_INTERNAL_URL: 'http://api.internal:4000/',
      S3_PUBLIC_ENDPOINT: 'https://s3.sa-east-1.amazonaws.com',
      S3_BUCKET_QUARANTINE: 'q',
      S3_BUCKET_RENDITIONS: 'r',
    });
    expect(config).toMatchObject({
      appEnv: 'test',
      appOrigin: 'http://localhost:3000',
      secure: false,
      apiInternalUrl: 'http://api.internal:4000',
      sessionCookieName: '__Host-cf_session',
      cspReportUri: '/api/csp-report',
      trustedProxies: [{ network: 167772160, prefix: 8 }],
      connectSources: ['https://s3.sa-east-1.amazonaws.com'],
      formActionSources: ['http://localhost:9080'],
    });
    expect(config.oidc).toEqual({
      issuerUrl: BASE_ENV.OIDC_ISSUER_URL,
      audience: 'contrataflow-web',
      fakeSigningKey: BASE_ENV.OIDC_FAKE_SIGNING_KEY,
      clientId: 'contrataflow-web',
      clientSecret: null,
      scopes: 'openid profile email offline_access',
      redirectUri: 'http://localhost:3000/api/auth/callback',
      postLogoutRedirectUri: 'http://localhost:3000/entrar?motivo=saiu',
      recoveryFlowSlug: 'contrataflow-recovery',
    });
    expect(config.session).toEqual({
      redisUrl: null,
      encryptionKey: null,
      keyPrefix: 'cf:test:sess:',
    });
    expect(config.authRateLimitPerMinute).toBe(20);
    expect(config.internalServiceToken).toBeNull();
  });

  it('US-089: slug do flow de recuperação configurável, só com caracteres de slug', () => {
    expect(
      loadWebConfig({ ...BASE_ENV, OIDC_RECOVERY_FLOW_SLUG: 'orgao-recovery' }).oidc
        .recoveryFlowSlug,
    ).toBe('orgao-recovery');
    expect(() =>
      loadWebConfig({ ...BASE_ENV, OIDC_RECOVERY_FLOW_SLUG: '../admin/?next=//evil' }),
    ).toThrow(new WebConfigError(['OIDC_RECOVERY_FLOW_SLUG']));
  });

  it('usa só o primeiro `aud` e liga HTTPS por APP_BASE_URL', () => {
    const config = loadWebConfig({
      ...BASE_ENV,
      APP_BASE_URL: 'https://app.contrataflow.com.br',
      OIDC_AUDIENCE: 'contrataflow-web, outra',
    });
    expect(config.secure).toBe(true);
    expect(config.oidc.audience).toBe('contrataflow-web');
  });

  it('lista as chaves inválidas sem expor valores', () => {
    const secret = 'valor-que-nao-pode-aparecer';
    expect(() =>
      loadWebConfig({ ...BASE_ENV, API_INTERNAL_URL: secret, TRUSTED_PROXY_CIDRS: undefined }),
    ).toThrow(new WebConfigError(['API_INTERNAL_URL', 'TRUSTED_PROXY_CIDRS']));
    try {
      loadWebConfig({ ...BASE_ENV, API_INTERNAL_URL: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('recusa CIDR inválido e cookie de sessão sem prefixo __Host-', () => {
    expect(() => loadWebConfig({ ...BASE_ENV, TRUSTED_PROXY_CIDRS: '10.0.0.0/33' })).toThrow(
      /TRUSTED_PROXY_CIDRS/,
    );
    expect(() => loadWebConfig({ ...BASE_ENV, SESSION_COOKIE_NAME: 'cf_session' })).toThrow(
      /SESSION_COOKIE_NAME/,
    );
  });

  it('US-087: fora de local/dev/test exige Redis de sessões, chave, segredo do cliente e credencial interna', () => {
    expect(() =>
      loadWebConfig({ ...BASE_ENV, APP_ENV: 'staging', OIDC_FAKE_SIGNING_KEY: undefined }),
    ).toThrow(
      new WebConfigError([
        'INTERNAL_SERVICE_TOKEN',
        'OIDC_CLIENT_SECRET',
        'REDIS_SESSION_URL',
        'SESSION_ENCRYPTION_KEY',
      ]),
    );
    const key = Buffer.alloc(32, 7).toString('base64');
    const config = loadWebConfig({
      ...BASE_ENV,
      APP_ENV: 'staging',
      OIDC_FAKE_SIGNING_KEY: undefined,
      REDIS_SESSION_URL: 'rediss://sessions.internal:6379',
      SESSION_ENCRYPTION_KEY: key,
      OIDC_CLIENT_SECRET: 'segredo-do-cliente',
      INTERNAL_SERVICE_TOKEN: 's'.repeat(32),
    });
    expect(config.session.encryptionKey?.equals(Buffer.alloc(32, 7))).toBe(true);
    expect(config.session.keyPrefix).toBe('cf:staging:sess:');
    expect(() =>
      loadWebConfig({ ...BASE_ENV, SESSION_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/SESSION_ENCRYPTION_KEY/);
  });

  it('proíbe o provedor fake fora de local/dev/test (FA-06)', () => {
    expect(() => loadWebConfig({ ...BASE_ENV, APP_ENV: 'production' })).toThrow(
      /OIDC_FAKE_SIGNING_KEY/,
    );
    const production = {
      ...BASE_ENV,
      APP_ENV: 'production',
      REDIS_SESSION_URL: 'rediss://sessions.internal:6379',
      SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
      OIDC_CLIENT_SECRET: 'segredo-do-cliente',
      INTERNAL_SERVICE_TOKEN: 's'.repeat(32),
    };
    expect(
      loadWebConfig({ ...production, OIDC_FAKE_SIGNING_KEY: undefined }).oidc.fakeSigningKey,
    ).toBeNull();
    // Variável vazia conta como ausente (sobrescreve o `.env` sem precisar apagá-lo).
    expect(
      loadWebConfig({ ...production, OIDC_FAKE_SIGNING_KEY: '' }).oidc.fakeSigningKey,
    ).toBeNull();
  });

  it('ignora bucket sem endpoint válido', () => {
    const config = loadWebConfig({
      ...BASE_ENV,
      S3_PUBLIC_ENDPOINT: 'não-é-url',
      S3_BUCKET_QUARANTINE: 'q',
      S3_BUCKET_RENDITIONS: '',
    });
    expect(config.connectSources).toEqual([]);
  });
});

describe('V-04 — NEXT_PUBLIC_* em lista fechada', () => {
  it('aceita só a lista fechada', () => {
    expect(PUBLIC_ENV_ALLOWLIST).toEqual(['NEXT_PUBLIC_APP_NAME']);
    expect(() => {
      assertPublicEnv({ NEXT_PUBLIC_APP_NAME: 'ContrataFlow', OUTRA: 'x' });
    }).not.toThrow();
  });

  it('falha com a variável fora da lista (o build também falha: next.config.ts)', () => {
    expect(() => {
      assertPublicEnv({ NEXT_PUBLIC_API_TOKEN: 'segredo', NEXT_PUBLIC_A: '1' });
    }).toThrow(
      'Configuração inválida do web: NEXT_PUBLIC_A (fora da lista NEXT_PUBLIC_*), NEXT_PUBLIC_API_TOKEN (fora da lista NEXT_PUBLIC_*).',
    );
    expect(() => loadWebConfig({ ...BASE_ENV, NEXT_PUBLIC_SECRET: 'x' })).toThrow(WebConfigError);
  });
});

describe('parseCidr', () => {
  it.each([
    ['127.0.0.1/32', { network: 2130706433, prefix: 32 }],
    ['0.0.0.0/0', { network: 0, prefix: 0 }],
    [' 10.1.2.3/8 ', { network: 167838211, prefix: 8 }],
  ])('%s', (value, expected) => {
    expect(parseCidr(value)).toEqual(expected);
  });

  it.each(['10.0.0.256/8', '10.0.0.0', 'abc/8', '10.0.0.0/40', '::1/128'])('recusa %s', (value) => {
    expect(parseCidr(value)).toBeNull();
  });
});

describe('configuração do processo', () => {
  it('memoiza a leitura de process.env', () => {
    for (const [key, value] of Object.entries(BASE_ENV)) vi.stubEnv(key, value);
    const first = webConfig();
    expect(webConfig()).toBe(first);
    expect(cspSources().formActionSources).toEqual(['http://localhost:9080']);
  });

  it('cspSources tolera BFF não configurado (cabeçalhos continuam saindo)', () => {
    vi.stubEnv('APP_BASE_URL', '');
    expect(cspSources()).toEqual({
      connectSources: [],
      formActionSources: [],
      cspReportUri: '/api/csp-report',
      secure: false,
    });
  });

  it('detecta o build de desenvolvimento', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(isDevelopmentBuild()).toBe(true);
    vi.stubEnv('NODE_ENV', 'production');
    expect(isDevelopmentBuild()).toBe(false);
  });
});
