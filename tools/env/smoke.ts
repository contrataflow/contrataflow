// pnpm env:smoke — smoke test do ambiente local (US-078 — Testes necessários): sobe o Compose, roda
// o seed e verifica bancos, Redis separados, buckets, login OIDC de ponta a ponta com um usuário
// semeado, e-mail no Mailpit, recuperação de senha (US-089), PDF no Gotenberg, varredura no ClamAV,
// isolamento entre os tenants, idempotência do seed e subida reentrante (dois `env:up` em paralelo).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

import { authentikBaseUrl, BLUEPRINT_PATH_PREFIX } from './lib/authentik.js';
import { createContext, runMain, upTimeoutMs, withEnvLock } from './lib/cli.js';
import type { EnvContext } from './lib/cli.js';
import { portOf } from './lib/env-file.js';
import { query } from './lib/psql.js';
import { envSeed } from './lib/seed.js';
import { envUp, expectedBlueprints } from './lib/up.js';
import { SEED_USER_PATH } from './seed/blueprint.js';
import { seedUsers, TENANTS } from './seed/dataset.js';
import { expectedCounts } from './seed/sql.js';
import { oidcLogin } from './smoke/oidc.js';
import {
  clamavScan,
  EICAR_SHA256,
  eicarTestFile,
  gotenbergPdf,
  mailpitHasMessage,
  sendSmtp,
  sha256,
} from './smoke/probes.js';
import {
  createTempUser,
  deleteUser,
  FlowBrowser,
  openRecoveryLink,
  recoveryMail,
  requestRecovery,
  strongPassword,
  submitNewPassword,
} from './smoke/recovery.js';
import {
  externalSubjectSql,
  leakQuerySql,
  noContextSql,
  userTenantsSql,
} from './smoke/tenant-leak.js';
import type { LeakCounts } from './smoke/tenant-leak.js';

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const checks: Check[] = [];

async function check(name: string, run: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await run();
    checks.push({ name, ok: true, detail: `${detail} (${Date.now() - started} ms)` });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function buckets(context: EnvContext): Promise<string[]> {
  const result = await context.compose.run([
    'exec',
    '-T',
    'minio',
    'sh',
    '-c',
    'mc alias set cf http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc ls --json cf',
  ]);
  if (result.status !== 0) throw new Error(`mc ls falhou: ${result.stderr.trim()}`);
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => (JSON.parse(line) as { key: string }).key.replace(/\/$/, ''))
    .sort();
}

async function redisCli(context: EnvContext, service: string, args: readonly string[]) {
  const result = await context.compose.run(['exec', '-T', service, 'redis-cli', ...args]);
  if (result.status !== 0) throw new Error(`redis-cli em ${service} falhou`);
  return result.stdout.trim();
}

/** Dois `env:up` simultâneos, como dois terminais (Gherkin "[Concorrência]"). */
function concurrentUps(context: EnvContext): Promise<{ code: number; stderr: string }[]> {
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
  const once = () =>
    new Promise<{ code: number; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [tsxCli, 'env/up.ts'], {
        cwd: path.join(context.root, 'tools'),
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once('close', (code) => {
        resolve({ code: code ?? 1, stderr });
      });
    });
  return Promise.all([once(), once()]);
}

