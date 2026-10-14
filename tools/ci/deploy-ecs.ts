// tsx tools/ci/deploy-ecs.ts --digests <dir> --cluster <nome> --service-prefix <prefixo>
//   [--migrator <família da task de migração>] [--network <awsvpcConfiguration JSON>]
// Deploy das imagens assinadas (por digest, sem rebuild) no ECS. Usa a AWS CLI do runner com as
// credenciais de curta duração do OIDC (security.md §19); nada de chave estática.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { run } from '../lib/process.js';
import { REPO_ROOT } from '../lib/workspace.js';
import { createReporter } from './lib/annotations.js';
import { parseDigests, ROLLOUT, withImage } from './lib/ecs.js';

const { values } = parseArgs({
  options: {
    digests: { type: 'string' },
    cluster: { type: 'string' },
    'service-prefix': { type: 'string' },
    migrator: { type: 'string' },
    network: { type: 'string' },
  },
});
const reporter = createReporter();
const cluster = values.cluster ?? '';
const prefix = values['service-prefix'] ?? '';
if (!values.digests || !cluster || !prefix) {
  reporter.annotate('error', 'deploy-ecs exige --digests, --cluster e --service-prefix.');
  process.exit(1);
}

function aws(args: readonly string[]): unknown {
  const result = run('aws', [...args, '--output', 'json'], { cwd: REPO_ROOT, timeoutMs: 900_000 });
  if (result.status !== 0) throw new Error(`aws ${args.slice(0, 2).join(' ')}: ${result.stderr}`);
  return result.stdout.trim() === '' ? {} : JSON.parse(result.stdout);
}

/** Registra a revisão nova da família com a imagem do app e devolve o ARN. */
function register(family: string, container: string, image: string): string {
  const current = aws(['ecs', 'describe-task-definition', '--task-definition', family]) as {
    taskDefinition: Parameters<typeof withImage>[0];
  };
  const next = withImage(current.taskDefinition, container, image);
  const registered = aws([
    'ecs',
    'register-task-definition',
    '--cli-input-json',
    JSON.stringify(next),
  ]) as { taskDefinition: { taskDefinitionArn: string } };
  return registered.taskDefinition.taskDefinitionArn;
}

const dir = values.digests;
const digests = parseDigests(
  Object.fromEntries(
    readdirSync(dir, { recursive: true })
      .map(String)
      .filter((file) => /digest-[a-z]+\.txt$/.test(file))
      .map((file) => [file, readFileSync(path.join(dir, file), 'utf8')]),
  ),
);

// 1. Migração (*expand*) antes do rollout; falha aborta o deploy (architecture.md §11.4).
if (values.migrator && digests.api) {
  const arn = register(values.migrator, 'migrator', digests.api);
  const started = aws([
    'ecs',
    'run-task',
    '--cluster',
    cluster,
    '--task-definition',
    arn,
    '--launch-type',
    'FARGATE',
    '--network-configuration',
    values.network ?? '{}',
  ]) as { tasks: { taskArn: string }[] };
  const taskArn = started.tasks[0]?.taskArn ?? '';
  aws(['ecs', 'wait', 'tasks-stopped', '--cluster', cluster, '--tasks', taskArn]);
  const stopped = aws(['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', taskArn]) as {
    tasks: { containers: { exitCode?: number }[] }[];
  };
  const exitCode = stopped.tasks[0]?.containers[0]?.exitCode;
  if (exitCode !== 0) {
    reporter.annotate('error', `Migração falhou (código ${String(exitCode)}): deploy abortado.`);
    process.exit(1);
  }
  reporter.log('info', 'ci.deploy', 'migração aplicada');
}

// 2. api e worker, depois web — cada grupo só segue quando o anterior estabiliza.
for (const group of ROLLOUT) {
  const services: string[] = [];
  for (const app of group) {
    const image = digests[app];
    if (!image) throw new Error(`sem digest da imagem de ${app}`);
    const service = `${prefix}-${app}`;
    const arn = register(service, app, image);
    aws([
      'ecs',
      'update-service',
      '--cluster',
      cluster,
      '--service',
      service,
      '--task-definition',
      arn,
    ]);
    services.push(service);
  }
  aws(['ecs', 'wait', 'services-stable', '--cluster', cluster, '--services', ...services]);
  reporter.log('info', 'ci.deploy', `${services.join(', ')} estáveis`);
}
