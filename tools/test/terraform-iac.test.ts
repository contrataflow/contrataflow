// spec-469 — infraestrutura AWS com Terraform (architecture.md §11.3): invariantes do código em
// infra/terraform e da ligação com o pipeline (ci.yml, terraform.yml, deploy-staging.yml e
// tools/ci/deploy-ecs.ts). `terraform fmt/validate`, `tflint` e `trivy config` rodam de verdade
// em `pnpm ci:terraform check` (estágio "2. Estático"), que precisa de Docker.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  accountIdsIn,
  dockerArgs,
  IAC_IMAGES,
  isEnvironment,
  parseTfVars,
  planScript,
  planSummary,
  TERRAFORM_DIR,
  TERRAFORM_ROOTS,
  validateScript,
} from '../ci/lib/terraform.js';
import { REPO_ROOT } from '../lib/workspace.js';

interface Job {
  readonly name?: string;
  readonly needs?: string | string[];
  readonly if?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly environment?: string;
  readonly steps?: { name?: string; run?: string; env?: Record<string, string> }[];
}

const TF = path.join(REPO_ROOT, TERRAFORM_DIR);
const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const workflow = (file: string) =>
  parse(read(`.github/workflows/${file}`)) as {
    on: Record<string, unknown>;
    env?: Record<string, string>;
    jobs: Record<string, Job>;
  };

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (entry === '.terraform') return [];
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

const tfFiles = filesUnder(TF).filter((file) => /\.(tf|tfvars|example|hcl)$/.test(file));
const tfText = (relative: string) => readFileSync(path.join(TF, relative), 'utf8');

/** Chaves `NOME =` de um bloco `output "<nome>"` (mapa literal, um nível). */
function outputKeys(text: string, output: string): string[] {
  const start = text.indexOf(`output "${output}"`);
  if (start < 0) return [];
  const end = text.indexOf('\n}', start);
  return [...text.slice(start, end).matchAll(/^\s+([A-Z][A-Z0-9_]+)\s+=/gm)].map((m) => m[1] ?? '');
}

const MODULES = [
  'network',
  'ecs-service',
  'rds-postgres',
  'elasticache',
  's3-bucket',
  'kms',
  'waf',
  'ses',
  'observability',
];

const GITHUB_VARIABLES = [
  'AWS_OIDC_ROLE_ARN',
  'AWS_REGION',
  'ECR_REGISTRY',
  'ECS_CLUSTER',
  'ECS_SERVICE_PREFIX',
  'ECS_MIGRATOR_FAMILY',
  'ECS_MIGRATOR_NETWORK',
  'STAGING_URL',
  'STAGING_API_URL',
  'TRACES_QUERY_URL',
];

