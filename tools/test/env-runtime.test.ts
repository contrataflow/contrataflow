// US-078 — portas (V-03), trava de execução ("[Concorrência]"), CLI e sondas do smoke.
import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { profilesFrom, upTimeoutMs } from '../env/lib/cli.js';
import { lockFileFor, withLock } from '../env/lib/lock.js';
import { formatLine } from '../env/lib/log.js';
import {
  findPortConflicts,
  isPortFree,
  portBindings,
  portFromDockerError,
  portInUseMessage,
  variableForPort,
} from '../env/lib/ports.js';
import { base64url, CookieJar, decodeJwt, pkcePair } from '../env/smoke/oidc.js';
import { EICAR_SHA256, eicarTestFile, sha256 } from '../env/smoke/probes.js';
import { leakQuerySql, noContextSql, userTenantsSql } from '../env/smoke/tenant-leak.js';
import { REPO_ROOT } from '../lib/workspace.js';

describe('portas publicadas (V-03 · FA-03)', () => {
  it('mensagem cita a porta e a variável a ajustar', () => {
    expect(portInUseMessage(5432, 'POSTGRES_PORT')).toBe(
      'Porta 5432 ocupada. Ajuste POSTGRES_PORT no .env.',
    );
  });

  it('mapeia serviços para as variáveis de porta, com padrões', () => {
    expect(portBindings({ MINIO_PORT: '19000' }, ['minio', 'minio-bootstrap'])).toEqual([
      { service: 'minio', variable: 'MINIO_PORT', port: 19000 },
      { service: 'minio', variable: 'MINIO_CONSOLE_PORT', port: 9001 },
    ]);
  });

  it('ignora portas do próprio projeto e acusa as de outros processos', async () => {
    const bindings = portBindings({}, ['postgres', 'redis-session', 'redis-cache']);
    const busy = new Set([5432, 6379]);
    const conflicts = await findPortConflicts(bindings, new Set([6379]), (port) =>
      Promise.resolve(!busy.has(port)),
    );
    expect(conflicts.map((conflict) => conflict.variable)).toEqual(['POSTGRES_PORT']);
  });

  it('isPortFree detecta uma porta realmente ocupada', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      expect(await isPortFree(port)).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(await isPortFree(port)).toBe(true);
  });

  it.each([
    ['Bind for 127.0.0.1:5432 failed: port is already allocated', 5432],
    ['listen tcp 0.0.0.0:6379: bind: address already in use', 6379],
    [
      'Ports are not available: exposing port TCP 127.0.0.1:9000 -> 127.0.0.1:0: listen tcp4 127.0.0.1:9000: bind: Only one usage of each socket address',
      9000,
    ],
  ])('extrai a porta do erro do Docker: %s', (message, port) => {
    expect(portFromDockerError(message)).toBe(port);
  });

  it('não confunde outros erros com porta ocupada', () => {
    expect(portFromDockerError('pull access denied for 127.0.0.1:5000/x')).toBeUndefined();
  });

  it('acha a variável pela porta efetiva', () => {
    expect(variableForPort({ POSTGRES_PORT: '55432' }, 55432)).toBe('POSTGRES_PORT');
    expect(variableForPort({}, 3310)).toBe('CLAMAV_PORT');
    expect(variableForPort({}, 1)).toBeUndefined();
  });
});

describe('trava de execução ([Concorrência] subida reentrante)', () => {
  const file = lockFileFor(REPO_ROOT, `test-${process.pid}`);
  afterEach(() => {
    expect(existsSync(file)).toBe(false);
  });

  it('serializa duas execuções simultâneas', async () => {
    const events: string[] = [];
    let waits = 0;
    const onWait = () => {
      waits += 1;
    };
    const task = (name: string) => () =>
      new Promise<string>((resolve) => {
        events.push(`início ${name}`);
        setTimeout(() => {
          events.push(`fim ${name}`);
          resolve(name);
        }, 30);
      });
    const results = await Promise.all([
      withLock(file, task('A'), { timeoutMs: 5000, pollMs: 5, onWait }),
      withLock(file, task('B'), { timeoutMs: 5000, pollMs: 5, onWait }),
    ]);
    expect(results).toEqual(['A', 'B']);
    // Quem pegar a trava primeiro termina antes de o outro começar (sem intercalação).
    const [first = ''] = events;
    const owner = first.slice(-1);
    const other = owner === 'A' ? 'B' : 'A';
    expect(events).toEqual([`início ${owner}`, `fim ${owner}`, `início ${other}`, `fim ${other}`]);
    expect(waits).toBe(1);
  });

  it('remove a trava de um processo que já morreu', async () => {
    writeFileSync(file, '999999');
    await expect(
      withLock(file, () => Promise.resolve('ok'), { timeoutMs: 1000, isAlive: () => false }),
    ).resolves.toBe('ok');
  });

  it('libera a trava mesmo quando a tarefa falha', async () => {
    await expect(
      withLock(file, () => Promise.reject(new Error('falhou')), { timeoutMs: 1000 }),
    ).rejects.toThrow('falhou');
  });

  it('desiste após o tempo limite se o dono continua vivo', async () => {
    writeFileSync(file, String(process.pid));
    await expect(
      withLock(file, () => Promise.resolve(1), { timeoutMs: 20, pollMs: 5 }),
    ).rejects.toThrow(/ocupada pelo processo/);
    await withLock(file, () => Promise.resolve(1), { timeoutMs: 1000, isAlive: () => false });
  });
});

