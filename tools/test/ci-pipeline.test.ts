// US-079 — cenários Gherkin "Pipeline de CI com quality gates" (8 categorias), automatizados sobre
// a definição versionada do pipeline: workflows do GitHub Actions, ruleset da `main`
// (.github/repository-settings.json), CODEOWNERS e os helpers de tools/ci. A execução real no
// GitHub (PR fictício por estágio, p95 do caminho crítico) fica registrada no runbook do card.
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { parseToolOutput } from '../ci/lib/annotate.js';
import { createReporter } from '../ci/lib/annotations.js';
import {
  buildEnvironment,
  buildRuleset,
  readSettings,
  requiredReviewers,
  requiredTeams,
  toFnmatch,
} from '../ci/lib/github-settings.js';
import { leakMessage } from '../ci/lib/isolation.js';
import { lintMigration } from '../ci/lib/migrations.js';
import { containerName } from '../ci/lib/postgres.js';
import { backoffSchedule, spawnAttempt, withRetry } from '../ci/lib/retry.js';
import type { AttemptResult } from '../ci/lib/retry.js';
import { projectNameFrom } from '../env/lib/compose.js';
import { ownersOf, parseCodeowners } from '../lib/codeowners.js';
import { REPO_ROOT } from '../lib/workspace.js';

interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly if?: string;
  readonly env?: Record<string, string>;
  readonly with?: Record<string, unknown>;
  readonly 'continue-on-error'?: boolean;
}

interface Job {
  readonly name?: string;
  readonly needs?: string | string[];
  readonly if?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly 'timeout-minutes'?: number;
  readonly permissions?: Record<string, string>;
  readonly environment?: string | { name: string };
  readonly steps?: Step[];
}

interface Workflow {
  readonly on: Record<string, unknown>;
  readonly concurrency?: { group: string; 'cancel-in-progress': boolean };
  readonly permissions?: Record<string, string>;
  readonly env?: Record<string, string>;
  readonly jobs: Record<string, Job>;
}

const WORKFLOWS = path.join(REPO_ROOT, '.github/workflows');
const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const workflow = (file: string) => parse(read(`.github/workflows/${file}`)) as Workflow;

const ci = workflow('ci.yml');
const images = workflow('images.yml');
const deploy = workflow('deploy-staging.yml');
const settings = readSettings();
const codeowners = parseCodeowners(read('.github/CODEOWNERS'));
const teamIds = new Map(
  ['tech-lead', 'security', 'platform', 'frontend', 'design', 'product'].map((team, index) => [
    team,
    index + 1,
  ]),
);
const ruleset = buildRuleset(settings, codeowners, teamIds) as {
  bypass_actors: unknown[];
  rules: { type: string; parameters?: Record<string, unknown> }[];
};
const rule = (type: string) => ruleset.rules.find((item) => item.type === type)?.parameters ?? {};

const runs = (job: Job | undefined) => (job?.steps ?? []).map((step) => step.run ?? '').join('\n');
const stepIndex = (job: Job | undefined, text: string) =>
  (job?.steps ?? []).findIndex((step) => (step.run ?? '').includes(text));
const STAGES = [
  '1. Higiene',
  '2. Estático',
  '3. Contrato',
  '4. Testes',
  '5. Migrações',
  '6. Imagens',
  '7. E2E',
];

