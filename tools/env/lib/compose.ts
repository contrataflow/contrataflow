// Docker Compose do ambiente local (US-078 · RN-FND-13): argumentos, estado dos serviços e espera
// pelos healthchecks (V-04). Executa `docker` sem shell (o executável é resolvido pelo PATH também
// no Windows), então nenhum argumento passa por interpretação de shell.
import { spawn } from 'node:child_process';
import path from 'node:path';

import { ENV_FILE } from './env-file.js';
import type { Profile } from './env-file.js';

export const PROJECT_NAME = 'contrataflow';

/**
 * Projeto do Compose: `COMPOSE_PROJECT_NAME` do `.env` (o CI usa um por execução — US-079 FA-02,
 * ambientes efêmeros isolados) ou o padrão `contrataflow`.
 */
export function projectNameFrom(env: Readonly<Record<string, string>>): string {
  const name = env.COMPOSE_PROJECT_NAME?.trim() ?? '';
  return /^[a-z0-9][a-z0-9_-]*$/.test(name) ? name : PROJECT_NAME;
}

/** Arquivos do Compose (relativos à raiz); os perfis ficam nos overrides (RN-FND-13). */
export const COMPOSE_FILES = [
  'infra/docker-compose.yml',
  'infra/compose/observability.yml',
  'infra/compose/full.yml',
] as const;

/** Serviços padrão (RN-FND-13), na ordem de dependência do fluxo principal. */
export const DEFAULT_SERVICES = [
  'postgres',
  'redis-session',
  'redis-cache',
  'minio',
  'minio-bootstrap',
  'authentik-server',
  'authentik-worker',
  'mailpit',
  'gotenberg',
  'clamav',
] as const;

/** Jobs que terminam: prontos quando saem com código 0 (RN-FND-16). */
export const ONE_SHOT_SERVICES: readonly string[] = ['minio-bootstrap'];

export const PROFILE_SERVICES: Readonly<Record<Profile, readonly string[]>> = {
  observability: ['prometheus', 'grafana', 'loki', 'tempo', 'otel-collector'],
  full: ['api', 'web', 'worker'],
};

export function servicesFor(profiles: readonly Profile[]): string[] {
  return [...DEFAULT_SERVICES, ...profiles.flatMap((profile) => PROFILE_SERVICES[profile])];
}

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd: string;
  readonly input?: string;
  /** Repete stdout/stderr no terminal enquanto executa (ex.: download de imagens). */
  readonly stream?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: RunOptions,
) => Promise<CommandResult>;

