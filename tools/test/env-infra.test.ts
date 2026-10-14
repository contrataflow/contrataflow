// US-078 — verificação estática da infraestrutura versionada: serviços e perfis (RN-FND-13),
// bancos e extensões (RN-FND-14), Redis separados (RN-FND-15), bootstrap do MinIO (RN-FND-16),
// blueprints do Authentik (RN-FND-17) e ausência de segredo real (RN-FND-19 · "[Permissão]").
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  COMPOSE_FILES,
  DEFAULT_SERVICES,
  ONE_SHOT_SERVICES,
  PROFILE_SERVICES,
} from '../env/lib/compose.js';
import { ENV_EXAMPLE_FILE, parseEnvFile, REQUIRED_VARS } from '../env/lib/env-file.js';
import { SERVICE_PORT_VARS } from '../env/lib/ports.js';
import { renderUsersBlueprint, USERS_BLUEPRINT_FILE } from '../env/seed/blueprint.js';
import { seedUsers } from '../env/seed/dataset.js';
import { REPO_ROOT } from '../lib/workspace.js';

interface ComposeService {
  readonly image?: string;
  readonly profiles?: readonly string[];
  readonly ports?: readonly string[];
  readonly healthcheck?: { readonly test?: unknown };
  readonly depends_on?: Readonly<Record<string, { readonly condition: string }>>;
  readonly volumes?: readonly string[];
  readonly command?: unknown;
}

interface ComposeFile {
  readonly services: Readonly<Record<string, ComposeService>>;
  readonly volumes?: Readonly<Record<string, unknown>>;
}

const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const compose = (file: string) => parse(read(file), { merge: true }) as ComposeFile;
const [baseFile, observabilityFile, fullFile] = COMPOSE_FILES;
const base = compose(baseFile);
const observability = compose(observabilityFile);
const full = compose(fullFile);
const allServices = { ...base.services, ...observability.services, ...full.services };

