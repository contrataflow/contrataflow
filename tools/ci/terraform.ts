// tsx tools/ci/terraform.ts check
// tsx tools/ci/terraform.ts plan --env <staging|production> [--detailed-exitcode]
// tsx tools/ci/terraform.ts apply --env <staging|production>
//
// IaC (spec-469 · architecture.md §11.3) pelas imagens oficiais fixadas em ci/lib/terraform.ts —
// basta o Docker, na estação e no CI.
// - check: `terraform fmt -check`, `validate` em todas as raízes, `tflint` e `trivy config`
//   com as checagens próprias de infra/terraform/policies (achado alto ou crítico reprova). Não
//   toca a AWS.
// - plan/apply: raiz do ambiente com o estado em TF_STATE_BUCKET e as credenciais de curta duração
//   do OIDC (AWS_*); TF_VARS_JSON opcional. Só o pipeline aplica (terraform.yml).
import path from 'node:path';
import { parseArgs } from 'node:util';

import { run } from '../lib/process.js';
import { REPO_ROOT } from '../lib/workspace.js';
import { createReporter } from './lib/annotations.js';
import {
  dockerArgs,
  IAC_IMAGES,
  IAC_VOLUMES,
  isEnvironment,
  parseTfVars,
  planScript,
  planSummary,
  TERRAFORM_DIR,
  validateScript,
} from './lib/terraform.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    env: { type: 'string' },
    'detailed-exitcode': { type: 'boolean', default: false },
  },
});
const reporter = createReporter();
const command = positionals[0] ?? 'check';
const source = `${path.join(REPO_ROOT, TERRAFORM_DIR)}:/src:ro`;
const AWS_ENV = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION'];

function docker(label: string, args: readonly string[]): { ok: boolean; output: string } {
  const result = run('docker', args, { cwd: REPO_ROOT, timeoutMs: 1_800_000 });
  const output = `${result.stdout}${result.stderr}`.trimEnd();
  if (output) console.log(output);
  const ok = result.status === 0;
  reporter.log(ok ? 'info' : 'error', 'ci.terraform', `${label}: ${ok ? 'ok' : 'falhou'}`);
  return { ok, output };
}

function check(): boolean {
  const checks = [
    docker(
      'terraform fmt -check',
      dockerArgs({
        image: IAC_IMAGES.terraform,
        mounts: [source],
        workdir: '/src',
        args: ['fmt', '-check', '-recursive', '-diff', '-no-color'],
      }),
    ),
    docker(
      'terraform validate',
      dockerArgs({
        image: IAC_IMAGES.terraform,
        mounts: [source, `${IAC_VOLUMES.terraform}:/plugins`],
        env: ['TF_PLUGIN_CACHE_DIR=/plugins', 'TF_IN_AUTOMATION=1'],
        entrypoint: 'sh',
        args: ['-c', validateScript()],
      }),
    ),
    docker(
      'tflint',
      dockerArgs({
        image: IAC_IMAGES.tflint,
        mounts: [source, `${IAC_VOLUMES.tflint}:/root/.tflint.d/plugins`],
        // Sem token, o download do ruleset da AWS cai no limite anônimo da API do GitHub.
        env: process.env.GITHUB_TOKEN ? ['GITHUB_TOKEN'] : [],
        workdir: '/src',
        entrypoint: 'sh',
        args: [
          '-c',
          'tflint --init --config /src/.tflint.hcl > /dev/null && tflint --recursive --config /src/.tflint.hcl --format compact',
        ],
      }),
    ),
    docker(
      'trivy config',
      dockerArgs({
        image: IAC_IMAGES.trivy,
        mounts: [source, `${IAC_VOLUMES.trivy}:/root/.cache/trivy`],
        // policies/: checagens próprias (CF-*) além das nativas — ex.: porta de dados pública.
        args: [
          'config',
          '--config-check',
          '/src/policies',
          '--check-namespaces',
          'user',
          '--severity',
          'HIGH,CRITICAL',
          '--exit-code',
          '1',
          '--quiet',
          '/src',
        ],
      }),
    ),
  ];
  return checks.every((item) => item.ok);
}

function planOrApply(apply: boolean): boolean {
  const environment = values.env;
  if (!isEnvironment(environment)) {
    reporter.annotate('error', `${command} exige --env staging|production.`);
    return false;
  }
  if (!process.env.TF_STATE_BUCKET) {
    reporter.annotate(
      'error',
      `TF_STATE_BUCKET ausente: veja o roteiro de bootstrap no CONTRIBUTING.md.`,
    );
    return false;
  }
  parseTfVars(process.env.TF_VARS_JSON);
  const result = docker(
    `terraform ${command} (${environment})`,
    dockerArgs({
      image: IAC_IMAGES.terraform,
      mounts: [source, `${IAC_VOLUMES.terraform}:/plugins`],
      env: [
        'TF_PLUGIN_CACHE_DIR=/plugins',
        'TF_IN_AUTOMATION=1',
        'TF_STATE_BUCKET',
        'TF_VARS_JSON',
        ...AWS_ENV,
      ],
      entrypoint: 'sh',
      args: [
        '-c',
        planScript({ environment, apply, detailedExitCode: values['detailed-exitcode'] }),
      ],
    }),
  );
  reporter.summary(planSummary(environment, result.output));
  if (!result.ok && values['detailed-exitcode'] && result.output.includes('\nPlan: ')) {
    reporter.annotate('error', `Drift em ${environment}: o plano agendado encontrou mudanças.`, {
      title: 'Terraform',
    });
  }
  return result.ok;
}

let ok: boolean;
if (command === 'check') ok = check();
else if (command === 'plan' || command === 'apply') ok = planOrApply(command === 'apply');
else {
  reporter.annotate('error', `Comando desconhecido: ${command} (use check, plan ou apply).`);
  ok = false;
}
process.exit(ok ? 0 : 1);
