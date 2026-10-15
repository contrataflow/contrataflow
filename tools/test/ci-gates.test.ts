// US-079 — helpers dos gates do CI (tools/ci/lib): anotações, retry, escopo da mudança, licenças,
// CVE, política, título do PR, gitleaks, Semgrep, cobertura, migrações, ruleset, traces e ECS.
import { describe, expect, it } from 'vitest';

import {
  annotation,
  createReporter,
  escapeData,
  outputLine,
  runUrl,
} from '../ci/lib/annotations.js';
import { classifyChanges } from '../ci/lib/changes.js';
import { evaluateCoverage, lineRanges, moduleOf, parseLcov } from '../ci/lib/coverage.js';
import { blockingMessage, evaluateCves, parseTrivyReport } from '../ci/lib/cve.js';
import type { Vulnerability } from '../ci/lib/cve.js';
import { parseDigests, ROLLOUT, withImage } from '../ci/lib/ecs.js';
import { parseUnifiedZero } from '../ci/lib/git.js';
import {
  checkLicenses,
  isLicenseAllowed,
  parsePnpmLicenses,
  parseSpdx,
} from '../ci/lib/licenses.js';
import {
  applyMigrations,
  catalogChecksSql,
  checkPublished,
  lintMigration,
  newMigrations,
  parseCatalogViolations,
} from '../ci/lib/migrations.js';
import type { Migration } from '../ci/lib/migrations.js';
import { parsePolicy, PolicyError, readPolicy } from '../ci/lib/policy.js';
import { squashMessage } from '../ci/lib/pr-title.js';
import { parseGitleaksReport, secretMessage } from '../ci/lib/secrets.js';
import { parseSemgrepJson } from '../ci/lib/semgrep.js';
import { SESSION_CONTEXT_MESSAGE } from '../ci/lib/sql-lint.js';
import { hasSpans, newTraceContext, traceQueryUrl, waitForTrace } from '../ci/lib/traces.js';

const ALLOWED = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC'];

describe('anotações do GitHub Actions', () => {
  it('escapa dados e propriedades (%, quebras de linha, : e ,)', () => {
    expect(escapeData('100%\nok')).toBe('100%25%0Aok');
    expect(annotation('error', 'falhou', { file: 'a,b:c.ts', line: 3, col: 2, title: 'T' })).toBe(
      '::error file=a%2Cb%3Ac.ts,line=3,col=2,title=T::falhou',
    );
    expect(annotation('notice', 'só mensagem')).toBe('::notice::só mensagem');
  });

  it('fora do Actions imprime texto legível; dentro, comandos de workflow e outputs', () => {
    const local = createReporter({ env: {}, write: () => undefined });
    local.annotate('warning', 'atenção', { file: 'x.ts', line: 1 });
    local.setOutput('code', 'true');
    expect(local.lines).toEqual(['⚠ x.ts:1 — atenção', 'code=true']);

    const files: Record<string, string> = {};
    const actions = createReporter({
      env: { GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: 'out', GITHUB_STEP_SUMMARY: 'sum' },
      write: () => undefined,
      append: (file, text) => {
        files[file] = (files[file] ?? '') + text;
      },
    });
    actions.annotate('error', 'erro');
    actions.setOutput('list', 'a\nb');
    actions.summary('### Resumo');
    actions.log('info', 'ci.stage_completed', 'ok', { stage: '1. Higiene' });
    expect(actions.lines[0]).toBe('::error::erro');
    expect(actions.lines[1]).toBe('✔ ci.stage_completed — ok {"stage":"1. Higiene"}');
    expect(files.out).toBe('list<<CF_EOF\na\nb\nCF_EOF\n');
    expect(files.sum).toBe('### Resumo\n');
  });

  it('outputLine simples e link dos logs da execução', () => {
    expect(outputLine('code', 'false')).toBe('code=false\n');
    expect(
      runUrl({
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_RUN_ID: '9',
      }),
    ).toBe('https://github.com/o/r/actions/runs/9');
    expect(runUrl({})).toBeUndefined();
  });
});

