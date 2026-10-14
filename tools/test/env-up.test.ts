// US-078 — `pnpm env:up` sem Docker real: estado dos serviços, espera pelos healthchecks (V-04),
// porta ocupada (V-03), bootstrap e blueprint (V-06) e os Gherkin "[Falha de banco]" e
// "[Falha de integração]".
import { describe, expect, it } from 'vitest';

import type { AuthentikApi, BlueprintStatus } from '../env/lib/authentik.js';
import { envCheck } from '../env/lib/check.js';
import {
  classifyService,
  composeArgs,
  DEFAULT_SERVICES,
  parseComposePs,
  servicesFor,
  unhealthyMessage,
  waitForServices,
} from '../env/lib/compose.js';
import type { CommandResult, Compose, ContainerStatus } from '../env/lib/compose.js';
import { parseEnvFile } from '../env/lib/env-file.js';
import { EnvError, memoryLogger } from '../env/lib/log.js';
import { envUp, expectedBlueprints } from '../env/lib/up.js';
import { REPO_ROOT } from '../lib/workspace.js';

const ok = (stdout = ''): CommandResult => ({ status: 0, stdout, stderr: '' });

function container(service: string, overrides: Partial<ContainerStatus> = {}): ContainerStatus {
  return {
    service,
    state: service === 'minio-bootstrap' ? 'exited' : 'running',
    health: service === 'minio-bootstrap' ? '' : 'healthy',
    exitCode: 0,
    publishedPorts: [],
    ...overrides,
  };
}

function psJson(statuses: readonly ContainerStatus[]): string {
  return statuses
    .map((status) =>
      JSON.stringify({
        Service: status.service,
        State: status.state,
        Health: status.health,
        ExitCode: status.exitCode,
        Publishers: status.publishedPorts.map((port) => ({ PublishedPort: port, TargetPort: 1 })),
      }),
    )
    .join('\n');
}

interface FakeComposeOptions {
  readonly ps: () => readonly ContainerStatus[];
  readonly up?: CommandResult;
  readonly version?: CommandResult;
}

function fakeCompose(options: FakeComposeOptions): Compose & { readonly calls: string[][] } {
  const calls: string[][] = [];
  return {
    root: REPO_ROOT,
    calls,
    run: (args) => {
      calls.push([...args]);
      if (args[0] === 'version') return Promise.resolve(options.version ?? ok('2.40.0'));
      if (args[0] === 'ps') return Promise.resolve(ok(psJson(options.ps())));
      if (args[0] === 'up') return Promise.resolve(options.up ?? ok());
      return Promise.resolve(ok());
    },
  };
}

function fakeAuthentik(statuses: () => BlueprintStatus[]): AuthentikApi {
  return {
    baseUrl: 'http://localhost:9080',
    usersInPath: () => Promise.resolve([]),
    blueprints: () => Promise.resolve(statuses()),
  };
}

const successfulBlueprints = () =>
  expectedBlueprints(REPO_ROOT).map((path) => ({
    name: path,
    path,
    status: 'successful',
    enabled: true,
  }));

/** Relógio falso: cada `sleep` avança o tempo. */
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

const env = parseEnvFile('POSTGRES_PORT=55432\n');

describe('parseComposePs', () => {
  it('lê o formato de uma linha JSON por contêiner (Compose ≥ 2.21)', () => {
    const output = psJson([container('postgres', { publishedPorts: [55432] })]);
    expect(parseComposePs(output)).toEqual([
      {
        service: 'postgres',
        state: 'running',
        health: 'healthy',
        exitCode: 0,
        publishedPorts: [55432],
      },
    ]);
  });

  it('lê o formato de array (Compose antigo) e saída vazia', () => {
    expect(parseComposePs('[{"Service":"mailpit","State":"running","Health":""}]')).toEqual([
      { service: 'mailpit', state: 'running', health: '', exitCode: 0, publishedPorts: [] },
    ]);
    expect(parseComposePs('  ')).toEqual([]);
  });
});

describe('classifyService', () => {
  it.each([
    ['postgres', { health: 'healthy' }, 'ready'],
    ['mailpit', { health: '' }, 'ready'],
    ['authentik-server', { health: 'starting' }, 'starting'],
    ['authentik-server', { health: 'unhealthy' }, 'starting'],
    ['clamav', { state: 'restarting', health: '' }, 'starting'],
    ['postgres', { state: 'exited', exitCode: 1 }, 'failed'],
    ['minio-bootstrap', { state: 'exited', exitCode: 0 }, 'ready'],
    ['minio-bootstrap', { state: 'exited', exitCode: 1 }, 'failed'],
    ['minio-bootstrap', { state: 'running' }, 'starting'],
  ] as const)('%s %j → %s', (service, overrides, expected) => {
    expect(classifyService(service, container(service, overrides)).readiness).toBe(expected);
  });

  it('sem contêiner → missing', () => {
    expect(classifyService('postgres', undefined).readiness).toBe('missing');
  });
});

