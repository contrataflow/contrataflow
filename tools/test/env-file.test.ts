// US-078 — validações do `.env` antes do Docker (V-01, V-02; Gherkin "[Validação]").
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ENV_EXAMPLE_FILE,
  loadEnv,
  parseEnvFile,
  parseProfiles,
  portOf,
  REQUIRED_VARS,
  validateEnv,
} from '../env/lib/env-file.js';
import type { EnvError } from '../env/lib/log.js';
import { REPO_ROOT } from '../lib/workspace.js';

const example = () => readFileSync(path.join(REPO_ROOT, ENV_EXAMPLE_FILE), 'utf8');

describe('parseEnvFile', () => {
  it('lê chaves, ignora comentários e linhas vazias e remove aspas', () => {
    expect(
      parseEnvFile(
        [
          '# comentário',
          '',
          'A=1',
          'export B = dois ',
          'C="com # cerquilha"',
          "D='simples'",
          'E=valor # comentário no fim',
          'F=',
          'linha inválida',
        ].join('\n'),
      ),
    ).toEqual({ A: '1', B: 'dois', C: 'com # cerquilha', D: 'simples', E: 'valor', F: '' });
  });

  it('aceita CRLF', () => {
    expect(parseEnvFile('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });
});

describe('[Sucesso] .env.example funciona sem edição', () => {
  it('passa em todas as validações', () => {
    expect(validateEnv(parseEnvFile(example()))).toEqual([]);
  });

  it('declara todas as variáveis obrigatórias', () => {
    const env = parseEnvFile(example());
    for (const { name } of REQUIRED_VARS) expect(env[name], name).toBeTruthy();
  });
});

describe('[Validação] variável obrigatória ausente', () => {
  it('MINIO_ROOT_PASSWORD removida → "Defina MINIO_ROOT_PASSWORD no .env."', () => {
    const env = parseEnvFile(example().replace(/^MINIO_ROOT_PASSWORD=.*$/m, ''));
    expect(validateEnv(env)).toEqual([
      {
        code: 'ENV_VAR_MISSING',
        variable: 'MINIO_ROOT_PASSWORD',
        message: 'Defina MINIO_ROOT_PASSWORD no .env.',
      },
    ]);
  });

  it('valor só com espaços conta como ausente', () => {
    const issues = validateEnv({ ...parseEnvFile(example()), POSTGRES_PASSWORD: '   ' });
    expect(issues.map((issue) => issue.code)).toEqual(['ENV_VAR_MISSING']);
  });

  it('aplica os tamanhos mínimos da tabela "Campos"', () => {
    const env = {
      ...parseEnvFile(example()),
      POSTGRES_PASSWORD: 'curta',
      AUTHENTIK_SECRET_KEY: 'x',
    };
    expect(validateEnv(env).map((issue) => issue.message)).toEqual([
      'POSTGRES_PASSWORD deve ter ao menos 8 caracteres.',
      'AUTHENTIK_SECRET_KEY deve ter ao menos 32 caracteres.',
    ]);
  });

  it.each(['0', '65536', 'abc', '54.3'])('rejeita porta %s', (port) => {
    const issues = validateEnv({ ...parseEnvFile(example()), POSTGRES_PORT: port });
    expect(issues).toEqual([
      {
        code: 'ENV_VAR_INVALID',
        variable: 'POSTGRES_PORT',
        message: 'POSTGRES_PORT deve ser uma porta entre 1 e 65535.',
      },
    ]);
  });

  it('COMPOSE_PROFILES aceita só observability e full', () => {
    const env = parseEnvFile(example());
    expect(validateEnv({ ...env, COMPOSE_PROFILES: 'observability,full' })).toEqual([]);
    expect(validateEnv({ ...env, COMPOSE_PROFILES: 'debug' })[0]?.variable).toBe(
      'COMPOSE_PROFILES',
    );
  });

  it('valida nomes de bucket e APP_BASE_URL', () => {
    const env = parseEnvFile(example());
    const issues = validateEnv({
      ...env,
      S3_BUCKET_DOCUMENTS: 'Bucket_Invalido',
      APP_BASE_URL: 'localhost:3000/',
    });
    expect(issues.map((issue) => issue.variable)).toEqual(['S3_BUCKET_DOCUMENTS', 'APP_BASE_URL']);
  });

  it('as mensagens nunca contêm valores', () => {
    const secret = 'valor-que-nao-pode-vazar';
    const issues = validateEnv({ POSTGRES_PASSWORD: secret.slice(0, 4), POSTGRES_PORT: secret });
    expect(JSON.stringify(issues)).not.toContain(secret.slice(0, 4));
    expect(JSON.stringify(issues)).not.toContain(secret);
  });
});

describe('loadEnv', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('[V-01] .env ausente → ENV_FILE_MISSING com a instrução de cópia', () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'cf-env-'));
    dir = empty;
    expect(() => loadEnv(empty)).toThrow(
      expect.objectContaining({
        code: 'ENV_FILE_MISSING',
        message: 'Arquivo .env não encontrado. Rode: cp .env.example .env',
      }) as EnvError,
    );
  });

  it('variáveis do shell sobrepõem as do arquivo, como no Docker Compose', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cf-env-'));
    writeFileSync(path.join(dir, '.env'), 'POSTGRES_PORT=5432\nMINIO_PORT=9000\n');
    expect(loadEnv(dir, { POSTGRES_PORT: '55432', OUTRA: 'x' })).toEqual({
      POSTGRES_PORT: '55432',
      MINIO_PORT: '9000',
    });
  });
});

describe('utilitários', () => {
  it('portOf usa o padrão quando a variável está ausente', () => {
    expect(portOf({}, 'POSTGRES_PORT')).toBe(5432);
    expect(portOf({ POSTGRES_PORT: '55432' }, 'POSTGRES_PORT')).toBe(55432);
    expect(portOf({}, 'DESCONHECIDA')).toBe(0);
  });

  it('parseProfiles separa por vírgula e ignora vazios', () => {
    expect(parseProfiles(' observability, ,full ')).toEqual(['observability', 'full']);
    expect(parseProfiles('')).toEqual([]);
  });
});