describe('escopo da mudança (FA-05)', () => {
  it('só docs/** pula 4–7; qualquer outro arquivo ou diff vazio roda tudo', () => {
    expect(classifyChanges(['docs/mvp-01/api.md', 'docs/adr/adr-001.md'])).toMatchObject({
      code: false,
      docsOnly: true,
    });
    expect(classifyChanges(['docs/a.md', 'apps/api/src/main.ts']).code).toBe(true);
    expect(classifyChanges(['README.md']).code).toBe(true);
    expect(classifyChanges([]).code).toBe(true);
  });
});

describe('git diff -U0', () => {
  it('linhas novas por arquivo, sem arquivos removidos', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,0 +2,3 @@',
      '+x',
      '@@ -10 +12 @@',
      '+y',
      'diff --git a/old.ts b/old.ts',
      '--- a/old.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      'diff --git a/del.ts b/del.ts',
      '+++ b/del.ts',
      '@@ -3,2 +2,0 @@',
    ].join('\n');
    const changed = parseUnifiedZero(diff);
    expect([...changed.keys()]).toEqual(['a.ts']);
    expect([...(changed.get('a.ts') ?? [])]).toEqual([2, 3, 4, 12]);
  });
});

describe('licenças (RN-FND-10)', () => {
  it('avalia expressões SPDX', () => {
    expect(isLicenseAllowed('MIT', ALLOWED)).toBe(true);
    expect(isLicenseAllowed('(MIT OR GPL-3.0)', ALLOWED)).toBe(true);
    expect(isLicenseAllowed('MIT AND GPL-3.0', ALLOWED)).toBe(false);
    expect(isLicenseAllowed('Apache-2.0 WITH LLVM-exception', ALLOWED)).toBe(true);
    expect(isLicenseAllowed('mit', ALLOWED)).toBe(true);
    for (const unknown of ['UNLICENSED', 'Unknown', 'SEE LICENSE IN LICENSE.md', '', '(MIT']) {
      expect(isLicenseAllowed(unknown, ALLOWED)).toBe(false);
    }
    expect(parseSpdx('A OR B AND C')).toMatchObject({ kind: 'or' });
    expect(() => parseSpdx('MIT)')).toThrow();
  });

  it('bloqueia GPL e desconhecidas, aceita exceção aprovada e aponta exceção sem uso', () => {
    const packages = parsePnpmLicenses(
      JSON.stringify({
        MIT: [{ name: 'next', versions: ['16.3.8'], license: 'MIT' }],
        'GPL-3.0': [{ name: 'gpl-lib', versions: ['1.0.0'], license: 'GPL-3.0' }],
        'LGPL-3.0-or-later': [
          {
            name: '@img/sharp-libvips-linux-x64',
            versions: ['1.3.4'],
            license: 'LGPL-3.0-or-later',
          },
        ],
        Unknown: [
          { name: '@contrataflow/types', versions: ['0.0.0'], license: 'Unknown' },
          { name: 'mystery', versions: ['2.0.0'] },
        ],
      }),
    );
    const exceptions = [
      {
        package: '@img/sharp-libvips-*',
        license: 'LGPL-3.0-or-later',
        reason: 'r',
        approvedBy: 'a',
      },
      { package: 'unused', license: 'CC-BY-4.0', reason: 'r', approvedBy: 'a' },
    ];
    const report = checkLicenses(packages, ALLOWED, exceptions);
    expect(report.checked).toBe(4);
    expect(report.violations.map((item) => item.name)).toEqual(['gpl-lib', 'mystery']);
    expect(report.violations[0]?.message).toContain(
      'Licença "GPL-3.0" não permitida em gpl-lib@1.0.0',
    );
    expect(report.excepted.map((item) => item.name)).toEqual(['@img/sharp-libvips-linux-x64']);
    expect(report.unusedExceptions.map((item) => item.package)).toEqual(['unused']);
  });
});