describe('Feature: Pipeline de CI com quality gates (US-079)', () => {
  describe('[Sucesso] Pull Request aprovado em todos os estágios obrigatórios', () => {
    it('todo PR contra main dispara o workflow com os estágios 1 a 7', () => {
      expect(ci.on).toEqual({ pull_request: { branches: ['main'] } });
      const names = Object.values(ci.jobs).map((job) => job.name ?? '');
      for (const stage of STAGES) expect(names).toContain(stage);
    });

    it('os required checks da ruleset são exatamente os checks dos estágios 1–7 do ci.yml', () => {
      const stageChecks = Object.values(ci.jobs)
        .filter((job) => job.uses === undefined)
        .map((job) => job.name ?? '')
        .filter((name) => /^[1-7]\. /.test(name));
      expect([...settings.ruleset.requiredStatusChecks].sort()).toEqual(stageChecks.sort());
      const checks = rule('required_status_checks') as {
        required_status_checks: { context: string; integration_id: number }[];
        strict_required_status_checks_policy: boolean;
      };
      // Só checks emitidos pelo app do GitHub Actions contam (ninguém forja um status com o nome).
      expect(checks.required_status_checks.every((item) => item.integration_id === 15368)).toBe(
        true,
      );
      expect(checks.strict_required_status_checks_policy).toBe(true);
    });

    it('o PR fica elegível só para squash merge, com aprovação de CODEOWNERS', () => {
      expect(rule('pull_request')).toMatchObject({
        allowed_merge_methods: ['squash'],
        require_code_owner_review: true,
        required_approving_review_count: 1,
        dismiss_stale_reviews_on_push: true,
      });
      expect(settings.repository).toMatchObject({
        allow_squash_merge: true,
        allow_merge_commit: false,
        allow_rebase_merge: false,
        squash_merge_commit_title: 'PR_TITLE',
      });
      // Fluxo principal 5: o título do PR (a mensagem do squash) passa pelo commitlint.
      expect(stepIndex(ci.jobs.hygiene, 'ci/pr-title.ts')).toBeGreaterThan(-1);
    });

    it('o estágio 8 roda só depois do merge, contra staging, e é gate da promoção para produção', () => {
      expect(deploy.on).toEqual({ push: { branches: ['main'] } });
      const post = deploy.jobs['post-deploy'];
      expect(post?.name).toBe('8. Pós-deploy');
      expect(post?.environment).toBe('staging');
      expect(runs(post)).toMatch(/zap-baseline\.py/);
      expect(runs(post)).toMatch(/k6/);
      expect(runs(post)).toMatch(/verify-traces\.ts/);
      const promote = deploy.jobs['promote-production'];
      expect(promote?.needs).toBe('post-deploy');
      expect(promote?.environment).toMatchObject({ name: 'production' });
      const production = settings.environments.find((item) => item.name === 'production');
      if (!production) throw new Error('ambiente production ausente');
      expect(production.reviewers).toContain('tech-lead');
      expect(buildEnvironment(production, teamIds)).toMatchObject({
        reviewers: [{ type: 'Team', id: 1 }],
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      });
    });
  });

  describe('[Validação] Erro de tipo bloqueia o merge', () => {
    it('o estágio "Estático" roda lint, typecheck, fronteiras e SAST como gates', () => {
      const commands = runs(ci.jobs.static);
      expect(commands).toContain('pnpm turbo run lint typecheck');
      expect(commands).toContain('pnpm depcruise');
      expect(commands).toContain('semgrep --test');
      expect(commands).toContain('semgrep scan');
      expect(ci.jobs.codeql?.steps?.map((step) => step.uses ?? '').join()).toContain(
        'codeql-action/analyze',
      );
      expect(rule('code_scanning')).toMatchObject({
        code_scanning_tools: [{ tool: 'CodeQL', security_alerts_threshold: 'high_or_higher' }],
      });
    });

    it('o erro real do tsc vira anotação no arquivo e na linha', async () => {
      const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
      const fixture = 'tools/fixtures/ci/type-error.ts';
      let output = '';
      try {
        await promisify(execFile)(
          process.execPath,
          [tsc, '--noEmit', '--pretty', 'false', '--strict', fixture],
          { cwd: REPO_ROOT },
        );
      } catch (error: unknown) {
        // tsc sai com código 2 quando há erro de tipo; a saída vem no stdout do erro.
        output = (error as { stdout?: string }).stdout ?? '';
      }
      // Mesmo formato que o Turborepo imprime: `<pacote>:<tarefa>: <saída>`.
      const prefixed = output
        .split(/\r?\n/)
        .map((line) => `//:typecheck: ${line}`)
        .join('\n');
      const [first] = parseToolOutput(prefixed, new Map([['//', '.']]), REPO_ROOT);
      expect(first).toMatchObject({
        level: 'error',
        file: fixture,
        line: 2,
        title: 'TypeScript TS2322',
      });
    });

    it('erros do ESLint e do Prettier também apontam arquivo e linha', () => {
      const root = path.resolve(REPO_ROOT);
      const output = [
        '@contrataflow/api:lint: ',
        `@contrataflow/api:lint: ${path.join(root, 'apps/api/src/main.ts')}`,
        "@contrataflow/api:lint:   3:7  error  'x' is assigned a value but never used  @typescript-eslint/no-unused-vars",
        '@contrataflow/api:lint: ',
        '//:lint:repo: [warn] apps/web/src/app/page.tsx',
        '//:lint:repo: [warn] Code style issues found in the above file. Run Prettier with --write to fix.',
      ].join('\n');
      const annotations = parseToolOutput(
        output,
        new Map([
          ['@contrataflow/api', 'apps/api'],
          ['//', '.'],
        ]),
        root,
      );
      expect(annotations).toEqual([
        expect.objectContaining({
          file: 'apps/api/src/main.ts',
          line: 3,
          col: 7,
          title: 'ESLint @typescript-eslint/no-unused-vars',
        }),
        expect.objectContaining({ file: 'apps/web/src/app/page.tsx', title: 'Prettier' }),
      ]);
    });

    it('lockfile desatualizado orienta "Execute pnpm install e versione o lockfile." (V-01)', () => {
      const setup = read('.github/actions/setup/action.yml');
      expect(setup).toContain('pnpm install --frozen-lockfile');
      expect(setup).toContain('ERR_PNPM_OUTDATED_LOCKFILE');
      expect(setup).toContain('Execute pnpm install e versione o lockfile.');
    });
  });

  describe('[Permissão] Alteração em arquivo protegido sem aprovação de CODEOWNERS', () => {
    it('.github/workflows/ci.yml exige Tech Lead e segurança, por CODEOWNERS e pela ruleset', () => {
      const file = '.github/workflows/ci.yml';
      expect(ownersOf(codeowners, file)).toEqual(
        expect.arrayContaining(['@contrataflow/tech-lead', '@contrataflow/security']),
      );
      const reviewers = requiredReviewers(codeowners);
      for (const team of ['tech-lead', 'security']) {
        expect(reviewers.find((item) => item.team === team)?.patterns).toContain('.github/**/*');
      }
      const required = rule('pull_request').required_reviewers as {
        file_patterns: string[];
        reviewer: { type: string };
      }[];
      expect(required.every((item) => item.reviewer.type === 'Team')).toBe(true);
    });

    it('nem administradores contornam a ruleset (sem bypass)', () => {
      expect(ruleset.bypass_actors).toEqual([]);
      expect(ruleset.rules.map((item) => item.type)).toEqual(
        expect.arrayContaining(['deletion', 'non_fast_forward', 'required_linear_history']),
      );
    });

    it('as ferramentas do pipeline também têm donos sensíveis', () => {
      for (const file of [
        'tools/ci/lib/cve.ts',
        '.semgrep/rules/cf-no-process-env.yml',
        '.github/ci-policy.yml',
        'infra/docker/prod.Dockerfile',
      ]) {
        expect(ownersOf(codeowners, file)).toEqual(
          expect.arrayContaining(['@contrataflow/tech-lead', '@contrataflow/security']),
        );
      }
    });

    it('PR de fork roda sem segredos: sem pull_request_target e token só de leitura', () => {
      for (const file of readdirSync(WORKFLOWS)) {
        expect(Object.keys(workflow(file).on)).not.toContain('pull_request_target');
      }
      expect(ci.permissions).toEqual({ contents: 'read' });
      expect(settings.actions).toMatchObject({
        default_workflow_permissions: 'read',
        can_approve_pull_request_reviews: false,
        fork_pr_approval_policy: 'all_external_contributors',
      });
      const writers = Object.entries(ci.jobs).filter(([, job]) =>
        Object.values(job.permissions ?? {}).includes('write'),
      );
      expect(writers.map(([id, job]) => [id, job.permissions])).toEqual([
        ['codeql', { contents: 'read', 'security-events': 'write', actions: 'read' }],
        ['notify', { 'pull-requests': 'write' }],
      ]);
      // O aviso no PR nunca roda com token de fork.
      expect(ci.jobs.notify?.if).toContain('head.repo.full_name == github.repository');
    });

    it('credenciais da AWS só por OIDC, em jobs com ambiente protegido, e deploy só por maintainer', () => {
      for (const [, job] of Object.entries(deploy.jobs)) {
        const usesAws = (job.steps ?? []).some((step) =>
          (step.uses ?? '').includes('configure-aws-credentials'),
        );
        if (usesAws) expect(job.environment).toBeDefined();
      }
      expect(images.jobs.build?.environment).toBe('${{ inputs.environment }}');
      const all = readdirSync(WORKFLOWS)
        .map((file) => read(`.github/workflows/${file}`))
        .join('\n');
      expect(all).not.toMatch(/aws-access-key-id|AWS_SECRET_ACCESS_KEY/);
      expect(runs(deploy.jobs.preflight)).toMatch(/admin\|maintain/);
    });

    it('times obrigatórios: todos os donos de um caminho sensível, plataforma como apoio da segurança', () => {
      expect(
        requiredTeams([
          '@contrataflow/tech-lead',
          '@contrataflow/security',
          '@contrataflow/platform',
        ]),
      ).toEqual(['tech-lead', 'security']);
      expect(requiredTeams(['@contrataflow/tech-lead', '@contrataflow/platform'])).toEqual([
        'tech-lead',
        'platform',
      ]);
      expect(requiredTeams(['@contrataflow/engineering'])).toEqual([]);
      expect(toFnmatch('/apps/api/src/shared/')).toBe('apps/api/src/shared/**/*');
      expect(toFnmatch('/pnpm-workspace.yaml')).toBe('pnpm-workspace.yaml');
      expect(() => buildRuleset(settings, codeowners, new Map())).toThrow(/não encontrado/);
    });
  });

  describe('[Tenant incorreto] Regressão de isolamento é bloqueada', () => {
    it('o estágio "Testes" roda unitários → integração → tenant leak → autorização, nessa ordem', () => {
      const order = [
        'turbo run test\n',
        'turbo run test:integration',
        'turbo run test:tenant-leak',
        'turbo run test:authz',
      ];
      const positions = order.map((command) => stepIndex(ci.jobs.tests, command.trim()));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(stepIndex(ci.jobs.tests, 'ci/coverage-gate.ts')).toBeGreaterThan(positions[0] ?? -1);
    });

    it('tabela nova com tenant_id e sem RLS é barrada antes de chegar ao banco', () => {
      const [finding] = lintMigration({
        name: '20261101_cria_processos',
        file: 'apps/api/prisma/migrations/20261101_cria_processos/migration.sql',
        sql: 'CREATE TABLE processes (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, title text);',
        checksum: 'x',
      });
      expect(finding?.rule).toBe('tenant/rls');
    });

    it('a suíte reporta "Isolamento de tenant violado em {teste}." (V-07)', () => {
      expect(leakMessage('contexto Prefeitura A lendo Prefeitura B')).toBe(
        'Isolamento de tenant violado em contexto Prefeitura A lendo Prefeitura B.',
      );
    });
  });

  describe('[Duplicidade] Execuções redundantes são canceladas', () => {
    it('um commit novo no mesmo PR cancela a execução em andamento', () => {
      expect(ci.concurrency).toEqual({
        group: 'ci-pr-${{ github.event.pull_request.number }}',
        'cancel-in-progress': true,
      });
    });

    it('deploys nunca são cancelados no meio', () => {
      expect(deploy.concurrency).toEqual({ group: 'deploy-staging', 'cancel-in-progress': false });
    });
  });

  describe('[Concorrência] Pull Requests simultâneos não interferem entre si', () => {
    it('cada execução tem projeto do Compose próprio, aplicado ao .env efêmero', () => {
      expect(ci.env?.COMPOSE_PROJECT_NAME).toBe(
        'cf-ci-${{ github.run_id }}-${{ github.run_attempt }}',
      );
      expect(runs(ci.jobs.e2e)).toContain('COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME');
      expect(projectNameFrom({ COMPOSE_PROJECT_NAME: 'cf-ci-123-1' })).toBe('cf-ci-123-1');
      expect(projectNameFrom({ COMPOSE_PROJECT_NAME: 'Inválido!' })).toBe('contrataflow');
      expect(projectNameFrom({})).toBe('contrataflow');
    });

    it('bancos efêmeros têm nome único por execução e são descartados mesmo em falha', () => {
      const env = { GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2' };
      const first = containerName(env);
      expect(first).toMatch(/^cf-ci-pg-42-2-[0-9a-f]{8}$/);
      expect(containerName(env)).not.toBe(first);
      for (const job of [ci.jobs.tests, ci.jobs.migrations]) {
        const cleanup = job?.steps?.find((step) =>
          (step.run ?? '').includes('label=com.contrataflow.ci=true'),
        );
        expect(cleanup?.if).toBe('always()');
      }
      const teardown = ci.jobs.e2e?.steps?.find((step) =>
        (step.run ?? '').includes('compose --env-file .env down'),
      );
      expect(teardown?.if).toBe('always()');
    });

    it('todo job tem tempo limite (nenhum PR segura runner indefinidamente)', () => {
      for (const definition of [ci, images, deploy]) {
        for (const job of Object.values(definition.jobs)) {
          if (job.uses === undefined) expect(job['timeout-minutes']).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('[Falha de banco] Migração falha ao aplicar sobre o snapshot anterior', () => {
    it('o estágio aplica do zero e sobre o snapshot da versão publicada, com as tags', () => {
      const job = ci.jobs.migrations;
      expect(job?.name).toBe('5. Migrações');
      expect(runs(job)).toContain('ci/migrations.ts --base "$BASE_SHA"');
      const checkout = job?.steps?.[0];
      expect(checkout?.with).toMatchObject({ 'fetch-depth': 0, 'fetch-tags': true });
    });
  });

  describe('[Falha de integração] Scanner de vulnerabilidades fica indisponível', () => {
    const silent = () => createReporter({ env: {}, write: () => undefined });

    it('tenta de novo com backoff exponencial antes de falhar definitivamente', async () => {
      const results: AttemptResult[] = [
        { status: 1, timedOut: false },
        { status: 1, timedOut: false },
        { status: 0, timedOut: false },
      ];
      const sleeps: number[] = [];
      const reporter = silent();
      const outcome = await withRetry(
        () => Promise.resolve(results.shift() ?? { status: 1, timedOut: false }),
        { service: 'Trivy', attempts: 3, initialDelayMs: 1000 },
        reporter,
        (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      );
      expect(outcome).toEqual({ ok: true, attempts: 3, timedOut: false, status: 0 });
      expect(sleeps).toEqual([1000, 2000]);
      expect(
        reporter.lines.filter((line) =>
          line.includes('Falha ao contatar Trivy. Tentando novamente.'),
        ),
      ).toHaveLength(4);
      expect(
        backoffSchedule({ service: 's', attempts: 4, initialDelayMs: 10_000, maxDelayMs: 25_000 }),
      ).toEqual([10_000, 20_000, 25_000]);
    });

    it('tempo limite excedido encerra o processo e falha de forma explícita', async () => {
      const reporter = silent();
      const outcome = await withRetry(
        spawnAttempt(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']),
        { service: 'Trivy', attempts: 2, initialDelayMs: 10, attemptTimeoutMs: 300 },
        reporter,
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.timedOut).toBe(true);
      expect(reporter.lines.join('\n')).toContain(
        'Tempo limite de 0s excedido ao contatar Trivy (2 tentativas). Falha definitiva.',
      );
    });

    it('falha sem tempo limite também é definitiva depois das tentativas', async () => {
      const reporter = silent();
      const outcome = await withRetry(
        spawnAttempt(process.execPath, ['-e', 'process.exit(3)']),
        { service: 'registry', attempts: 1, initialDelayMs: 0 },
        reporter,
      );
      expect(outcome).toEqual({ ok: false, attempts: 1, timedOut: false, status: 3 });
      expect(reporter.lines.join('\n')).toContain('Falha ao contatar registry após 1 tentativas.');
      await expect(
        withRetry(
          () => Promise.resolve({ status: 0, timedOut: false }),
          { service: 'x', attempts: 0, initialDelayMs: 0 },
          reporter,
        ),
      ).rejects.toThrow(RangeError);
    });

    it('o estágio "Imagens" usa retry na base e na varredura do Trivy, com timeout por job', () => {
      const build = images.jobs.build;
      const steps = build?.steps ?? [];
      const trivySteps = steps.filter((step) => (step.run ?? '').includes('TRIVY_IMAGE'));
      expect(trivySteps).toHaveLength(2);
      expect(trivySteps.every((step) => (step.run ?? '').includes('ci/retry.ts'))).toBe(true);
      expect(trivySteps.every((step) => /--timeout \d+/.test(step.run ?? ''))).toBe(true);
      expect(build?.['timeout-minutes']).toBeGreaterThan(0);
      // Build com 2ª tentativa, SBOM, gate de CVE e assinatura (DoD).
      expect(steps.find((step) => step.name === 'Build multi-stage')?.['continue-on-error']).toBe(
        true,
      );
      expect(steps.some((step) => step.if === "steps.build.outcome == 'failure'")).toBe(true);
      expect(runs(build)).toContain('cyclonedx-json');
      expect(runs(build)).toContain('ci/cve-gate.ts');
      expect(runs(build)).toContain('cosign sign');
      expect(runs(build)).toContain('cosign verify');
    });
  });
});
