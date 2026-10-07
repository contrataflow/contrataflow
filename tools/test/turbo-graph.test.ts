import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

import { isolatedEnv } from '../lib/process.js';
import { REPO_ROOT } from '../lib/workspace.js';

interface DryRunTask {
  readonly taskId: string;
  readonly hash: string;
  readonly dependencies: readonly string[];
}

const require = createRequire(import.meta.url);
const TURBO = require.resolve('turbo/bin/turbo');
const execFileAsync = promisify(execFile);

const PACKAGES = ['types', 'validation', 'editor', 'ui'] as const;
const APPS = ['api', 'worker', 'web'] as const;

const build = (name: string) => `@contrataflow/${name}#build`;

/** `turbo run build --dry=json`: grafo e hashes de entrada, sem executar nada. */
async function dryRunBuild(): Promise<DryRunTask[]> {
  const { stdout } = await execFileAsync(process.execPath, [TURBO, 'run', 'build', '--dry=json'], {
    cwd: REPO_ROOT,
    env: isolatedEnv({ TURBO_TELEMETRY_DISABLED: '1' }),
    maxBuffer: 64 * 1024 * 1024,
  });
  return (JSON.parse(stdout.slice(stdout.indexOf('{'))) as { tasks: DryRunTask[] }).tasks;
}

describe('[Sucesso] ordem de build do Turborepo', () => {
  let graph: Map<string, readonly string[]>;

  beforeAll(async () => {
    graph = new Map((await dryRunBuild()).map((task) => [task.taskId, task.dependencies]));
  });

  it('constrói types → validation → editor e ui depois de types', () => {
    expect(graph.get(build('validation'))).toContain(build('types'));
    expect(graph.get(build('editor'))).toEqual(
      expect.arrayContaining([build('types'), build('validation')]),
    );
    expect(graph.get(build('ui'))).toContain(build('types'));
  });

  it.each(APPS)('constrói os pacotes compartilhados antes de apps/%s', (app) => {
    const expected = PACKAGES.filter((name) => app === 'web' || name !== 'ui').map(build);
    expect(graph.get(build(app))).toEqual(expect.arrayContaining(expected));
  });

  it('nenhum pacote compartilhado depende de um app', () => {
    for (const name of PACKAGES) {
      for (const app of APPS) expect(graph.get(build(name))).not.toContain(build(app));
    }
  });
});

describe('[Concorrência] cache do Turborepo', () => {
  it('duas execuções paralelas calculam os mesmos hashes de build', async () => {
    const [first, second] = await Promise.all([dryRunBuild(), dryRunBuild()]);
    const hashes = (tasks: DryRunTask[]) =>
      Object.fromEntries(tasks.map((task) => [task.taskId, task.hash]));
    expect(hashes(first)).toEqual(hashes(second));
  });
});