describe('política do CI (.github/ci-policy.yml)', () => {
  it('a política versionada é válida e liga o gate de cobertura em 80%', () => {
    const policy = readPolicy();
    expect(policy.coverageThreshold).toBe(80);
    expect(policy.coverageGateEnabled).toBe(true);
    expect(policy.licenses.allowed).toEqual(
      expect.arrayContaining(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD']),
    );
  });

  it('usa os padrões e valida campos', () => {
    expect(parsePolicy('ci: {}\n')).toMatchObject({
      coverageThreshold: 80,
      coverageGateEnabled: true,
    });
    expect(() => parsePolicy('')).toThrow(PolicyError);
    expect(() => parsePolicy('ci: { coverageThreshold: 120 }')).toThrow(/0 a 100/);
    expect(() => parsePolicy('ci: { coverageGateEnabled: "sim" }')).toThrow(/true ou false/);
    expect(() => parsePolicy('licenses: { allowed: MIT }')).toThrow(/lista/);
    expect(() => parsePolicy('licenses: { allowed: [""] }')).toThrow(/SPDX/);
    expect(() => parsePolicy('licenses: { exceptions: [ { package: x } ] }')).toThrow(/license/);
    expect(() => parsePolicy('licenses: { exceptions: [ 1 ] }')).toThrow(/objeto/);
    expect(() =>
      parsePolicy(
        'cve: { exceptions: [ { id: CVE-1, reason: r, owner: o, reviewBy: 2026-02-30 } ] }',
      ),
    ).toThrow(/AAAA-MM-DD/);
    expect(() => parsePolicy('cve: { exceptions: [ x ] }')).toThrow(/objeto/);
    const ok = parsePolicy(
      "cve: { exceptions: [ { id: CVE-1, package: zlib, reason: r, owner: o, reviewBy: '2026-12-31' } ] }",
    );
    expect(ok.cveExceptions).toEqual([
      { id: 'CVE-1', package: 'zlib', reason: 'r', owner: 'o', reviewBy: '2026-12-31' },
    ]);
  });
});

describe('gate de CVE (RN-FND-26 · FA-03)', () => {
  const vuln = (id: string, fixed: string, pkg = 'zlib'): Vulnerability => ({
    id,
    pkg,
    installed: '1.0',
    fixed,
    severity: 'HIGH',
    target: 'img',
    title: '',
  });

  it('lê só crítica/alta do relatório do Trivy, sem repetir', () => {
    const report = JSON.stringify({
      Results: [
        {
          Target: 'debian',
          Vulnerabilities: [
            { VulnerabilityID: 'CVE-1', PkgName: 'a', InstalledVersion: '1', Severity: 'CRITICAL' },
            { VulnerabilityID: 'CVE-1', PkgName: 'a', InstalledVersion: '1', Severity: 'CRITICAL' },
            { VulnerabilityID: 'CVE-2', PkgName: 'b', Severity: 'MEDIUM' },
          ],
        },
        { Target: 'node', Vulnerabilities: null },
      ],
    });
    expect(parseTrivyReport(report).map((item) => item.id)).toEqual(['CVE-1']);
  });

  it('com correção bloqueia; sem correção: exceção ativa, vencida ou não registrada', () => {
    const exceptions = [
      { id: 'CVE-ACTIVE', reason: 'r', reviewBy: '2026-12-31', owner: 'o' },
      { id: 'CVE-EXPIRED', package: 'zlib', reason: 'r', reviewBy: '2026-01-01', owner: 'o' },
      { id: 'CVE-FIXED', reason: 'r', reviewBy: '2026-12-31', owner: 'o' },
    ];
    const verdict = evaluateCves(
      [
        vuln('CVE-FIXED', '1.1'),
        vuln('CVE-ACTIVE', ''),
        vuln('CVE-EXPIRED', ''),
        vuln('CVE-NEW', ''),
        vuln('CVE-EXPIRED', '', 'outro-pacote'),
      ],
      exceptions,
      '2026-10-14',
    );
    expect(verdict.blocking.map((item) => item.id)).toEqual(['CVE-FIXED']);
    expect(verdict.excepted.map(({ vuln: item }) => item.id)).toEqual(['CVE-ACTIVE']);
    expect(verdict.expired.map(({ vuln: item }) => item.id)).toEqual(['CVE-EXPIRED']);
    expect(verdict.unregistered.map((item) => `${item.id}/${item.pkg}`)).toEqual([
      'CVE-NEW/zlib',
      'CVE-EXPIRED/outro-pacote',
    ]);
    expect(blockingMessage(vuln('CVE-9', '2.0'))).toBe(
      'Vulnerabilidade CVE-9 em zlib. Atualize para 2.0.',
    );
  });
});

describe('título do PR (commitlint)', () => {
  it('junta o título aos rodapés Refs/BREAKING CHANGE do corpo', () => {
    expect(
      squashMessage(' feat(api): x ', '## O que muda\n\nRefs: US-079\nBREAKING CHANGE: y DEC-108'),
    ).toBe('feat(api): x\n\nRefs: US-079\nBREAKING CHANGE: y DEC-108');
    expect(squashMessage('fix(web): y', 'sem rodapé')).toBe('fix(web): y');
  });
});

describe('gitleaks (V-02)', () => {
  it('cita arquivo e linha, nunca o segredo', () => {
    const findings = parseGitleaksReport(
      JSON.stringify([
        {
          File: '/repo/apps/api/.env.prod',
          StartLine: 4,
          RuleID: 'aws-access-token',
          Commit: 'abcdef1234567890',
          Secret: 'REDACTED',
        },
      ]),
    );
    expect(findings).toEqual([
      { file: 'apps/api/.env.prod', line: 4, rule: 'aws-access-token', commit: 'abcdef123456' },
    ]);
    expect(secretMessage(findings[0] ?? { file: '', line: 0, rule: '', commit: '' })).toBe(
      'Segredo detectado em apps/api/.env.prod:4. Remova e rotacione.',
    );
    expect(parseGitleaksReport('')).toEqual([]);
    expect(parseGitleaksReport('null')).toEqual([]);
  });
});

describe('Semgrep (V-04)', () => {
  it('cada achado vira anotação com a regra violada', () => {
    const report = parseSemgrepJson(
      JSON.stringify({
        results: [
          {
            check_id: 'semgrep.rules.cf-no-unsafe-raw-query',
            path: 'apps/api/src/x.ts',
            start: { line: 7, col: 3 },
            extra: { message: 'SQL\n  montado', severity: 'ERROR' },
          },
        ],
        errors: [
          { level: 'warn', message: 'timeout' },
          { level: 'error', message: 'regra inválida' },
        ],
      }),
    );
    expect(report.findings).toEqual([
      {
        level: 'error',
        file: 'apps/api/src/x.ts',
        line: 7,
        col: 3,
        title: 'Semgrep cf-no-unsafe-raw-query',
        message: 'SQL montado',
      },
    ]);
    expect(report.errors).toEqual(['regra inválida']);
  });
});

describe('cobertura do código novo (RN-FND-24)', () => {
  const lcov = [
    'SF:src/modules/process/domain/process.ts',
    'DA:1,1',
    'DA:2,0',
    'DA:3,4',
    'DA:4,0',
    'end_of_record',
    'SF:src/modules/dfd/application/create-dfd.use-case.ts',
    'DA:10,2',
    'end_of_record',
  ].join('\n');

  it('módulo de domain/application e lcov relativo ao pacote', () => {
    expect(moduleOf('apps/api/src/modules/process/domain/process.ts')).toBe('process');
    expect(moduleOf('apps/api/src/modules/process/application/x.use-case.ts')).toBe('process');
    expect(moduleOf('apps/api/src/modules/process/domain/process.spec.ts')).toBeUndefined();
    expect(moduleOf('apps/api/src/modules/process/infrastructure/repo.ts')).toBeUndefined();
    const coverage = parseLcov(lcov, 'apps/api', '/repo');
    expect([...coverage.keys()]).toEqual([
      'apps/api/src/modules/process/domain/process.ts',
      'apps/api/src/modules/dfd/application/create-dfd.use-case.ts',
    ]);
  });

  it('bloqueia o módulo abaixo do mínimo e ignora linhas não executáveis', () => {
    const coverage = parseLcov(lcov, 'apps/api', '/repo');
    const changed = new Map([
      ['apps/api/src/modules/process/domain/process.ts', new Set([1, 2, 4, 9])],
      ['apps/api/src/modules/dfd/application/create-dfd.use-case.ts', new Set([10])],
      ['apps/api/src/modules/dfd/domain/types.ts', new Set([1])],
      ['apps/web/src/app/page.tsx', new Set([1])],
    ]);
    const result = evaluateCoverage(changed, coverage, 80);
    expect(result.passed).toBe(false);
    expect(result.missing).toEqual(['apps/api/src/modules/dfd/domain/types.ts']);
    const [dfd, processModule] = result.modules;
    expect(dfd).toMatchObject({ module: 'dfd', total: 1, covered: 1, percent: 100, passed: true });
    expect(processModule).toMatchObject({ module: 'process', total: 3, covered: 1, percent: 33.3 });
    expect([
      ...(processModule?.uncovered.get('apps/api/src/modules/process/domain/process.ts') ?? []),
    ]).toEqual([2, 4]);
    expect(evaluateCoverage(new Map(), coverage, 80).passed).toBe(true);
  });

  it('agrupa linhas consecutivas', () => {
    expect(lineRanges([5, 1, 2, 3, 9])).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 5 },
      { start: 9, end: 9 },
    ]);
  });
});