describe('Compose (RN-FND-13)', () => {
  it('declara exatamente os serviços padrão no arquivo base', () => {
    expect(Object.keys(base.services).sort()).toEqual([...DEFAULT_SERVICES].sort());
  });

  it('perfis observability e full nos overrides', () => {
    expect(Object.keys(observability.services).sort()).toEqual(
      [...PROFILE_SERVICES.observability].sort(),
    );
    expect(Object.keys(full.services).sort()).toEqual([...PROFILE_SERVICES.full].sort());
    for (const service of Object.values(observability.services))
      expect(service.profiles).toEqual(['observability']);
    for (const service of Object.values(full.services)) expect(service.profiles).toEqual(['full']);
    for (const service of Object.values(base.services)) expect(service.profiles).toBeUndefined();
  });

  it.each(DEFAULT_SERVICES.filter((service) => !ONE_SHOT_SERVICES.includes(service)))(
    'serviço padrão %s tem healthcheck',
    (service) => {
      expect(base.services[service]?.healthcheck?.test).toBeTruthy();
    },
  );

  it('imagens com tag exata e digest, nunca latest', () => {
    for (const [name, service] of Object.entries(allServices)) {
      if (!service.image || name === 'api' || name === 'web' || name === 'worker') continue;
      expect(service.image, name).toMatch(/^[a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/);
      expect(service.image, name).not.toMatch(/:latest@/);
    }
    expect(read('infra/docker/app.Dockerfile')).toMatch(
      /^FROM node:24-bookworm-slim@sha256:[0-9a-f]{64}$/m,
    );
  });

  it('authentik-server e authentik-worker usam a mesma tag', () => {
    expect(base.services['authentik-server']?.image).toBe(base.services['authentik-worker']?.image);
  });

  it('authentik-worker só sobe depois do server (volume compartilhado preenchido uma vez)', () => {
    const worker = base.services['authentik-worker']?.depends_on;
    expect(worker?.['authentik-server']?.condition).toBe('service_started');
    expect(worker?.postgres?.condition).toBe('service_healthy');
  });

  it('portas publicadas só em 127.0.0.1 e configuráveis pela variável da tabela "Campos"', () => {
    for (const [name, service] of Object.entries(allServices)) {
      const variables = SERVICE_PORT_VARS[name] ?? [];
      expect(service.ports?.length ?? 0, name).toBe(variables.length);
      (service.ports ?? []).forEach((port, index) => {
        expect(port).toMatch(
          new RegExp(`^127\\.0\\.0\\.1:\\$\\{${variables[index] ?? ''}:-\\d+\\}:\\d+$`),
        );
      });
    }
  });

  it('volumes nomeados por serviço permitem down sem perda e down -v para reset', () => {
    expect(Object.keys(base.volumes ?? {})).toEqual(
      expect.arrayContaining(['pg-data', 'minio-data', 'authentik-data']),
    );
  });

  it('[RN-FND-15] sessão e cache/filas em dois serviços Redis distintos', () => {
    expect(base.services['redis-session']).toBeDefined();
    expect(base.services['redis-cache']).toBeDefined();
    expect(JSON.stringify(base.services['redis-cache']?.command)).toContain('noeviction');
  });

  it('[RN-FND-16] api/worker só sobem depois do bootstrap do MinIO concluir', () => {
    for (const name of ['api', 'worker', 'web']) {
      expect(full.services[name]?.depends_on?.['minio-bootstrap']?.condition, name).toBe(
        'service_completed_successfully',
      );
    }
    expect(base.services['minio-bootstrap']?.depends_on?.minio?.condition).toBe('service_healthy');
  });
});

describe('[RN-FND-14] PostgreSQL', () => {
  const initDir = 'infra/postgres/init';
  const files = readdirSync(path.join(REPO_ROOT, initDir)).sort();

  it('cria o banco authentik com papel próprio', () => {
    const script = read(`${initDir}/${files.find((file) => file.endsWith('.sh')) ?? ''}`);
    expect(script).toContain('CREATE DATABASE authentik OWNER authentik;');
    expect(script).not.toMatch(/CREATE EXTENSION/i);
  });

  it('habilita pgvector, pg_trgm, unaccent e citext só no banco contrataflow', () => {
    const sql = files
      .filter((file) => file.endsWith('.sql'))
      .map((file) => read(`${initDir}/${file}`))
      .join('\n');
    expect(sql).toMatch(/^\\connect contrataflow$/m);
    for (const extension of ['vector', 'pg_trgm', 'unaccent', 'citext']) {
      expect(sql).toContain(`CREATE EXTENSION IF NOT EXISTS ${extension};`);
    }
    expect(sql).not.toMatch(/\\connect authentik/);
  });
});

describe('[RN-FND-16] bootstrap do MinIO idempotente', () => {
  const script = read('infra/minio/minio-bootstrap.sh');

  it('cria os três buckets lógicos sem falhar se já existirem', () => {
    const buckets = [...script.matchAll(/mc mb (.*)$/gm)].map((match) => match[1] ?? '');
    expect(buckets).toHaveLength(3);
    for (const line of buckets) expect(line).toContain('--ignore-existing');
    expect(script).toMatch(/--with-lock "local\/\$S3_BUCKET_RENDITIONS"/);
  });

  it('substitui o lifecycle por inteiro (ilm import), sem acumular regras', () => {
    expect(script).not.toMatch(/mc ilm rule add/);
    expect([...script.matchAll(/^mc ilm import "local\//gm)]).toHaveLength(3);
  });

  it('a aplicação usa usuário próprio com política restrita, sem DeleteObject em documents/renditions', () => {
    expect(script).toContain(
      'mc admin policy attach local contrataflow-app --user "$S3_ACCESS_KEY_ID"',
    );
    const evidence = /"Sid": "Evidence"[\s\S]*?\]\s*\}/.exec(script)?.[0] ?? '';
    expect(evidence).not.toContain('s3:DeleteObject');
  });
});

describe('[RN-FND-17] blueprints do Authentik', () => {
  const oidc = read('infra/authentik/blueprints/10-contrataflow-oidc.yaml');
  const provider = (
    parse(oidc, { logLevel: 'silent' }) as {
      entries: { model: string; attrs: Record<string, unknown> }[];
    }
  ).entries.find((entry) => entry.model === 'authentik_providers_oauth2.oauth2provider');

  it('provider OIDC confidencial, só Authorization Code (+ refresh), sub = UUID do usuário', () => {
    expect(provider?.attrs).toMatchObject({
      client_type: 'confidential',
      grant_types: ['authorization_code', 'refresh_token'],
      sub_mode: 'user_uuid',
    });
  });

  it('client id/secret e URLs vêm do ambiente (!Env)', () => {
    expect(oidc).toMatch(/^\s+client_id: !Env CF_OIDC_CLIENT_ID$/m);
    expect(oidc).toMatch(/^\s+client_secret: !Env CF_OIDC_CLIENT_SECRET$/m);
    expect(oidc).toContain("!Format ['%s/api/auth/callback', !Env CF_APP_BASE_URL]");
  });

  it('o blueprint de usuários versionado está em dia com o dataset (pnpm env:blueprint)', () => {
    expect(read(USERS_BLUEPRINT_FILE)).toBe(renderUsersBlueprint());
  });

  it('um usuário por persona de cada tenant, todos com senha do ambiente', () => {
    const blueprint = read(USERS_BLUEPRINT_FILE);
    const usernames = [...blueprint.matchAll(/^\s+username: '([^']+)'$/gm)].map(
      (match) => match[1],
    );
    expect(usernames).toEqual(seedUsers().map((user) => user.username));
    expect([...blueprint.matchAll(/^\s+password: !Env CF_DEV_USER_PASSWORD$/gm)]).toHaveLength(
      usernames.length,
    );
  });
});

describe('[Permissão] nenhum segredo real versionado (RN-FND-19)', () => {
  const blueprintsDir = 'infra/authentik/blueprints';
  const blueprints = readdirSync(path.join(REPO_ROOT, blueprintsDir)).map((file) =>
    read(`${blueprintsDir}/${file}`),
  );

  it('blueprints não têm senha, segredo, token ou chave literais', () => {
    for (const text of blueprints) {
      for (const match of text.matchAll(
        /^\s*(password|client_secret|key|token|secret)\s*:\s*(.+)$/gm,
      )) {
        expect(match[2]?.trim(), match[0]).toMatch(/^!Env /);
      }
    }
  });

  it('.env.example só traz valores de desenvolvimento óbvios nos segredos', () => {
    const env = parseEnvFile(read(ENV_EXAMPLE_FILE));
    const secrets = REQUIRED_VARS.map(({ name }) => name).filter((name) =>
      /PASSWORD|SECRET|TOKEN|KEY/.test(name),
    );
    expect(secrets.length).toBeGreaterThan(5);
    for (const name of secrets) {
      if (name === 'S3_ACCESS_KEY_ID') continue;
      expect(env[name], name).toMatch(/^dev/);
    }
  });

  it('o .env local nunca é versionado nem entra na imagem', () => {
    expect(read('.gitignore')).toMatch(/^\.env$/m);
    expect(read('.dockerignore')).toMatch(/^\.env$/m);
  });
});
