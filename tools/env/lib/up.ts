// `pnpm env:up` (US-078 — fluxo principal 2–3, FA-01/02/03/05, V-03, V-04, V-06).
import { readdirSync } from 'node:fs';
import path from 'node:path';

import { BLUEPRINT_PATH_PREFIX } from './authentik.js';
import type { AuthentikApi, BlueprintStatus } from './authentik.js';
import {
  composeStatus,
  ONE_SHOT_SERVICES,
  servicesFor,
  unhealthyMessage,
  waitForServices,
} from './compose.js';
import type { Compose, ServiceReadiness } from './compose.js';
import type { EnvMap, Profile } from './env-file.js';
import { EnvError } from './log.js';
import type { Logger } from './log.js';
import {
  findPortConflicts,
  isPortFree,
  portBindings,
  portFromDockerError,
  portInUseMessage,
  variableForPort,
} from './ports.js';

export interface UpDeps {
  readonly root: string;
  readonly env: EnvMap;
  readonly profiles: readonly Profile[];
  readonly compose: Compose;
  readonly authentik: AuthentikApi;
  readonly logger: Logger;
  readonly isPortFree?: (port: number) => Promise<boolean>;
  /** Tempo limite dos healthchecks (V-04). */
  readonly timeoutMs?: number;
  readonly blueprintTimeoutMs?: number;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_UP_TIMEOUT_MS = 600_000;
const DEFAULT_BLUEPRINT_TIMEOUT_MS = 180_000;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Blueprints versionados em infra/authentik/blueprints (caminho visto pelo Authentik). */
export function expectedBlueprints(root: string): string[] {
  return readdirSync(path.join(root, 'infra', 'authentik', 'blueprints'))
    .filter((file) => file.endsWith('.yaml'))
    .sort()
    .map((file) => `${BLUEPRINT_PATH_PREFIX}${file}`);
}

function reportFailures(
  deps: UpDeps,
  failed: readonly ServiceReadiness[],
  unhealthy: readonly ServiceReadiness[],
  timeoutSeconds: number,
): never {
  const messages: string[] = [];
  for (const item of failed) {
    if (ONE_SHOT_SERVICES.includes(item.service)) {
      const message = `${item.service} ${item.detail}. Veja: docker compose logs ${item.service}.`;
      deps.logger.error('env.bootstrap_failed', message);
      messages.push(message);
    } else {
      const message = `Serviço ${item.service} ${item.detail}. Veja: docker compose logs ${item.service}.`;
      deps.logger.warn('env.service_unhealthy', message);
      messages.push(message);
    }
  }
  for (const item of unhealthy) {
    const message = unhealthyMessage(item.service, timeoutSeconds);
    deps.logger.warn('env.service_unhealthy', message, {
      service: item.service,
      state: item.detail,
    });
    messages.push(message);
  }
  deps.logger.step(
    'Os serviços já saudáveis continuam no ar; corrija o problema e rode "pnpm env:up" de novo.',
  );
  const code =
    unhealthy.length === 0 && failed.every((item) => ONE_SHOT_SERVICES.includes(item.service))
      ? 'BOOTSTRAP_FAILED'
      : 'SERVICE_UNHEALTHY';
  throw new EnvError(code, messages.join('\n'));
}

/** Espera os blueprints do ContrataFlow ficarem `successful` (RN-FND-17 · V-06). */
async function waitForBlueprints(deps: UpDeps): Promise<BlueprintStatus[]> {
  const expected = expectedBlueprints(deps.root);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = now() + (deps.blueprintTimeoutMs ?? DEFAULT_BLUEPRINT_TIMEOUT_MS);
  let last: BlueprintStatus[] = [];
  let lastError = '';
  for (;;) {
    try {
      last = await deps.authentik.blueprints(BLUEPRINT_PATH_PREFIX);
      lastError = '';
      const failed = last.filter((blueprint) => blueprint.status === 'error');
      if (failed.length > 0) {
        const names = failed.map((blueprint) => blueprint.path).join(', ');
        const message = `Blueprint do Authentik inválido (${names}). Veja: docker compose logs authentik-worker.`;
        deps.logger.error('env.bootstrap_failed', message);
        throw new EnvError('BOOTSTRAP_FAILED', message);
      }
      const done = expected.every((file) =>
        last.some((blueprint) => blueprint.path === file && blueprint.status === 'successful'),
      );
      if (done) return last;
    } catch (error) {
      if (error instanceof EnvError) throw error;
      // API ainda subindo ou token de bootstrap ainda não criado: tenta de novo.
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (now() >= deadline) {
      const pending = expected.filter(
        (file) =>
          !last.some((blueprint) => blueprint.path === file && blueprint.status === 'successful'),
      );
      const message = `Blueprints do Authentik não aplicados em ${Math.round((deps.blueprintTimeoutMs ?? DEFAULT_BLUEPRINT_TIMEOUT_MS) / 1000)}s (${pending.join(', ')}${lastError ? `; ${lastError}` : ''}). Veja: docker compose logs authentik-worker.`;
      deps.logger.error('env.bootstrap_failed', message);
      throw new EnvError('BOOTSTRAP_FAILED', message);
    }
    await sleep(deps.intervalMs ?? 3000);
  }
}

export async function envUp(deps: UpDeps): Promise<void> {
  const started = (deps.now ?? Date.now)();
  const services = servicesFor(deps.profiles);

  const version = await deps.compose.run(['version', '--short']);
  if (version.status !== 0) {
    throw new EnvError(
      'DOCKER_UNAVAILABLE',
      'Docker Compose v2 indisponível. Inicie o Docker Engine/Docker Desktop e tente de novo.',
    );
  }

  // V-03: porta ocupada por outro processo → falha antes de subir qualquer contêiner.
  const owned = new Set((await composeStatus(deps.compose)).flatMap((item) => item.publishedPorts));
  const conflicts = await findPortConflicts(
    portBindings(deps.env, services),
    owned,
    deps.isPortFree ?? isPortFree,
  );
  if (conflicts.length > 0) {
    throw new EnvError(
      'PORT_IN_USE',
      conflicts.map(({ port, variable }) => portInUseMessage(port, variable)).join('\n'),
    );
  }

  deps.logger.step(
    `▶ docker compose up -d${deps.profiles.map((profile) => ` --profile ${profile}`).join('')}`,
  );
  const up = await deps.compose.run(['up', '-d'], { stream: true, profiles: deps.profiles });
  if (up.status !== 0) {
    const output = `${up.stdout}\n${up.stderr}`;
    const port = portFromDockerError(output);
    if (port !== undefined) {
      const variable = variableForPort(deps.env, port) ?? 'a variável *_PORT correspondente';
      throw new EnvError('PORT_IN_USE', portInUseMessage(port, variable));
    }
    if (!/dependency failed to start|is unhealthy|didn't complete successfully/i.test(output)) {
      throw new EnvError('COMPOSE_FAILED', 'docker compose up falhou (veja a saída acima).');
    }
  }

  const timeoutMs = up.status === 0 ? (deps.timeoutMs ?? DEFAULT_UP_TIMEOUT_MS) : 0;
  let lastProgress = '';
  const waitOptions = {
    timeoutMs,
    onProgress: (pending: readonly ServiceReadiness[]) => {
      const progress = `… aguardando: ${pending.map((item) => `${item.service} (${item.detail})`).join(', ')}`;
      if (progress !== lastProgress) deps.logger.step(progress);
      lastProgress = progress;
    },
    ...(deps.intervalMs === undefined ? {} : { intervalMs: deps.intervalMs }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
  };
  const result = await waitForServices(services, () => composeStatus(deps.compose), waitOptions);
  if (result.failed.length > 0 || result.unhealthy.length > 0) {
    reportFailures(
      deps,
      result.failed,
      result.unhealthy,
      Math.round((deps.timeoutMs ?? DEFAULT_UP_TIMEOUT_MS) / 1000),
    );
  }

  await waitForBlueprints(deps);

  const seconds = Math.round(((deps.now ?? Date.now)() - started) / 1000);
  deps.logger.info('env.up.completed', `${services.length} serviços prontos em ${seconds}s.`, {
    services,
    durationSeconds: seconds,
  });
}