const migration = (name: string, sql: string): Migration => ({
  name,
  file: `apps/api/prisma/migrations/${name}/migration.sql`,
  sql,
  checksum: sql,
});

describe('lint de migrações (RN-FND-25)', () => {
  it('operação destrutiva fora da fase contract é barrada', () => {
    const findings = lintMigration(
      migration(
        '20261101_remove',
        'ALTER TABLE processes DROP COLUMN legacy_code;\n-- DROP TABLE x;',
      ),
    );
    expect(findings.map((item) => `${item.rule}@${String(item.line)}`)).toEqual([
      'expand-contract/drop-column@1',
    ]);
    expect(findings[0]?.message).toContain('expand/contract');
    for (const sql of [
      'DROP TABLE a;',
      'ALTER TABLE a RENAME COLUMN b TO c;',
      'ALTER TABLE a ALTER COLUMN b TYPE int;',
      'ALTER TABLE a ALTER COLUMN b SET NOT NULL;',
      'TRUNCATE a;',
      'DROP SCHEMA x;',
    ]) {
      expect(lintMigration(migration('m', sql))).toHaveLength(1);
    }
    expect(
      lintMigration(migration('contract', '-- cf:contract DEC-108\nALTER TABLE a DROP COLUMN b;')),
    ).toEqual([]);
  });

  it('tabela com tenant_id sem RLS ENABLE + FORCE e política é barrada', () => {
    const create =
      'CREATE TABLE "public"."processes" (\n  id uuid PRIMARY KEY,\n  "tenant_id" uuid NOT NULL\n);';
    const [finding] = lintMigration(migration('m', `-- nova\n${create}`));
    expect(finding).toMatchObject({ rule: 'tenant/rls', line: 2 });
    expect(finding?.message).toContain(
      'Tabela processes tem tenant_id sem ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY, CREATE POLICY',
    );
    const complete = [
      create,
      'ALTER TABLE "processes" ENABLE ROW LEVEL SECURITY;',
      'ALTER TABLE processes FORCE ROW LEVEL SECURITY;',
      `CREATE POLICY tenant_isolation ON processes USING (tenant_id = current_setting('app.tenant_id')::uuid);`,
    ].join('\n');
    expect(lintMigration(migration('m', complete))).toEqual([]);
    expect(lintMigration(migration('m', 'CREATE TABLE tenants (id uuid PRIMARY KEY);'))).toEqual(
      [],
    );
  });

  it('[Falha de integração] set_config de sessão bloqueia a migração (RN-FND-44)', () => {
    const findings = lintMigration(
      migration(
        'm',
        "-- set_config('app.tenant_id', x, false) em comentário não conta\nSELECT set_config('app.tenant_id', '1', false);",
      ),
    );
    expect(findings).toEqual([
      {
        level: 'error',
        file: 'apps/api/prisma/migrations/m/migration.sql',
        line: 2,
        rule: 'tenant/session-context',
        message: SESSION_CONTEXT_MESSAGE,
      },
    ]);
  });

  it('migração publicada não muda nem some; novas são as que a base não tem', () => {
    const published = [migration('001', 'a'), migration('002', 'b')];
    const current = [migration('001', 'a'), { ...migration('003', 'c') }];
    expect(checkPublished(published, current).map((item) => item.rule)).toEqual([
      'published/removed',
    ]);
    expect(
      checkPublished([migration('001', 'a')], [{ ...migration('001', 'a'), checksum: 'x' }]).map(
        (item) => item.rule,
      ),
    ).toEqual(['published/modified']);
    expect(newMigrations(published, current).map((item) => item.name)).toEqual(['003']);
  });

  it('checagens de catálogo: SQL por schema e violações legíveis', () => {
    expect(catalogChecksSql(['public', "o'k"])).toContain("n.nspname IN ('public', 'o''k')");
    expect(
      parseCatalogViolations('rls|public.a\nfk|public.b|b_fk\nunique|public.c|c_key\n'),
    ).toEqual([
      {
        kind: 'rls',
        table: 'public.a',
        message:
          'Migração bloqueada: tabela sem RLS — public.a tem tenant_id sem RLS ENABLE + FORCE e política.',
      },
      {
        kind: 'fk',
        table: 'public.b',
        object: 'b_fk',
        message: 'FK b_fk em public.b não inclui tenant_id (FK composta — DEC-081).',
      },
      {
        kind: 'unique',
        table: 'public.c',
        object: 'c_key',
        message: 'Unicidade c_key em public.c não inclui tenant_id.',
      },
    ]);
  });

  it('V-02: tenant_id nulo, tabela sem tenant_id e dono errado também são violações', () => {
    const sql = catalogChecksSql(['public']);
    // Partição herda a exceção da raiz (audit_logs_2026_10 — US-073).
    expect(sql).toContain("t.root_relname NOT IN ('audit_logs', 'outbox_events')");
    expect(sql).toContain('pg_partition_root(c.oid)');
    expect(sql).toContain(
      "c.relname NOT IN ('tenants', 'users', 'permissions', '_prisma_migrations')",
    );
    expect(sql).toContain("pg_get_userbyid(c.relowner) <> 'cf_owner'");
    expect(catalogChecksSql(['dev_seed'])).not.toContain('owner|');
    expect(
      parseCatalogViolations(
        'nullable|public.processes\nplatform|public.logs\nowner|public.processes|cf_app',
      ).map((violation) => violation.message),
    ).toEqual([
      'Tabela public.processes aceita tenant_id nulo fora da lista fechada de DEC-080 (V-02).',
      'Tabela public.logs sem tenant_id fora da lista fechada de tabelas de plataforma (DEC-080 · V-02).',
      'Tabela public.processes pertence a cf_app, não a cf_owner: crie os objetos depois de SET ROLE cf_owner (RN-FND-46).',
    ]);
  });
});

