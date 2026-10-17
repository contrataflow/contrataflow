// Callback do BFF contra a API real (spec-486): o processo compilado da API (`apps/api/dist`) em
// modo de identidade fake — mesmo `FakeJwksProvider` HS256 e diretório em memória, sem banco — e o
// `ApiSessionDirectory` com o `fetch` de verdade, sem o diretório fake do BFF. Cobre o login
// completo, a credencial de serviço recusada e a API fora do ar (porta fechada), com a causa no log.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApiSessionDirectory } from '@/bff/auth/api-session-directory';
import { LOGIN_TRANSACTION_COOKIE } from '@/bff/auth/login-transaction';
import { handleAuthRequest } from '@/bff/auth-handler';
import { captureLogsForTests } from '@/bff/logger';
import { BASE_ENV, FAKE_KEY, browserRequest, createTestRuntime } from '@test/support/bff';

const API_DIR = resolve(import.meta.dirname, '../../../api');
const API_MAIN = resolve(API_DIR, 'dist/main.js');
const SERVICE_TOKEN = 'contrataflow-test-only-service-token-000';

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        done(typeof address === 'object' && address ? address.port : 0);
      });
    });
  });
}

async function startApi(): Promise<{ process: ChildProcess; url: string }> {
  if (!existsSync(API_MAIN)) {
    throw new Error(`API não compilada (${API_MAIN}): rode pnpm --filter @contrataflow/api build.`);
  }
  const [port, metricsPort] = [await freePort(), await freePort()];
  const output: string[] = [];
  const child = spawn(process.execPath, [API_MAIN], {
    cwd: API_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      // eslint-disable-next-line contrataflow/no-process-env -- o processo filho herda PATH etc.
      ...process.env,
      NODE_ENV: 'test',
      APP_ENV: 'test',
      PORT: String(port),
      METRICS_PORT: String(metricsPort),
      LOG_LEVEL: 'error',
      // Portas fechadas: o modo fake não abre transação; o rate limit falha aberto sem Redis.
      DATABASE_URL: 'postgresql://cf_app:test@127.0.0.1:1/contrataflow',
      REDIS_CACHE_URL: 'redis://127.0.0.1:1',
      OIDC_ISSUER_URL: BASE_ENV.OIDC_ISSUER_URL ?? '',
      OIDC_AUDIENCE: BASE_ENV.OIDC_AUDIENCE ?? '',
      OIDC_FAKE_SIGNING_KEY: FAKE_KEY,
      INTERNAL_SERVICE_TOKEN: SERVICE_TOKEN,
    },
  });
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  const url = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`A API terminou na subida:\n${output.join('')}`);
    }
    const live = await fetch(`${url}/health/live`).catch(() => null);
    if (live?.ok) return { process: child, url };
    await new Promise((done) => setTimeout(done, 250));
  }
  child.kill();
  throw new Error(`A API não respondeu em 60 s:\n${output.join('')}`);
}

/** Login completo pelo BFF: /login?as=<pessoa> → callback (código do provedor fake). */
async function login(directory: ApiSessionDirectory) {
  const test = createTestRuntime({ directory });
  // O token fake vai para a API de verdade: `exp`/`iat` precisam do relógio real.
  test.clock.now = Date.now();
  const start = await handleAuthRequest(
    browserRequest('/api/auth/login?returnTo=%2Fprocessos&as=ana'),
    'login',
    test.runtime,
  );
  const transaction = new RegExp(`${LOGIN_TRANSACTION_COOKIE}=([^;,]*)`)
    .exec(start.headers.get('Set-Cookie') ?? '')
    ?.at(1);
  const callbackUrl = new URL(start.headers.get('Location') ?? '');
  const callback = await handleAuthRequest(
    browserRequest(`${callbackUrl.pathname}${callbackUrl.search}`, {
      headers: { Cookie: `${LOGIN_TRANSACTION_COOKIE}=${transaction ?? ''}` },
    }),
    'callback',
    test.runtime,
  );
  return { test, callback };
}

describe('BFF → API real: callback do login (spec-486)', () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  let logs: ReturnType<typeof captureLogsForTests>;

  const logged = (event: string) =>
    logs.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.event === event);

  beforeAll(async () => {
    api = await startApi();
  });

  afterAll(() => {
    api.process.kill();
  });

  beforeEach(() => {
    logs = captureLogsForTests();
  });

  afterEach(() => {
    logs.restore();
  });

  it('cria a sessão com a identidade e a instituição devolvidas pela API e volta ao returnTo', async () => {
    const directory = new ApiSessionDirectory({
      apiInternalUrl: api.url,
      serviceToken: SERVICE_TOKEN,
      fetch,
    });
    const { test, callback } = await login(directory);
    expect(callback.status).toBe(302);
    // Uma instituição utilizável: a API ativou a Prefeitura A (seleção automática).
    expect(callback.headers.get('Location')).toBe('/processos');
    expect(callback.headers.getSetCookie().some((c) => c.startsWith('__Host-cf_session='))).toBe(
      true,
    );
    expect(test.store.size).toBe(1);
    expect(logged('auth.directory_unavailable')).toEqual([]);
    expect(logged('auth.tenant_activation_failed')).toEqual([]);
    expect(logged('auth.session_created')).toEqual([
      expect.objectContaining({ userId: '0192a000-0000-7000-8000-0000000000a1' }),
    ]);
  });

  it('credencial de serviço recusada pela API: manutenção, sem sessão, 403 e código no log', async () => {
    const directory = new ApiSessionDirectory({
      apiInternalUrl: api.url,
      serviceToken: 'x'.repeat(40),
      fetch,
    });
    const { test, callback } = await login(directory);
    expect(new URL(callback.headers.get('Location') ?? '', 'http://x').pathname).toBe(
      '/erro/manutencao',
    );
    expect(test.store.size).toBe(0);
    expect(logged('auth.directory_unavailable')).toEqual([
      expect.objectContaining({
        apiInternalUrl: api.url,
        status: 403,
        code: 'PERMISSION_DENIED',
        attempts: 1,
      }),
    ]);
  });

  it('API fora do ar (porta fechada): repete, desiste e registra o erro de rede e o endereço', async () => {
    const closed = `http://127.0.0.1:${String(await freePort())}`;
    const directory = new ApiSessionDirectory({
      apiInternalUrl: closed,
      serviceToken: SERVICE_TOKEN,
      fetch,
      retryDelaysMs: [10, 10],
    });
    const { test, callback } = await login(directory);
    expect(new URL(callback.headers.get('Location') ?? '', 'http://x').pathname).toBe(
      '/erro/manutencao',
    );
    expect(test.store.size).toBe(0);
    expect(logged('auth.directory_unavailable')).toEqual([
      expect.objectContaining({
        apiInternalUrl: closed,
        status: null,
        code: 'ECONNREFUSED',
        attempts: 3,
      }),
    ]);
  });
});