/** Executa um comando sem shell, coletando a saída (e repetindo-a no terminal se `stream`). */
export const runCommand: CommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (options.stream) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (options.stream) process.stderr.write(chunk);
    });
    child.once('error', (error) => {
      resolve({ status: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once('close', (status) => {
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(options.input ?? '');
  });

/** Prefixo comum: projeto, `.env` da raiz e todos os arquivos (perfis decidem o que sobe). */
export function composeArgs(
  root: string,
  profiles: readonly Profile[],
  args: readonly string[],
  projectName: string = PROJECT_NAME,
) {
  return [
    'compose',
    '--project-name',
    projectName,
    '--env-file',
    path.join(root, ENV_FILE),
    ...COMPOSE_FILES.flatMap((file) => ['-f', path.join(root, file)]),
    ...profiles.flatMap((profile) => ['--profile', profile]),
    ...args,
  ];
}

export interface Compose {
  readonly root: string;
  readonly run: (
    args: readonly string[],
    options?: { input?: string; stream?: boolean; profiles?: readonly Profile[] },
  ) => Promise<CommandResult>;
}

export function createCompose(
  root: string,
  runner: CommandRunner = runCommand,
  projectName: string = PROJECT_NAME,
): Compose {
  return {
    root,
    run: (args, options = {}) =>
      runner('docker', composeArgs(root, options.profiles ?? [], args, projectName), {
        cwd: root,
        ...(options.input === undefined ? {} : { input: options.input }),
        ...(options.stream === undefined ? {} : { stream: options.stream }),
      }),
  };
}

// ---------------------------------------------------------------------------------------------
// Estado dos serviços
// ---------------------------------------------------------------------------------------------

export interface ContainerStatus {
  readonly service: string;
  /** `running`, `exited`, `created`, `restarting`, `paused`, `dead`. */
  readonly state: string;
  /** `healthy`, `unhealthy`, `starting` ou vazio (sem healthcheck). */
  readonly health: string;
  readonly exitCode: number;
  readonly publishedPorts: readonly number[];
}

interface RawPublisher {
  readonly PublishedPort?: number;
}

interface RawContainer {
  readonly Service?: string;
  readonly State?: string;
  readonly Health?: string;
  readonly ExitCode?: number;
  readonly Publishers?: readonly RawPublisher[] | null;
}

/** Interpreta `docker compose ps --all --format json` (JSON por linha ou array, conforme a versão). */
export function parseComposePs(output: string): ContainerStatus[] {
  const trimmed = output.trim();
  if (trimmed === '') return [];
  const raw: RawContainer[] = trimmed.startsWith('[')
    ? (JSON.parse(trimmed) as RawContainer[])
    : trimmed
        .split(/\r?\n/)
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => JSON.parse(line) as RawContainer);
  return raw.map((container) => ({
    service: container.Service ?? '',
    state: (container.State ?? '').toLowerCase(),
    health: (container.Health ?? '').toLowerCase(),
    exitCode: container.ExitCode ?? 0,
    publishedPorts: (container.Publishers ?? [])
      .map((publisher) => publisher.PublishedPort ?? 0)
      .filter((port) => port > 0),
  }));
}

export async function composeStatus(compose: Compose): Promise<ContainerStatus[]> {
  const result = await compose.run(['ps', '--all', '--format', 'json']);
  if (result.status !== 0) return [];
  return parseComposePs(result.stdout);
}

export type Readiness = 'ready' | 'starting' | 'failed' | 'missing';

export interface ServiceReadiness {
  readonly service: string;
  readonly readiness: Readiness;
  readonly detail: string;
}

/** Classifica um serviço: healthy (ou job com exit 0) = pronto; job com erro ou parada = falha. */
export function classifyService(
  service: string,
  status: ContainerStatus | undefined,
): ServiceReadiness {
  if (!status) return { service, readiness: 'missing', detail: 'sem contêiner' };
  if (ONE_SHOT_SERVICES.includes(service)) {
    if (status.state === 'exited') {
      return status.exitCode === 0
        ? { service, readiness: 'ready', detail: 'concluído (exit 0)' }
        : { service, readiness: 'failed', detail: `terminou com código ${status.exitCode}` };
    }
    return { service, readiness: 'starting', detail: status.state };
  }
  if (status.state === 'exited' || status.state === 'dead') {
    return { service, readiness: 'failed', detail: `parado (código ${status.exitCode})` };
  }
  if (status.state !== 'running') return { service, readiness: 'starting', detail: status.state };
  if (status.health === '' || status.health === 'healthy') {
    return { service, readiness: 'ready', detail: status.health || 'running' };
  }
  return { service, readiness: 'starting', detail: status.health };
}

export function readinessOf(
  services: readonly string[],
  statuses: readonly ContainerStatus[],
): ServiceReadiness[] {
  return services.map((service) =>
    classifyService(
      service,
      statuses.find((status) => status.service === service),
    ),
  );
}

export interface WaitOptions {
  readonly timeoutMs: number;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onProgress?: (pending: readonly ServiceReadiness[]) => void;
}

export interface WaitResult {
  readonly ready: readonly string[];
  /** Falhas imediatas (job com erro, contêiner parado). */
  readonly failed: readonly ServiceReadiness[];
  /** Não ficaram prontos no tempo limite (V-04). */
  readonly unhealthy: readonly ServiceReadiness[];
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Espera todos os serviços ficarem prontos. Nunca derruba nada: quem não ficou saudável é só
 * reportado, e os demais seguem no ar (Gherkin "[Falha de integração]").
 */
export async function waitForServices(
  services: readonly string[],
  getStatus: () => Promise<readonly ContainerStatus[]>,
  options: WaitOptions,
): Promise<WaitResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + options.timeoutMs;
  for (;;) {
    const readiness = readinessOf(services, await getStatus());
    const failed = readiness.filter((item) => item.readiness === 'failed');
    const pending = readiness.filter(
      (item) => item.readiness === 'starting' || item.readiness === 'missing',
    );
    const ready = readiness
      .filter((item) => item.readiness === 'ready')
      .map((item) => item.service);
    if (pending.length === 0) return { ready, failed, unhealthy: [] };
    if (now() >= deadline) return { ready, failed, unhealthy: pending };
    options.onProgress?.(pending);
    await sleep(options.intervalMs ?? 3000);
  }
}

/** Mensagem de V-04 (código `SERVICE_UNHEALTHY`). */
export function unhealthyMessage(service: string, timeoutSeconds: number): string {
  return `Serviço ${service} não ficou saudável em ${timeoutSeconds}s. Veja: docker compose logs ${service}.`;
}