describe('traces do pós-deploy (RN-FND-28)', () => {
  it('traceparent W3C amostrado e URL de consulta do Tempo', () => {
    const context = newTraceContext((size) => Buffer.alloc(size, 0xab));
    expect(context.traceparent).toBe(`00-${'ab'.repeat(16)}-${'ab'.repeat(8)}-01`);
    expect(traceQueryUrl('https://tempo/api/traces/{traceId}', 'x')).toBe(
      'https://tempo/api/traces/x',
    );
    expect(traceQueryUrl('https://tempo/', 'x')).toBe('https://tempo/api/traces/x');
    expect(hasSpans({ batches: [{}] })).toBe(true);
    expect(hasSpans({ resourceSpans: [] })).toBe(false);
    expect(hasSpans(null)).toBe(false);
  });

  it('espera o trace aparecer e desiste no tempo limite', async () => {
    let calls = 0;
    let clock = 0;
    const found = await waitForTrace('u', {
      timeoutMs: 60_000,
      intervalMs: 5000,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      fetchJson: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('indexando'));
        return Promise.resolve(
          calls < 3 ? { status: 404, body: {} } : { status: 200, body: { batches: [1] } },
        );
      },
    });
    expect(found).toBe(true);
    expect(calls).toBe(3);
    clock = 0;
    const missing = await waitForTrace('u', {
      timeoutMs: 10_000,
      intervalMs: 5000,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      fetchJson: () => Promise.resolve({ status: 404, body: {} }),
    });
    expect(missing).toBe(false);
  });
});