describe('CLI', () => {
  it('perfis de --profile, --profile=, --full e COMPOSE_PROFILES, sem repetição', () => {
    expect(profilesFrom([], {})).toEqual([]);
    expect(profilesFrom(['--profile', 'observability'], {})).toEqual(['observability']);
    expect(profilesFrom(['--profile=full,observability'], {})).toEqual(['observability', 'full']);
    expect(profilesFrom(['--full'], { COMPOSE_PROFILES: 'full' })).toEqual(['full']);
    expect(() => profilesFrom(['--profile', 'debug'], {})).toThrow(/Perfil desconhecido: debug/);
  });

  it('ENV_UP_TIMEOUT_SECONDS ajusta o tempo limite dos healthchecks', () => {
    expect(upTimeoutMs({ ENV_UP_TIMEOUT_SECONDS: '30' })).toBe(30_000);
    expect(upTimeoutMs({ ENV_UP_TIMEOUT_SECONDS: 'x' })).toBeUndefined();
  });

  it('formatLine: ícone, evento, mensagem e dados', () => {
    expect(formatLine('warn', 'env.service_unhealthy', 'msg', { service: 'x' })).toBe(
      '⚠ env.service_unhealthy — msg {"service":"x"}',
    );
    expect(formatLine('info', 'env.up.completed', 'ok', {})).toBe('✔ env.up.completed — ok');
  });
});

describe('sondas do smoke', () => {
  it('monta o arquivo de teste EICAR em tempo de execução (nunca versionado em claro)', () => {
    const eicar = eicarTestFile();
    expect(eicar).toHaveLength(68);
    expect(sha256(eicar)).toBe(EICAR_SHA256);
  });

  it('PKCE S256: challenge = base64url(SHA-256(verifier))', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(challenge).toBe(base64url(Buffer.from(sha256(Buffer.from(verifier)), 'hex')));
  });

  it('CookieJar guarda e reenvia cookies do Set-Cookie', () => {
    const jar = new CookieJar();
    const headers = new Headers();
    headers.append('Set-Cookie', 'authentik_session=abc; Path=/; HttpOnly');
    headers.append('Set-Cookie', 'authentik_csrf=xyz; Path=/');
    jar.store(new Response(null, { headers }));
    expect(jar.get('authentik_csrf')).toBe('xyz');
    expect(jar.header()).toBe('authentik_session=abc; authentik_csrf=xyz');
  });

  it('decodeJwt separa cabeçalho, payload e assinatura', () => {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${part({ alg: 'RS256' })}.${part({ sub: 'u1' })}.${Buffer.from('sig').toString('base64url')}`;
    const jwt = decodeJwt(token);
    expect(jwt.header).toEqual({ alg: 'RS256' });
    expect(jwt.payload).toEqual({ sub: 'u1' });
    expect(jwt.signature.toString()).toBe('sig');
    expect(jwt.signingInput).toBe(token.split('.').slice(0, 2).join('.'));
  });

  it('consultas de isolamento usam o papel sem BYPASSRLS e contexto por transação', () => {
    const sql = leakQuerySql('prefeitura-a', '00000000-0000-8000-8000-000000000000');
    expect(sql).toMatch(
      /^BEGIN;\nSET LOCAL ROLE dev_seed_reader;\nSELECT set_config\('app\.tenant_id', '[0-9a-f-]{36}', true\)/,
    );
    expect(sql.trimEnd().endsWith('ROLLBACK;')).toBe(true);
    expect(noContextSql()).not.toContain('set_config');
    expect(userTenantsSql("x'y")).toContain("'x''y'");
  });
});
