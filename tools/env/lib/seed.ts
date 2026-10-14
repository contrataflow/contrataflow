// `pnpm env:seed` (US-078 — fluxo principal 4 · RN-FND-18 · V-05). Idempotente: ids
// determinísticos e `ON CONFLICT DO NOTHING`; reexecutar não duplica tenants, usuários nem catálogos.

import type { AuthentikApi, AuthentikUser } from './authentik.js';
import { composeStatus, readinessOf } from './compose.js';
import type { Compose } from './compose.js';
import { EnvError } from './log.js';
import type { Logger } from './log.js';
import { query } from './psql.js';
import type { Psql } from './psql.js';
import { SEED_USER_PATH } from '../seed/blueprint.js';
import { seedUsers } from '../seed/dataset.js';
import type { AuthentikIdentity, SeedTable } from '../seed/sql.js';
import {
  buildSeedSql,
  countsSql,
  expectedCounts,
  schemaExistsSql,
  zeroCounts,
} from '../seed/sql.js';

/** Serviços que o seed usa: banco, IdP (com blueprint aplicado) e storage já inicializado. */
export const SEED_REQUIRED_SERVICES = [
  'postgres',
  'minio-bootstrap',
  'authentik-server',
  'authentik-worker',
] as const;

export interface SeedDeps {
  readonly compose: Compose;
  readonly psql: Psql;
  readonly authentik: AuthentikApi;
  readonly logger: Logger;
  /** Espera pelos usuários do blueprint (1º start do Authentik). */
  readonly usersTimeoutMs?: number;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type SeedCounts = Record<SeedTable, number>;

export interface SeedReport {
  readonly before: SeedCounts;
  readonly after: SeedCounts;
  readonly created: Partial<SeedCounts>;
  readonly skippedExisting: boolean;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export const ENV_NOT_READY_MESSAGE = 'Suba o ambiente antes: pnpm env:up.';

async function assertReady(compose: Compose): Promise<void> {
  const readiness = readinessOf(SEED_REQUIRED_SERVICES, await composeStatus(compose));
  const pending = readiness.filter((item) => item.readiness !== 'ready');
  if (pending.length > 0) {
    throw new EnvError(
      'ENV_NOT_READY',
      `${ENV_NOT_READY_MESSAGE} (fora do ar: ${pending.map((item) => item.service).join(', ')})`,
    );
  }
}

async function readCounts(psql: Psql): Promise<SeedCounts> {
  if ((await query(psql, schemaExistsSql())) !== 't') return zeroCounts();
  return JSON.parse(await query(psql, countsSql())) as SeedCounts;
}

async function waitForUsers(deps: SeedDeps): Promise<Map<string, AuthentikIdentity>> {
  const expected = seedUsers().map((user) => user.username);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const timeoutMs = deps.usersTimeoutMs ?? 120_000;
  const deadline = now() + timeoutMs;
  let found: AuthentikUser[] = [];
  for (;;) {
    found = await deps.authentik.usersInPath(SEED_USER_PATH);
    const byName = new Map(
      found.map((user) => [user.username, { pk: String(user.pk), uuid: user.uuid }]),
    );
    if (expected.every((username) => byName.has(username))) return byName;
    if (now() >= deadline) {
      const missing = expected.filter((username) => !byName.has(username));
      const message = `${missing.length} usuário(s) do blueprint ausentes no Authentik após ${Math.round(timeoutMs / 1000)}s (ex.: ${missing.slice(0, 3).join(', ')}). Veja: docker compose logs authentik-worker.`;
      deps.logger.error('env.bootstrap_failed', message);
      throw new EnvError('BOOTSTRAP_FAILED', message);
    }
    await sleep(deps.intervalMs ?? 3000);
  }
}

export async function envSeed(deps: SeedDeps): Promise<SeedReport> {
  // V-05: sem o ambiente de pé, interrompe sem alterar dados.
  await assertReady(deps.compose);
  const identities = await waitForUsers(deps);

  const before = await readCounts(deps.psql);
  const result = await deps.psql(buildSeedSql(identities));
  if (!result.ok) {
    throw new EnvError('SEED_FAILED', `O seed falhou no PostgreSQL: ${result.stderr}`);
  }
  const after = await readCounts(deps.psql);

  const expected = expectedCounts();
  const mismatched = (Object.keys(expected) as SeedTable[]).filter(
    (table) => after[table] !== expected[table],
  );
  if (mismatched.length > 0) {
    throw new EnvError(
      'SEED_INCONSISTENT',
      `Contagens inesperadas em ${mismatched.map((table) => `${table} (${after[table]}/${expected[table]})`).join(', ')}. Rode "pnpm env:reset" para recomeçar do zero.`,
    );
  }

  const created: Partial<SeedCounts> = {};
  for (const table of Object.keys(after) as SeedTable[]) {
    const delta = after[table] - before[table];
    if (delta > 0) created[table] = delta;
  }
  const skippedExisting = Object.keys(created).length === 0;
  if (skippedExisting) {
    deps.logger.warn(
      'env.seed.skipped_existing',
      'Tenants "Prefeitura A" e "Prefeitura B" já semeados; nada foi recriado.',
      { totals: after },
    );
  } else {
    deps.logger.info(
      'env.seed.completed',
      'Tenants "Prefeitura A" e "Prefeitura B" semeados (15 personas cada).',
      { created },
    );
  }
  deps.logger.step(
    'Login local: <perfil>.<a|b> (ex.: requisitante.a) com a senha CF_DEV_USER_PASSWORD do .env — veja CONTRIBUTING.md.',
  );
  return { before, after, created, skippedExisting };
}