describe('deploy no ECS', () => {
  it('nova revisão troca só a imagem do contêiner e remove campos somente leitura', () => {
    const next = withImage(
      {
        taskDefinitionArn: 'arn',
        revision: 3,
        family: 'cf-staging-api',
        containerDefinitions: [
          { name: 'api', image: 'old' },
          { name: 'otel', image: 'collector' },
        ],
      },
      'api',
      'repo@sha256:1',
    );
    expect(next).toEqual({
      family: 'cf-staging-api',
      containerDefinitions: [
        { name: 'api', image: 'repo@sha256:1' },
        { name: 'otel', image: 'collector' },
      ],
    });
    expect(() => withImage({ containerDefinitions: [] }, 'api', 'x')).toThrow(/api/);
  });

  it('lê os digests e mantém a ordem api/worker antes do web', () => {
    const digest = `1.dkr.ecr.sa-east-1.amazonaws.com/contrataflow-api@sha256:${'a'.repeat(64)}`;
    expect(parseDigests({ 'image-api/digest-api.txt': `${digest}\n`, 'x.txt': 'y' })).toEqual({
      api: digest,
    });
    expect(() => parseDigests({ 'digest-web.txt': 'repo:latest' })).toThrow(/digest inválido/);
    expect(ROLLOUT).toEqual([['api', 'worker'], ['web']]);
  });
});

describe('aplicação de migrações (Gherkin "[Falha de banco]")', () => {
  it('para na primeira falha e devolve o erro nativo do PostgreSQL', async () => {
    const executed: string[] = [];
    const result = await applyMigrations(
      {
        psql: (sql) => {
          executed.push(sql);
          return Promise.resolve(
            sql.includes('quebrada')
              ? { ok: false, stdout: '', stderr: 'ERROR:  column "x" does not exist' }
              : { ok: true, stdout: '', stderr: '' },
          );
        },
      },
      [migration('001', 'ok;'), migration('002', 'quebrada;'), migration('003', 'nunca;')],
      'cf_snapshot',
    );
    expect(result.ok).toBe(false);
    expect(result.applied).toEqual(['001']);
    expect(result.failed?.migration.name).toBe('002');
    expect(result.failed?.error).toBe('ERROR:  column "x" does not exist');
    expect(executed).toHaveLength(2);
  });
});