await runMain(async () => {
  const context = createContext();
  const { env, psql, logger } = context;
  const users = seedUsers();
  const ana = users.find((user) => user.username === 'requisitante.a');
  if (!ana) throw new Error('dataset sem a persona REQUISITANTE da Prefeitura A');
  const timeoutMs = upTimeoutMs(env);

  // [Sucesso] Subir do zero (ou reaproveitar o que já está de pé) e semear.
  await withEnvLock(context, () =>
    envUp({ ...context, profiles: [], ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
  );
  const first = await envSeed(context);

  await check('postgres: bancos contrataflow e authentik', async () => {
    const names = await query(
      psql,
      "SELECT string_agg(datname, ',' ORDER BY datname) FROM pg_database WHERE datname IN ('contrataflow', 'authentik');",
    );
    expect(names === 'authentik,contrataflow', `bancos encontrados: ${names}`);
    return names;
  });

  await check('postgres: extensões só no banco contrataflow', async () => {
    const sql =
      "SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension WHERE extname IN ('vector', 'pg_trgm', 'unaccent', 'citext');";
    const app = await query(psql, sql);
    const authentik = await query(psql, sql, { database: 'authentik' });
    expect(app === 'citext,pg_trgm,unaccent,vector', `contrataflow: ${app}`);
    expect(authentik === '', `authentik não deveria ter extensões: ${authentik}`);
    return app;
  });

  await check('redis: sessão e cache são instâncias separadas', async () => {
    const key = `cf:smoke:${randomUUID()}`;
    await redisCli(context, 'redis-session', ['SET', key, '1', 'EX', '60']);
    const fromCache = await redisCli(context, 'redis-cache', ['EXISTS', key]);
    const policy = await redisCli(context, 'redis-cache', ['CONFIG', 'GET', 'maxmemory-policy']);
    await redisCli(context, 'redis-session', ['DEL', key]);
    expect(fromCache === '0', 'chave da sessão visível no Redis de cache');
    expect(policy.includes('noeviction'), `maxmemory-policy do cache: ${policy}`);
    return 'chave isolada; cache com noeviction (BullMQ)';
  });

  const bucketsBefore = await buckets(context).catch(() => [] as string[]);
  await check('minio: buckets lógicos criados pelo bootstrap', () => {
    const expected = [
      env.S3_BUCKET_DOCUMENTS ?? 'contrataflow-dev-documents',
      env.S3_BUCKET_QUARANTINE ?? 'contrataflow-dev-quarantine',
      env.S3_BUCKET_RENDITIONS ?? 'contrataflow-dev-renditions',
    ].sort();
    expect(
      JSON.stringify(bucketsBefore) === JSON.stringify(expected),
      `buckets: ${bucketsBefore.join(', ')}`,
    );
    return Promise.resolve(bucketsBefore.join(', '));
  });

  await check(
    'seed: tenants "Prefeitura A" e "Prefeitura B" com usuários por persona',
    async () => {
      const names = await query(
        psql,
        "SELECT string_agg(name, ',' ORDER BY name) FROM dev_seed.tenants WHERE status = 'ACTIVE';",
      );
      expect(names === TENANTS.map((tenant) => tenant.name).join(','), `tenants: ${names}`);
      expect(first.after.users === users.length, `usuários: ${first.after.users}`);
      return `${names}; ${first.after.users} usuários, ${first.after.roles} perfis, ${first.after.workflows} workflows`;
    },
  );

  let anaSub = '';
  await check('authentik: login OIDC (code + PKCE) com usuário semeado', async () => {
    const result = await oidcLogin({
      issuer: `http://localhost:${portOf(env, 'AUTHENTIK_PORT')}/application/o/contrataflow/`,
      clientId: env.OIDC_CLIENT_ID ?? '',
      clientSecret: env.OIDC_CLIENT_SECRET ?? '',
      redirectUri: `${env.APP_BASE_URL ?? 'http://localhost:3000'}/api/auth/callback`,
      username: ana.username,
      password: env.CF_DEV_USER_PASSWORD ?? '',
    });
    anaSub = String(result.claims.sub);
    const registered = await query(psql, externalSubjectSql(ana.id));
    expect(anaSub === registered, 'sub do id_token diferente do external_subject semeado');
    expect(result.claims.email === ana.email, `email: ${String(result.claims.email)}`);
    expect(result.hasRefreshToken, 'sem refresh_token (offline_access)');
    return `${ana.username} (${ana.name}) → sub ${anaSub.slice(0, 8)}…, ${String(result.idTokenHeader.alg)}`;
  });

  await check('isolamento: Ana (Prefeitura A) não vê dados da Prefeitura B', async () => {
    const [a, b] = TENANTS;
    if (!a || !b) throw new Error('dataset sem dois tenants');
    const underA = JSON.parse(await query(psql, leakQuerySql(a.slug, ana.id))) as LeakCounts;
    const underB = JSON.parse(await query(psql, leakQuerySql(b.slug, ana.id))) as LeakCounts;
    const noContext = await psql(noContextSql());
    const selector = await query(psql, userTenantsSql(ana.id));
    expect(underA.foreign === 0 && underA.own > 0, `contexto A: ${JSON.stringify(underA)}`);
    expect(underA.userMemberships === 1, 'vínculo de Ana invisível no próprio tenant');
    expect(
      underB.foreign === 0 && underB.userMemberships === 0,
      `contexto B: ${JSON.stringify(underB)}`,
    );
    expect(!noContext.ok, 'consulta sem app.tenant_id deveria falhar fechada');
    expect(selector === a.name, `seletor de tenant de Ana: ${selector}`);
    return `0 linhas de outro tenant; sem contexto falha fechado; seletor: ${selector}`;
  });

  await check('mailpit: e-mail enviado por SMTP é capturado', async () => {
    const subject = `[smoke] ContrataFlow ${randomUUID()}`;
    await sendSmtp('127.0.0.1', portOf(env, 'MAILPIT_SMTP_PORT'), {
      from: 'nao-responda@contrataflow.test',
      to: ana.email,
      subject,
      text: 'Mensagem de teste do pnpm env:smoke.',
    });
    const found = await mailpitHasMessage(
      `http://localhost:${portOf(env, 'MAILPIT_UI_PORT')}`,
      subject,
    );
    expect(found, 'mensagem não encontrada no Mailpit');
    return 'mensagem encontrada pela API do Mailpit';
  });

  await check('authentik: recuperação de senha de ponta a ponta (US-089)', async () => {
    const admin = { baseUrl: authentikBaseUrl(env), token: env.AUTHENTIK_BOOTSTRAP_TOKEN ?? '' };
    const user = await createTempUser(admin);
    try {
      await requestRecovery(new FlowBrowser(admin.baseUrl), user.email);
      const mail = await recoveryMail(
        `http://localhost:${portOf(env, 'MAILPIT_UI_PORT')}`,
        user.email,
      );
      const browser = new FlowBrowser(admin.baseUrl);
      const prompt = await openRecoveryLink(browser, mail.link);
      expect(prompt.component === 'ak-stage-prompt', `etapa inesperada: ${prompt.component}`);
      const done = await submitNewPassword(browser, mail.link, strongPassword());
      const target = done.to ?? '';
      expect(target.endsWith('/entrar?motivo=senha-redefinida'), `destino final: ${target}`);
      return `e-mail no Mailpit, nova senha aceita → ${new URL(target).pathname}`;
    } finally {
      await deleteUser(admin, user.pk);
    }
  });

  await check('gotenberg: PDF de teste gerado', async () => {
    const pdf = await gotenbergPdf(
      `http://localhost:${portOf(env, 'GOTENBERG_PORT')}`,
      '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Smoke</title><h1>ContrataFlow — smoke</h1></html>',
    );
    expect(pdf.subarray(0, 5).toString('latin1') === '%PDF-', 'resposta não é PDF');
    return `${pdf.length} bytes`;
  });

  await check('clamav: arquivo de teste EICAR detectado e arquivo limpo aceito', async () => {
    const eicar = eicarTestFile();
    expect(sha256(eicar) === EICAR_SHA256, 'arquivo EICAR montado incorretamente');
    const port = portOf(env, 'CLAMAV_PORT');
    const infected = await clamavScan('127.0.0.1', port, eicar);
    const clean = await clamavScan('127.0.0.1', port, Buffer.from('ContrataFlow — arquivo limpo'));
    expect(infected.endsWith('FOUND'), `EICAR: ${infected}`);
    expect(clean.endsWith('OK'), `arquivo limpo: ${clean}`);
    return infected;
  });

  // [Duplicidade] e [Concorrência]: reexecutar seed e dois env:up simultâneos não duplica nada.
  await check('idempotência: seed reexecutado e dois env:up em paralelo', async () => {
    const runs = await concurrentUps(context);
    const codes = runs.map((run) => run.code);
    expect(
      codes.every((code) => code === 0),
      `env:up em paralelo falhou: ${runs.map((run) => `${run.code} ${run.stderr.trim().split('\n').slice(-2).join(' ')}`).join(' | ')}`,
    );
    const second = await envSeed(context);
    const expected = expectedCounts();
    expect(second.skippedExisting, 'o segundo seed criou linhas novas');
    expect(
      JSON.stringify(second.after) === JSON.stringify(expected),
      'contagens divergentes após reexecução',
    );
    const bucketsAfter = await buckets(context);
    expect(
      JSON.stringify(bucketsAfter) === JSON.stringify(bucketsBefore),
      `buckets após reexecução: ${bucketsAfter.join(', ')}`,
    );
    const blueprints = await context.authentik.blueprints(BLUEPRINT_PATH_PREFIX);
    expect(
      blueprints.length === expectedBlueprints(context.root).length,
      `instâncias de blueprint: ${blueprints.length}`,
    );
    const authentikUsers = await context.authentik.usersInPath(SEED_USER_PATH);
    expect(
      authentikUsers.length === users.length,
      `usuários no Authentik: ${authentikUsers.length}`,
    );
    return `códigos ${codes.join('/')}; ${bucketsAfter.length} buckets, ${blueprints.length} blueprints, ${authentikUsers.length} usuários`;
  });

  for (const item of checks) {
    logger.step(`${item.ok ? '✔' : '✖'} ${item.name} — ${item.detail}`);
  }
  const failed = checks.filter((item) => !item.ok).length;
  if (failed > 0) {
    logger.error('env.smoke.failed', `${failed} de ${checks.length} verificações falharam.`);
    process.exitCode = 1;
  } else {
    logger.info('env.smoke.completed', `${checks.length} verificações aprovadas.`);
  }
});
