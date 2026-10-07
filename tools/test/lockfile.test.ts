import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { run } from '../lib/process.js';
import { REPO_ROOT } from '../lib/workspace.js';

/** Mesmo pnpm do repositório (campo packageManager), para o Corepack não escolher outro. */
const PACKAGE_MANAGER = (
  JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    packageManager: string;
  }
).packageManager;

let sandbox: string;

function writeJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** Projeto mínimo com dependências locais (sem rede) — imita a main com o lockfile do PR "A". */
function createProject(name: string, dependencies: Record<string, string>): string {
  const dir = path.join(sandbox, name);
  for (const lib of ['lib-a', 'lib-b']) {
    writeJson(path.join(dir, lib, 'package.json'), { name: lib, version: '1.0.0' });
  }
  writeJson(path.join(dir, 'package.json'), {
    name,
    version: '0.0.0',
    private: true,
    packageManager: PACKAGE_MANAGER,
    dependencies,
  });
  return dir;
}

function pnpm(cwd: string, ...args: string[]) {
  return run('pnpm', [...args, '--store-dir', path.join(sandbox, 'store')], { cwd });
}

describe('lockfile versionado (RN-FND-01)', () => {
  beforeAll(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'cf-lockfile-'));
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('[Concorrência] PR "B" sem rebase falha com ERR_PNPM_OUTDATED_LOCKFILE', () => {
    const project = createProject('pr-b', { 'lib-a': 'file:./lib-a' });
    expect(pnpm(project, 'install', '--lockfile-only').status).toBe(0);

    // O PR "B" acrescenta uma dependência sem regenerar o lockfile da main.
    const manifest = path.join(project, 'package.json');
    const data = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
    writeJson(manifest, {
      ...data,
      dependencies: { 'lib-a': 'file:./lib-a', 'lib-b': 'file:./lib-b' },
    });

    const frozen = pnpm(project, 'install', '--frozen-lockfile', '--offline');
    expect(frozen.status).not.toBe(0);
    expect(frozen.output).toContain('ERR_PNPM_OUTDATED_LOCKFILE');
  });

  it('[Concorrência] após o rebase, pnpm install regenera o lockfile de forma determinística', () => {
    const dependencies = { 'lib-a': 'file:./lib-a', 'lib-b': 'file:./lib-b' };
    const first = createProject('rebase-1', dependencies);
    const second = createProject('rebase-2', dependencies);
    expect(pnpm(first, 'install', '--lockfile-only').status).toBe(0);
    expect(pnpm(second, 'install', '--lockfile-only').status).toBe(0);

    const lockfile = (dir: string) => readFileSync(path.join(dir, 'pnpm-lock.yaml'), 'utf8');
    expect(lockfile(first)).toBe(lockfile(second));
    expect(pnpm(first, 'install', '--frozen-lockfile', '--offline').status).toBe(0);
  });

  it('[Falha de integração] sem registry e sem store aquecido falha com erro explícito de rede', () => {
    const project = createProject('offline', { 'is-number': '7.0.0' });
    const result = pnpm(project, 'install', '--offline');

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/ERR_PNPM_NO_OFFLINE_(META|TARBALL)/);
    expect(existsSync(path.join(project, 'node_modules', 'is-number'))).toBe(false);
  });
});
