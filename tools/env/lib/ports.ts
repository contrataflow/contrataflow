// Portas publicadas (story US-078 — V-03 · FA-03): verificação prévia antes do Docker e tradução do
// erro nativo do Docker para a variável a ajustar no `.env`.
import { createServer } from 'node:net';

import { portOf } from './env-file.js';
import type { EnvMap } from './env-file.js';

/** Variáveis de porta publicadas por serviço (a porta interna nunca muda). */
export const SERVICE_PORT_VARS: Readonly<Record<string, readonly string[]>> = {
  postgres: ['POSTGRES_PORT'],
  'redis-session': ['REDIS_SESSION_PORT'],
  'redis-cache': ['REDIS_CACHE_PORT'],
  minio: ['MINIO_PORT', 'MINIO_CONSOLE_PORT'],
  'authentik-server': ['AUTHENTIK_PORT', 'AUTHENTIK_HTTPS_PORT'],
  mailpit: ['MAILPIT_SMTP_PORT', 'MAILPIT_UI_PORT'],
  gotenberg: ['GOTENBERG_PORT'],
  clamav: ['CLAMAV_PORT'],
  grafana: ['GRAFANA_PORT'],
  prometheus: ['PROMETHEUS_PORT'],
  loki: ['LOKI_PORT'],
  tempo: ['TEMPO_PORT'],
  'otel-collector': ['OTEL_GRPC_PORT', 'OTEL_HTTP_PORT'],
  web: ['WEB_PORT'],
  api: ['API_PORT'],
};

export interface PortBinding {
  readonly service: string;
  readonly variable: string;
  readonly port: number;
}

export function portBindings(env: EnvMap, services: readonly string[]): PortBinding[] {
  return services.flatMap((service) =>
    (SERVICE_PORT_VARS[service] ?? []).map((variable) => ({
      service,
      variable,
      port: portOf(env, variable),
    })),
  );
}

/** Mensagem de V-03. */
export function portInUseMessage(port: number, variable: string): string {
  return `Porta ${port} ocupada. Ajuste ${variable} no .env.`;
}

/** Tenta escutar na porta (no mesmo endereço que o Compose publica, 127.0.0.1). */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

/**
 * Portas ocupadas por outro processo. Portas já publicadas por este projeto (ambiente de pé,
 * `env:up` reexecutado) não contam como conflito.
 */
export async function findPortConflicts(
  bindings: readonly PortBinding[],
  ownedPorts: ReadonlySet<number>,
  isFree: (port: number) => Promise<boolean> = isPortFree,
): Promise<PortBinding[]> {
  const conflicts: PortBinding[] = [];
  for (const binding of bindings) {
    if (ownedPorts.has(binding.port)) continue;
    if (!(await isFree(binding.port))) conflicts.push(binding);
  }
  return conflicts;
}

const DOCKER_PORT_ERROR =
  /(port is already allocated|address already in use|ports are not available|only one usage of each socket address)/i;

/**
 * Extrai a porta do erro nativo do Docker (Linux: "port is already allocated"; Docker Desktop:
 * "Ports are not available: exposing port TCP 127.0.0.1:5432 …").
 */
export function portFromDockerError(output: string): number | undefined {
  if (!DOCKER_PORT_ERROR.test(output)) return undefined;
  for (const match of output.matchAll(/(?:\d{1,3}(?:\.\d{1,3}){3}|\[::\]):(\d{1,5})\b/g)) {
    const port = Number(match[1]);
    if (port > 0) return port;
  }
  return undefined;
}

/** Variável `*_PORT` cujo valor efetivo é a porta informada. */
export function variableForPort(env: EnvMap, port: number): string | undefined {
  return Object.values(SERVICE_PORT_VARS)
    .flat()
    .find((variable) => portOf(env, variable) === port);
}