describe('waitForServices', () => {
  it('espera até todos ficarem prontos', async () => {
    let round = 0;
    const clock = fakeClock();
    const result = await waitForServices(
      ['postgres', 'authentik-server'],
      () => {
        round += 1;
        return Promise.resolve([
          container('postgres'),
          container('authentik-server', { health: round < 3 ? 'starting' : 'healthy' }),
        ]);
      },
      { timeoutMs: 60_000, intervalMs: 1000, ...clock },
    );
    expect(result).toEqual({ ready: ['postgres', 'authentik-server'], failed: [], unhealthy: [] });
    expect(round).toBe(3);
  });

  it('reporta quem não ficou saudável no tempo limite', async () => {
    const result = await waitForServices(
      ['postgres', 'authentik-server'],
      () =>
        Promise.resolve([
          container('postgres'),
          container('authentik-server', { health: 'starting' }),
        ]),
      { timeoutMs: 5000, intervalMs: 1000, ...fakeClock() },
    );
    expect(result.ready).toEqual(['postgres']);
    expect(result.unhealthy.map((item) => item.service)).toEqual(['authentik-server']);
  });
});

describe('composeArgs', () => {
  it('usa o projeto, o .env da raiz, todos os arquivos e os perfis pedidos', () => {
    const args = composeArgs('/repo', ['observability'], ['up', '-d']);
    expect(args.slice(0, 5)).toEqual([
      'compose',
      '--project-name',
      'contrataflow',
      '--env-file',
      expect.stringContaining('.env'),
    ]);
    expect(args.filter((arg) => arg === '-f')).toHaveLength(3);
    expect(args.slice(-4)).toEqual(['--profile', 'observability', 'up', '-d']);
  });

  it('servicesFor soma os serviços dos perfis (RN-FND-13)', () => {
    expect(servicesFor([])).toEqual([...DEFAULT_SERVICES]);
    expect(servicesFor(['full'])).toEqual([...DEFAULT_SERVICES, 'api', 'web', 'worker']);
  });
});

