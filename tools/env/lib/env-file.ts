// Leitura e validação do `.env` antes de qualquer chamada ao Docker (story US-078 — V-01, V-02).
// Mensagens citam só o NOME da variável, nunca o valor (story US-078 — Logs).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { EnvError } from './log.js';

export const ENV_FILE = '.env';
export const ENV_EXAMPLE_FILE = '.env.example';

export type EnvMap = Readonly<Record<string, string>>;

export interface EnvIssue {
  readonly code: 'ENV_FILE_MISSING' | 'ENV_VAR_MISSING' | 'ENV_VAR_INVALID';
  readonly variable?: string;
  readonly message: string;
}

interface RequiredVar {
  readonly name: string;
  readonly minLength: number;
}

/** Variáveis obrigatórias (story US-078 — Campos) e o tamanho mínimo de cada uma. */
export const REQUIRED_VARS: readonly RequiredVar[] = [
  { name: 'POSTGRES_PASSWORD', minLength: 8 },
  { name: 'MINIO_ROOT_USER', minLength: 3 },
  { name: 'MINIO_ROOT_PASSWORD', minLength: 8 },
  { name: 'S3_ACCESS_KEY_ID', minLength: 3 },
  { name: 'S3_SECRET_ACCESS_KEY', minLength: 8 },
  { name: 'AUTHENTIK_SECRET_KEY', minLength: 32 },
  { name: 'AUTHENTIK_BOOTSTRAP_PASSWORD', minLength: 8 },
  { name: 'AUTHENTIK_BOOTSTRAP_TOKEN', minLength: 16 },
  { name: 'OIDC_CLIENT_ID', minLength: 1 },
  { name: 'OIDC_CLIENT_SECRET', minLength: 16 },
  { name: 'CF_DEV_USER_PASSWORD', minLength: 8 },
];

/** Portas publicadas (opcionais) e o padrão de cada uma; a porta interna nunca muda (FA-03). */
export const PORT_DEFAULTS: Readonly<Record<string, number>> = {
  POSTGRES_PORT: 5432,
  REDIS_SESSION_PORT: 6379,
  REDIS_CACHE_PORT: 6380,
  MINIO_PORT: 9000,
  MINIO_CONSOLE_PORT: 9001,
  AUTHENTIK_PORT: 9080,
  AUTHENTIK_HTTPS_PORT: 9443,
  MAILPIT_SMTP_PORT: 1025,
  MAILPIT_UI_PORT: 8025,
  GOTENBERG_PORT: 3030,
  CLAMAV_PORT: 3310,
  GRAFANA_PORT: 3001,
  PROMETHEUS_PORT: 9090,
  LOKI_PORT: 3100,
  TEMPO_PORT: 3200,
  OTEL_GRPC_PORT: 4317,
  OTEL_HTTP_PORT: 4318,
  WEB_PORT: 3000,
  API_PORT: 4000,
};

export const PROFILES = ['observability', 'full'] as const;
export type Profile = (typeof PROFILES)[number];

const S3_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** Interpreta um arquivo dotenv: `CHAVE=valor`, comentários `#`, aspas simples/duplas, `export`. */
export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key = '', rawValue = ''] = match;
    let value = rawValue;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    env[key] = value;
  }
  return env;
}

/** Valida as variáveis (V-02 e regras da tabela "Campos"); devolve todos os problemas. */
export function validateEnv(env: EnvMap): EnvIssue[] {
  const issues: EnvIssue[] = [];
  for (const { name, minLength } of REQUIRED_VARS) {
    const value = env[name] ?? '';
    if (value.trim() === '') {
      issues.push({ code: 'ENV_VAR_MISSING', variable: name, message: `Defina ${name} no .env.` });
    } else if (value.length < minLength) {
      issues.push({
        code: 'ENV_VAR_INVALID',
        variable: name,
        message: `${name} deve ter ao menos ${minLength} caracteres.`,
      });
    }
  }
  for (const name of Object.keys(PORT_DEFAULTS)) {
    const value = env[name];
    if (value === undefined || value === '') continue;
    const port = Number(value);
    if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
      issues.push({
        code: 'ENV_VAR_INVALID',
        variable: name,
        message: `${name} deve ser uma porta entre 1 e 65535.`,
      });
    }
  }
  const profiles = parseProfiles(env.COMPOSE_PROFILES ?? '');
  const unknown = profiles.filter((profile) => !(PROFILES as readonly string[]).includes(profile));
  if (unknown.length > 0) {
    issues.push({
      code: 'ENV_VAR_INVALID',
      variable: 'COMPOSE_PROFILES',
      message: `COMPOSE_PROFILES aceita apenas: ${PROFILES.join(', ')}.`,
    });
  }
  for (const name of ['S3_BUCKET_QUARANTINE', 'S3_BUCKET_DOCUMENTS', 'S3_BUCKET_RENDITIONS']) {
    const value = env[name];
    if (value && !S3_BUCKET.test(value)) {
      issues.push({
        code: 'ENV_VAR_INVALID',
        variable: name,
        message: `${name} não é um nome de bucket S3 válido.`,
      });
    }
  }
  const baseUrl = env.APP_BASE_URL;
  if (baseUrl && !/^https?:\/\/[^/\s]+$/.test(baseUrl)) {
    issues.push({
      code: 'ENV_VAR_INVALID',
      variable: 'APP_BASE_URL',
      message: 'APP_BASE_URL deve ser uma URL http(s) sem barra final.',
    });
  }
  return issues;
}

export function parseProfiles(value: string): string[] {
  return value
    .split(',')
    .map((profile) => profile.trim())
    .filter((profile) => profile !== '');
}

/**
 * Ambiente efetivo como o Docker Compose o enxerga: o `.env` da raiz, sobreposto pelas variáveis
 * já definidas no shell (o Compose dá precedência ao shell).
 */
export function loadEnv(root: string, processEnv: NodeJS.ProcessEnv = process.env): EnvMap {
  const file = path.join(root, ENV_FILE);
  if (!existsSync(file)) {
    throw new EnvError(
      'ENV_FILE_MISSING',
      'Arquivo .env não encontrado. Rode: cp .env.example .env',
    );
  }
  const fromFile = parseEnvFile(readFileSync(file, 'utf8'));
  const merged: Record<string, string> = { ...fromFile };
  for (const key of Object.keys(fromFile)) {
    const override = processEnv[key];
    if (override !== undefined) merged[key] = override;
  }
  return merged;
}

/** Porta publicada efetiva de uma variável `*_PORT`. */
export function portOf(env: EnvMap, name: string): number {
  const value = env[name];
  return value ? Number(value) : (PORT_DEFAULTS[name] ?? 0);
}
