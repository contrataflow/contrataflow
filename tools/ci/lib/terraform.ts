// IaC em infra/terraform (spec-469 · architecture.md §11.3): imagens oficiais fixadas por digest
// (único lugar — o CI e a estação usam as mesmas), raízes validadas e os comandos que rodam dentro
// do contêiner do Terraform. O código-fonte entra somente leitura e é copiado para /work dentro do
// contêiner: nada de `.terraform/` no repositório, e os provedores ficam num volume nomeado.
// Os scripts de `sh -c` não usam aspas duplas nem `%`: no Windows a linha passa pelo cmd.exe.

export const IAC_IMAGES = {
  terraform:
    'hashicorp/terraform:1.17.0@sha256:4d1b496a256f2989bccdb04b9104a4ede97234b10fba90259e173e905ec4fb58',
  tflint:
    'ghcr.io/terraform-linters/tflint:v0.65.0@sha256:2788f4d4fc663c0e953b011b01bf443fe5bfce7587ee916e588e6057b85d6359',
  trivy:
    'aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa',
} as const;

/** Volumes nomeados de cache (provedores, plugins do TFLint e base de checagens do Trivy). */
export const IAC_VOLUMES = {
  terraform: 'cf-terraform-plugins',
  tflint: 'cf-tflint-plugins',
  trivy: 'cf-trivy-cache',
} as const;

export const TERRAFORM_DIR = 'infra/terraform';

/** Raízes (cada uma com estado e lock file próprios); os módulos são validados por elas. */
export const TERRAFORM_ROOTS = ['bootstrap', 'envs/staging', 'envs/production'] as const;

export const ENVIRONMENTS = ['staging', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export function isEnvironment(value: string | undefined): value is Environment {
  return ENVIRONMENTS.some((item) => item === value);
}

export interface DockerRun {
  readonly image: string;
  readonly mounts: readonly string[];
  /** `NOME` (valor repassado do ambiente, nunca na linha de comando) ou `NOME=constante`. */
  readonly env?: readonly string[];
  readonly workdir?: string;
  readonly entrypoint?: string;
  readonly args: readonly string[];
}

/** Argumentos de `docker run --rm` para uma ferramenta de IaC. */
export function dockerArgs(spec: DockerRun): string[] {
  const args = ['run', '--rm'];
  for (const mount of spec.mounts) args.push('-v', mount);
  for (const name of spec.env ?? []) args.push('-e', name);
  if (spec.workdir) args.push('-w', spec.workdir);
  if (spec.entrypoint) args.push('--entrypoint', spec.entrypoint);
  args.push(spec.image, ...spec.args);
  return args;
}

/** Copia o código para /work sem diretórios `.terraform` que existam na estação. */
const COPY_SOURCE = [
  'cp -r /src/. /work',
  'find /work -name .terraform -type d -prune -exec rm -rf {} +',
];

/** `init -backend=false` + `validate` em cada raiz, com o lock file versionado (somente leitura). */
export function validateScript(roots: readonly string[] = TERRAFORM_ROOTS): string {
  const steps = roots.flatMap((root) => [
    `echo '== terraform validate: ${root}'`,
    `terraform -chdir=/work/${root} init -backend=false -input=false -lockfile=readonly -no-color > /dev/null`,
    `terraform -chdir=/work/${root} validate -no-color`,
  ]);
  return ['set -e', ...COPY_SOURCE, ...steps].join(' && ');
}

export interface PlanOptions {
  readonly environment: Environment;
  /** `apply` aplica o plano gerado no mesmo contêiner; senão só `plan` (sem lock). */
  readonly apply: boolean;
  /** Código 2 quando há mudança (drift agendado). */
  readonly detailedExitCode?: boolean;
}

/**
 * `init` com o bucket do estado (TF_STATE_BUCKET) e `plan`/`apply` da raiz do ambiente. Valores
 * ligados a contas AWS chegam em TF_VARS_JSON (variável TF_VARS_<ENV> do GitHub) e viram
 * `ci.auto.tfvars.json`, ignorado pelo Git.
 */
export function planScript(options: PlanOptions): string {
  const root = `/work/envs/${options.environment}`;
  const tf = `terraform -chdir=${root}`;
  const vars = `${root}/ci.auto.tfvars.json`;
  const plan = options.apply
    ? [`${tf} plan -input=false -no-color -out=tfplan`, `${tf} apply -input=false -no-color tfplan`]
    : [
        `${tf} plan -input=false -no-color -lock=false${options.detailedExitCode ? ' -detailed-exitcode' : ''}`,
      ];
  return [
    'set -e',
    ...COPY_SOURCE,
    `(printenv TF_VARS_JSON > ${vars} || true)`,
    `([ -s ${vars} ] || rm -f ${vars})`,
    `${tf} init -input=false -lockfile=readonly -no-color -backend-config=bucket=$TF_STATE_BUCKET > /dev/null`,
    ...plan,
  ].join(' && ');
}

/** TF_VARS_<ENV> precisa ser um objeto JSON (ex.: `{"ecr_registry": "…"}`). */
export function parseTfVars(text: string | undefined): Record<string, unknown> {
  if (text === undefined || text.trim() === '') return {};
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('TF_VARS_<ENV> deve ser um objeto JSON.');
  }
  return parsed as Record<string, unknown>;
}

/** Ids de conta AWS (12 dígitos) escritos no código — proibidos (spec-469). */
export function accountIdsIn(text: string): string[] {
  return [...text.matchAll(/(?<![\w.-])\d{12}(?![\w-]|\.\d)/g)].map((match) => match[0]);
}

/** Resumo do `plan` para o job: no máximo `limit` caracteres, dentro de um bloco recolhível. */
export function planSummary(environment: Environment, output: string, limit = 60_000): string {
  const text = output.length > limit ? `${output.slice(0, limit)}\n… (truncado)` : output;
  return [
    `### terraform plan — ${environment}`,
    '',
    '<details><summary>Plano</summary>',
    '',
    '```',
    text.trimEnd(),
    '```',
    '',
    '</details>',
  ].join('\n');
}