describe('Infraestrutura AWS com Terraform (spec-469)', () => {
  describe('estrutura de infra/terraform', () => {
    it('tem os módulos do architecture.md §11.3 e as raízes staging, production e bootstrap', () => {
      for (const name of MODULES) {
        for (const file of ['main.tf', 'variables.tf', 'outputs.tf', 'versions.tf']) {
          expect(existsSync(path.join(TF, 'modules', name, file)), `${name}/${file}`).toBe(true);
        }
      }
      expect([...TERRAFORM_ROOTS].sort()).toEqual(['bootstrap', 'envs/production', 'envs/staging']);
      // dev continua no Compose da US-078.
      expect(existsSync(path.join(TF, 'envs/dev'))).toBe(false);
    });

    it('cada raiz versiona o lock file dos provedores e fixa o estado remoto com lock nativo do S3', () => {
      for (const root of TERRAFORM_ROOTS) {
        expect(existsSync(path.join(TF, root, '.terraform.lock.hcl')), root).toBe(true);
      }
      for (const environment of ['staging', 'production']) {
        const main = tfText(`envs/${environment}/main.tf`);
        expect(main).toContain('backend "s3"');
        expect(main).toContain('use_lockfile = true');
        expect(main).toContain(`key          = "envs/${environment}/terraform.tfstate"`);
        expect(main).toContain('region = "sa-east-1"');
      }
    });
  });

  describe('nenhum segredo nem id de conta no código', () => {
    it('não há id de conta AWS (12 dígitos) em nenhum arquivo de infra/terraform', () => {
      for (const file of tfFiles) {
        expect(accountIdsIn(readFileSync(file, 'utf8')), path.relative(TF, file)).toEqual([]);
      }
    });

    it('não há credencial nem senha literal (segredos vêm do Secrets Manager)', () => {
      for (const file of tfFiles) {
        const text = readFileSync(file, 'utf8');
        expect(text, path.relative(TF, file)).not.toMatch(
          /\b(access_key|secret_key|password|auth_token|token)\s*=\s*"/,
        );
      }
    });

    it('o RDS gera a senha mestra no Secrets Manager e o estado fica num bucket cifrado com CMK', () => {
      const rds = tfText('modules/rds-postgres/main.tf');
      expect(rds).toContain('manage_master_user_password   = true');
      expect(rds).toContain('storage_encrypted     = true');
      expect(rds).toContain('publicly_accessible    = false');
      expect(rds).toMatch(/name\s+= "rds\.force_ssl"\s+value = "1"/);
      const bucket = tfText('modules/s3-bucket/main.tf');
      for (const flag of [
        'block_public_acls',
        'block_public_policy',
        'ignore_public_acls',
        'restrict_public_buckets',
      ]) {
        expect(bucket).toMatch(new RegExp(`${flag}\\s+= true`));
      }
      expect(tfText('bootstrap/main.tf')).toContain('source = "../modules/s3-bucket"');
    });

    it('exceções do Trivy só para a borda pública e a saída HTTPS, cada uma justificada', () => {
      const ignores = tfFiles.flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(/trivy:ignore:(\S+)/g)].map((m) => m[1]),
      );
      expect([...new Set(ignores)].sort()).toEqual([
        'AVD-AWS-0031',
        'AVD-AWS-0053',
        'AVD-AWS-0104',
        'AVD-AWS-0107',
      ]);
      const policy = tfText('policies/public_data_port.rego');
      expect(policy).toContain('severity: CRITICAL');
      expect(policy).toContain('web_ports := {80, 443}');
    });
  });

  describe('contrato com o pipeline de deploy', () => {
    const staging = outputKeys(tfText('envs/staging/outputs.tf'), 'github_environment_variables');
    const production = outputKeys(
      tfText('envs/production/outputs.tf'),
      'github_environment_variables',
    );
    const common = outputKeys(tfText('modules/stack/outputs.tf'), 'deploy_variables');

    it('os outputs têm os nomes exatos das variáveis dos ambientes do GitHub', () => {
      expect([...common, ...staging].sort()).toEqual([...GITHUB_VARIABLES].sort());
      expect(production).toEqual(['PRODUCTION_URL']);
      const contributing = read('CONTRIBUTING.md');
      for (const name of GITHUB_VARIABLES) expect(contributing).toContain(`\`${name}\``);
    });

    it('toda variável lida pelos workflows de imagem e deploy sai do Terraform (ou do bootstrap)', () => {
      const used = new Set(
        ['deploy-staging.yml', 'images.yml'].flatMap((file) =>
          [...read(`.github/workflows/${file}`).matchAll(/vars\.([A-Z_]+)/g)].map((m) => m[1]),
        ),
      );
      used.delete('CF_STAGING_ENABLED'); // liga o pós-merge — decisão humana, não output
      const produced = new Set([...common, ...staging, ...production]);
      expect([...used].filter((name) => name !== undefined && !produced.has(name))).toEqual([]);
    });

    it('serviço, família e contêiner seguem o contrato de tools/ci/deploy-ecs.ts', () => {
      const ecs = tfText('modules/ecs-service/main.tf');
      expect(ecs).toContain('family                   = var.name');
      expect(ecs).toMatch(/name\s+= var\.name\n\s+cluster/);
      const stack = tfText('modules/stack/main.tf');
      for (const app of ['api', 'web', 'worker']) {
        expect(stack).toContain(
          `name                          = "\${local.service_prefix}-${app}"`,
        );
        expect(stack).toContain(`container_name                = "${app}"`);
      }
      expect(stack).toContain('container_name      = "migrator"');
      expect(tfText('modules/stack/outputs.tf')).toContain(
        'ECS_MIGRATOR_NETWORK = local.migrator_network',
      );
      expect(stack).toMatch(/awsvpcConfiguration = \{ subnets = .*assignPublicIp = "DISABLED"/);
      // O pipeline troca a revisão; o Terraform não a desfaz.
      expect(ecs).toContain('ignore_changes = [task_definition, desired_count]');
    });

    it('os repositórios ECR têm os nomes que images.yml publica', () => {
      expect(read('.github/workflows/images.yml')).toContain('/contrataflow-$APP:$GITHUB_SHA');
      expect(tfText('modules/ecr/main.tf')).toContain(
        'name                 = "contrataflow-${each.key}"',
      );
    });

    it('o papel de deploy é restrito ao repositório e ao ambiente do GitHub', () => {
      const bootstrap = tfText('bootstrap/main.tf');
      expect(bootstrap).toContain('values   = ["${local.subject}:environment:${var.environment}"]');
      expect(tfText('bootstrap/variables.tf')).toContain(
        'default     = "contrataflow/contrataflow"',
      );
      expect(tfText('bootstrap/variables.tf')).toMatch(
        /variable "plan_on_pull_request"[\s\S]*?default\s+= false/,
      );
    });
  });

  describe('workflows', () => {
    it('o estágio "2. Estático" roda fmt, validate, tflint e trivy config em todo PR', () => {
      const ci = workflow('ci.yml');
      const commands = (ci.jobs.static?.steps ?? []).map((step) => step.run ?? '').join('\n');
      expect(commands).toContain('pnpm ci:terraform check');
    });

    it('PR só planeja staging; apply só pelo pipeline, produção depois de staging e com aprovação', () => {
      const terraform = workflow('terraform.yml');
      expect(Object.keys(terraform.on).sort()).toEqual(
        ['pull_request', 'push', 'schedule', 'workflow_dispatch'].sort(),
      );
      const { jobs } = terraform;
      // Gate estático também no push direto (DEC-190) e antes de qualquer plan/apply.
      expect(jobs.check?.steps?.map((step) => step.run ?? '').join()).toContain(
        'pnpm ci:terraform check',
      );
      expect(jobs['plan-staging']?.needs).toBe('check');
      expect(jobs['plan-production']?.needs).toBe('check');
      expect(jobs['plan-production']?.if).toContain("github.event_name != 'pull_request'");
      expect(jobs['apply-staging']?.with).toMatchObject({ environment: 'staging', apply: true });
      expect(jobs['apply-staging']?.if).not.toContain('pull_request');
      expect(jobs['apply-production']?.needs).toEqual(['apply-staging', 'plan-production']);
      expect(jobs['apply-production']?.with).toMatchObject({
        environment: 'production',
        apply: true,
      });
      const env = workflow('terraform-env.yml');
      // Apply roda no ambiente do GitHub (branch protegida; produção exige o Tech Lead).
      expect(env.jobs.terraform?.environment).toBe(
        "${{ inputs.apply && inputs.environment || '' }}",
      );
      const settings = JSON.parse(read('.github/repository-settings.json')) as {
        environments: { name: string; reviewers: string[] }[];
      };
      expect(settings.environments.find((item) => item.name === 'production')?.reviewers).toContain(
        'tech-lead',
      );
    });

    it('a mesma imagem do Trivy no estágio de imagens e na varredura de IaC', () => {
      expect(workflow('images.yml').env?.TRIVY_IMAGE).toBe(IAC_IMAGES.trivy);
    });
  });

  describe('tools/ci/lib/terraform.ts', () => {
    it('toda imagem de ferramenta é fixada por digest', () => {
      for (const image of Object.values(IAC_IMAGES)) {
        expect(image).toMatch(/^[\w./-]+:[\w.-]+@sha256:[a-f0-9]{64}$/);
      }
    });

    it('monta o docker run com montagens, variáveis pelo nome e entrypoint', () => {
      expect(
        dockerArgs({
          image: 'img@sha256:x',
          mounts: ['/a:/src:ro'],
          env: ['TOKEN', 'X=1'],
          workdir: '/src',
          entrypoint: 'sh',
          args: ['-c', 'true'],
        }),
      ).toEqual([
        'run',
        '--rm',
        '-v',
        '/a:/src:ro',
        '-e',
        'TOKEN',
        '-e',
        'X=1',
        '-w',
        '/src',
        '--entrypoint',
        'sh',
        'img@sha256:x',
        '-c',
        'true',
      ]);
      expect(dockerArgs({ image: 'i', mounts: [], args: ['version'] })).toEqual([
        'run',
        '--rm',
        'i',
        'version',
      ]);
    });

    it('validate inicializa cada raiz sem backend e com o lock file somente leitura', () => {
      const script = validateScript();
      for (const root of TERRAFORM_ROOTS) {
        expect(script).toContain(
          `terraform -chdir=/work/${root} init -backend=false -input=false -lockfile=readonly`,
        );
        expect(script).toContain(`terraform -chdir=/work/${root} validate -no-color`);
      }
      expect(script.startsWith('set -e && cp -r /src/. /work')).toBe(true);
      // Sem `%` nem aspas duplas: a linha passa pelo cmd.exe no Windows.
      expect(script).not.toMatch(/[%"]/);
    });

    it('plan não trava o estado; apply aplica o plano salvo; drift usa -detailed-exitcode', () => {
      const plan = planScript({ environment: 'staging', apply: false });
      expect(plan).toContain('-backend-config=bucket=$TF_STATE_BUCKET');
      expect(plan).toContain('plan -input=false -no-color -lock=false');
      expect(plan).not.toContain(' apply ');
      expect(plan).toContain('/work/envs/staging/ci.auto.tfvars.json');
      expect(
        planScript({ environment: 'production', apply: false, detailedExitCode: true }),
      ).toContain('-lock=false -detailed-exitcode');
      const apply = planScript({ environment: 'production', apply: true });
      expect(apply).toContain(
        'terraform -chdir=/work/envs/production plan -input=false -no-color -out=tfplan',
      );
      expect(apply).toContain(
        'terraform -chdir=/work/envs/production apply -input=false -no-color tfplan',
      );
      expect(apply).not.toMatch(/[%"]/);
      expect(plan).not.toMatch(/[%"]/);
    });

    it('TF_VARS_<ENV> precisa ser um objeto JSON', () => {
      expect(parseTfVars(undefined)).toEqual({});
      expect(parseTfVars('  ')).toEqual({});
      expect(parseTfVars('{"ecr_registry":"r"}')).toEqual({ ecr_registry: 'r' });
      expect(() => parseTfVars('[1]')).toThrow(/objeto JSON/);
      expect(() => parseTfVars('null')).toThrow(/objeto JSON/);
      expect(() => parseTfVars('{')).toThrow();
    });

    it('acha id de conta solto, mas não números maiores, versões ou trechos de ARN de exemplo', () => {
      expect(accountIdsIn('arn:aws:iam::123456789012:root')).toEqual(['123456789012']);
      expect(accountIdsIn('conta 210987654321.')).toEqual(['210987654321']);
      expect(accountIdsIn('1234567890123 v1.123456789012 abc123456789012')).toEqual([]);
      expect(accountIdsIn('10 * 1024 * 1024 * 1024')).toEqual([]);
    });

    it('ambiente válido e resumo do plano truncado', () => {
      expect(isEnvironment('staging')).toBe(true);
      expect(isEnvironment('production')).toBe(true);
      expect(isEnvironment('dev')).toBe(false);
      expect(isEnvironment(undefined)).toBe(false);
      const summary = planSummary('staging', 'x'.repeat(20), 10);
      expect(summary).toContain('### terraform plan — staging');
      expect(summary).toContain(`${'x'.repeat(10)}\n… (truncado)`);
      expect(planSummary('production', 'No changes.\n')).toContain('```\nNo changes.\n```');
    });
  });
});