describe('envUp', () => {
  const healthy = () => DEFAULT_SERVICES.map((service) => container(service));

  it('[Sucesso] sobe e conclui com env.up.completed quando tudo está saudável', async () => {
    const logger = memoryLogger();
    const compose = fakeCompose({ ps: healthy });
    await envUp({
      root: REPO_ROOT,
      env,
      profiles: [],
      compose,
      authentik: fakeAuthentik(successfulBlueprints),
      logger,
      isPortFree: () => Promise.resolve(true),
      ...fakeClock(),
    });
    expect(compose.calls.some((call) => call[0] === 'up' && call[1] === '-d')).toBe(true);
    expect(logger.lines.at(-1)).toMatch(/^✔ env\.up\.completed — 10 serviços prontos/);
  });

  it('[Falha de banco] porta do Postgres ocupada → falha antes do docker compose up', async () => {
    const compose = fakeCompose({ ps: () => [] });
    const promise = envUp({
      root: REPO_ROOT,
      env,
      profiles: [],
      compose,
      authentik: fakeAuthentik(successfulBlueprints),
      logger: memoryLogger(),
      isPortFree: (port) => Promise.resolve(port !== 55432),
    });
    await expect(promise).rejects.toThrow(
      new EnvError('PORT_IN_USE', 'Porta 55432 ocupada. Ajuste POSTGRES_PORT no .env.'),
    );
    expect(compose.calls.some((call) => call[0] === 'up')).toBe(false);
  });

  it('não acusa conflito nas portas já publicadas pelo próprio projeto (env:up reexecutado)', async () => {
    const compose = fakeCompose({
      ps: () => [...healthy().slice(1), container('postgres', { publishedPorts: [55432] })],
    });
    await envUp({
      root: REPO_ROOT,
      env,
      profiles: [],
      compose,
      authentik: fakeAuthentik(successfulBlueprints),
      logger: memoryLogger(),
      isPortFree: (port) => Promise.resolve(port !== 55432),
      ...fakeClock(),
    });
    expect(compose.calls.some((call) => call[0] === 'up')).toBe(true);
  });

  it('traduz o erro nativo do Docker de porta ocupada', async () => {
    const compose = fakeCompose({
      ps: () => [],
      up: {
        status: 1,
        stdout: '',
        stderr:
          'Error response from daemon: Ports are not available: exposing port TCP 127.0.0.1:6380 -> 127.0.0.1:0: listen tcp4 127.0.0.1:6380: bind: Only one usage of each socket address',
      },
    });
    await expect(
      envUp({
        root: REPO_ROOT,
        env,
        profiles: [],
        compose,
        authentik: fakeAuthentik(successfulBlueprints),
        logger: memoryLogger(),
        isPortFree: () => Promise.resolve(true),
      }),
    ).rejects.toThrow('Porta 6380 ocupada. Ajuste REDIS_CACHE_PORT no .env.');
  });

  it('[Falha de integração] Authentik sem healthcheck → SERVICE_UNHEALTHY, sem derrubar os demais', async () => {
    const logger = memoryLogger();
    const compose = fakeCompose({
      ps: () =>
        DEFAULT_SERVICES.map((service) =>
          container(service, service === 'authentik-server' ? { health: 'starting' } : {}),
        ),
    });
    const promise = envUp({
      root: REPO_ROOT,
      env,
      profiles: [],
      compose,
      authentik: fakeAuthentik(successfulBlueprints),
      logger,
      isPortFree: () => Promise.resolve(true),
      timeoutMs: 120_000,
      ...fakeClock(),
    });
    await expect(promise).rejects.toMatchObject({
      code: 'SERVICE_UNHEALTHY',
      message: unhealthyMessage('authentik-server', 120),
    });
    expect(unhealthyMessage('authentik-server', 120)).toBe(
      'Serviço authentik-server não ficou saudável em 120s. Veja: docker compose logs authentik-server.',
    );
    expect(logger.lines.some((line) => line.startsWith('⚠ env.service_unhealthy'))).toBe(true);
    // Nenhum `down`/`stop`/`rm`: os serviços saudáveis continuam no ar.
    expect(compose.calls.map((call) => call[0])).not.toEqual(
      expect.arrayContaining(['down', 'stop', 'rm']),
    );
  });

  it('bootstrap do MinIO com erro → BOOTSTRAP_FAILED (env.bootstrap_failed)', async () => {
    const logger = memoryLogger();
    const compose = fakeCompose({
      ps: () =>
        DEFAULT_SERVICES.map((service) =>
          container(service, service === 'minio-bootstrap' ? { exitCode: 1 } : {}),
        ),
    });
    await expect(
      envUp({
        root: REPO_ROOT,
        env,
        profiles: [],
        compose,
        authentik: fakeAuthentik(successfulBlueprints),
        logger,
        isPortFree: () => Promise.resolve(true),
        ...fakeClock(),
      }),
    ).rejects.toMatchObject({ code: 'BOOTSTRAP_FAILED' });
    expect(logger.lines[logger.lines.length - 2]).toMatch(
      /^✖ env\.bootstrap_failed — minio-bootstrap/,
    );
  });

  it('[V-06] blueprint inválido → BOOTSTRAP_FAILED apontando os logs do worker', async () => {
    await expect(
      envUp({
        root: REPO_ROOT,
        env,
        profiles: [],
        compose: fakeCompose({ ps: healthy }),
        authentik: fakeAuthentik(() =>
          successfulBlueprints().map((blueprint, index) =>
            index === 0 ? { ...blueprint, status: 'error' } : blueprint,
          ),
        ),
        logger: memoryLogger(),
        isPortFree: () => Promise.resolve(true),
        ...fakeClock(),
      }),
    ).rejects.toThrow(/Blueprint do Authentik inválido .*docker compose logs authentik-worker/);
  });

  it('blueprints ainda não aplicados no tempo limite → BOOTSTRAP_FAILED', async () => {
    let calls = 0;
    await expect(
      envUp({
        root: REPO_ROOT,
        env,
        profiles: [],
        compose: fakeCompose({ ps: healthy }),
        authentik: {
          ...fakeAuthentik(() => []),
          blueprints: () => {
            calls += 1;
            return calls === 1 ? Promise.reject(new Error('HTTP 403')) : Promise.resolve([]);
          },
        },
        logger: memoryLogger(),
        isPortFree: () => Promise.resolve(true),
        blueprintTimeoutMs: 10_000,
        ...fakeClock(),
      }),
    ).rejects.toThrow(/não aplicados em 10s/);
  });

  it('Docker indisponível → DOCKER_UNAVAILABLE', async () => {
    await expect(
      envUp({
        root: REPO_ROOT,
        env,
        profiles: [],
        compose: fakeCompose({
          ps: () => [],
          version: { status: null, stdout: '', stderr: 'ENOENT' },
        }),
        authentik: fakeAuthentik(successfulBlueprints),
        logger: memoryLogger(),
      }),
    ).rejects.toMatchObject({ code: 'DOCKER_UNAVAILABLE' });
  });
});

describe('envCheck (guarda do pnpm dev)', () => {
  it('[Falha de banco] Postgres fora do ar → ENV_NOT_READY e api/worker não sobem', async () => {
    const compose = fakeCompose({
      ps: () =>
        DEFAULT_SERVICES.filter((service) => service !== 'postgres').map((service) =>
          container(service),
        ),
    });
    await expect(envCheck(compose, memoryLogger())).rejects.toMatchObject({
      code: 'ENV_NOT_READY',
      message: expect.stringContaining('Suba o ambiente antes: pnpm env:up.') as string,
    });
  });

  it('infraestrutura saudável → ok', async () => {
    const logger = memoryLogger();
    await envCheck(
      fakeCompose({ ps: () => DEFAULT_SERVICES.map((service) => container(service)) }),
      logger,
    );
    expect(logger.lines).toEqual(['✔ env.check.ok — Infraestrutura local saudável.']);
  });
});
