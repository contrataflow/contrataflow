// Fronteiras de dependência do monorepo (RN-FND-05 · DEC-041 · architecture.md §4.3–§4.4).
// Executado por `pnpm depcruise` (gate no CI — US-079). Cada regra tem uma fixture de violação
// em tools/fixtures/depcruise/** verificada pelos testes de @contrataflow/tools.
// Alterações exigem revisão do Tech Lead + segurança (CODEOWNERS).
const moduleLevels = require('./tools/module-levels.json');

const API_MODULES = '^apps/api/src/modules/';
const INFRA_LIBS = '(@nestjs|@prisma|\\.prisma|ioredis|bullmq|@aws-sdk)';
const REDIS_LIBS = '(ioredis|redis|@redis/[^/]+|iovalkey)';

/** Caminho de um pacote externo, resolvido (node_modules) ou não. */
function externalPath(libs) {
  return `(^|/)node_modules/${libs}(/|$)|^${libs}(/|$)`;
}

/** Regras geradas de tools/module-levels.json: só fachadas de nível inferior. */
function moduleLevelRules() {
  const levelOf = new Map(
    moduleLevels.levels.flatMap(({ level, modules }) => modules.map((name) => [name, level])),
  );
  const allowed = new Set(moduleLevels.allow.map(([from, to]) => `${from}->${to}`));
  const rules = [];
  for (const [name, level] of levelOf) {
    const forbiddenTargets = [...levelOf]
      .filter(([other, otherLevel]) => other !== name && otherLevel >= level)
      .filter(([other]) => !allowed.has(`${name}->${other}`))
      .map(([other]) => other);
    if (forbiddenTargets.length === 0) continue;
    rules.push({
      name: 'module-levels',
      severity: 'error',
      comment: `O módulo "${name}" (nível ${level}) só pode depender de módulos de nível inferior; use eventos de domínio ou portas no sentido contrário (architecture.md §3.3).`,
      from: { path: `${API_MODULES}${name}/` },
      to: { path: `${API_MODULES}(${forbiddenTargets.join('|')})/` },
    });
  }
  return rules;
}

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Dependências circulares são proibidas, inclusive entre fachadas (DEC-041).',
      from: {},
      to: { circular: true },
    },
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment:
        'O domain não depende de NestJS, Prisma, Redis, BullMQ, SDKs de nuvem nem de application/infrastructure/presentation (DEC-041).',
      from: { path: `${API_MODULES}[^/]+/domain/` },
      to: {
        path: [
          externalPath(INFRA_LIBS),
          `${API_MODULES}[^/]+/(application|infrastructure|presentation)/`,
        ],
      },
    },
    {
      name: 'cross-module-only-via-facade',
      severity: 'error',
      comment:
        'Outro módulo só é acessado por application/<módulo>.facade.ts, application/dto/** ou <módulo>.module.ts (DEC-041).',
      from: { path: `${API_MODULES}([^/]+)/` },
      to: {
        path: `${API_MODULES}[^/]+/`,
        pathNot: [
          `${API_MODULES}$1/`,
          `${API_MODULES}[^/]+/application/([^/]+\\.facade\\.ts|dto/)`,
          `${API_MODULES}[^/]+/[^/]+\\.module\\.ts$`,
        ],
      },
    },
    ...moduleLevelRules(),
    {
      name: 'shared-kernel-is-independent',
      severity: 'error',
      comment: 'O shared kernel (nível 0) nunca importa módulos (architecture.md §3.3).',
      from: { path: '^apps/api/src/shared/' },
      to: { path: API_MODULES },
    },
    {
      name: 'redis-only-in-cache-or-platform',
      severity: 'error',
      comment:
        'Clientes Redis só em shared/cache/** e modules/platform/**; use o TenantCache, que isola as chaves por tenant (RM-03).',
      from: {
        path: '^apps/(api|worker)/src/',
        pathNot: '^apps/(api|worker)/src/(shared/cache|modules/platform)/',
      },
      to: { path: externalPath(REDIS_LIBS) },
    },
    {
      name: 'system-prisma-allowlist',
      severity: 'error',
      comment:
        'O SystemDbService (papel cf_platform — RN-TEN-28) só é usado pelos adaptadores de tenancy (provisionamento e ciclo de vida), identity (vínculos e convites entre tenants) e audit (auditoria de plataforma), pelos schedulers do worker e pelos testes de banco (US-100 · multi-tenancy.md §5.3).',
      from: {
        pathNot: [
          '^apps/api/src/modules/(tenancy|identity|audit)/infrastructure/',
          '^apps/worker/src/(outbox|schedulers)/',
          '^apps/api/src/shared/database/',
          '^apps/api/test/(database|tenant-leak)/',
        ],
      },
      to: { path: 'shared/database/system-(prisma|db)\\.service\\.ts$' },
    },
    {
      name: 'platform-transaction-allowlist',
      severity: 'error',
      comment:
        'Transação sem app.tenant_id (users, tenants, cf_user_memberships) só nos adaptadores de identity/tenancy do pipeline de autenticação e do início de sessão (US-087 · multi-tenancy.md §6) e nos da auditoria de plataforma e das partições de audit_logs (US-073 · DEC-071).',
      from: {
        pathNot: [
          '^apps/api/src/modules/(identity|tenancy|audit)/infrastructure/',
          '^apps/api/src/shared/database/',
          '^apps/api/test/(database|audit|tenant-leak)/',
        ],
      },
      to: { path: 'shared/database/platform-transaction\\.ts$' },
    },
    {
      name: 'worker-never-loads-presentation',
      severity: 'error',
      comment: 'O worker nunca carrega controllers da API (DEC-052).',
      from: { path: '^apps/worker/' },
      to: { path: `${API_MODULES}[^/]+/presentation/` },
    },
    {
      name: 'worker-only-api-allowed-paths',
      severity: 'error',
      comment:
        'O worker só importa domain/application/infrastructure, *.module.ts e src/shared da API (architecture.md §4.3).',
      from: { path: '^apps/worker/' },
      to: {
        path: '^apps/api/',
        pathNot: [
          `${API_MODULES}[^/]+/(domain|application|infrastructure)/`,
          `${API_MODULES}[^/]+/[^/]+\\.module\\.ts$`,
          '^apps/api/src/shared/',
        ],
      },
    },
    {
      name: 'web-never-imports-api',
      severity: 'error',
      comment: 'O web fala com a API somente por HTTP, via BFF (DEC-053).',
      from: { path: '^apps/web/' },
      to: { path: '^apps/(api|worker)/' },
    },
    {
      name: 'api-never-imports-ui-web-worker',
      severity: 'error',
      comment: 'A API não importa o design system, o web nem o worker (architecture.md §4.3).',
      from: { path: '^apps/api/' },
      to: { path: '^(packages/ui|apps/(web|worker))/' },
    },
    {
      name: 'worker-never-imports-ui-web',
      severity: 'error',
      comment: 'O worker não importa o design system nem o web (architecture.md §4.3).',
      from: { path: '^apps/worker/' },
      to: { path: '^(packages/ui|apps/web)/' },
    },
    {
      name: 'types-imports-nothing-internal',
      severity: 'error',
      comment: 'packages/types não importa nenhum pacote interno (architecture.md §4.3).',
      from: { path: '^packages/types/' },
      to: { path: '^(packages|apps)/', pathNot: '^packages/types/' },
    },
    {
      name: 'validation-only-types',
      severity: 'error',
      comment: 'packages/validation só importa packages/types (architecture.md §4.3).',
      from: { path: '^packages/validation/' },
      to: { path: '^(packages|apps)/', pathNot: '^packages/(validation|types)/' },
    },
    {
      name: 'editor-only-types-validation',
      severity: 'error',
      comment:
        'packages/editor só importa packages/types e packages/validation (architecture.md §4.3).',
      from: { path: '^packages/editor/' },
      to: { path: '^(packages|apps)/', pathNot: '^packages/(editor|types|validation)/' },
    },
    {
      name: 'ui-only-types',
      severity: 'error',
      comment: 'packages/ui só importa packages/types (architecture.md §4.3).',
      from: { path: '^packages/ui/' },
      to: { path: '^(packages|apps)/', pathNot: '^packages/(ui|types)/' },
    },
    {
      name: 'observability-only-types',
      severity: 'error',
      comment:
        'packages/observability (logs, correlação e tracing — US-084) só importa packages/types (architecture.md §4.3).',
      from: { path: '^packages/observability/' },
      to: { path: '^(packages|apps)/', pathNot: '^packages/(observability|types)/' },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: 'Import que não resolve (dependência ausente ou alias sem mapeamento).',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Arquivos de ferramentas (configs de ESLint/Vitest/Next, pacotes de configuração) não são
    // código de produto e ficam fora das fronteiras.
    exclude: {
      path: [
        '(^|/)(node_modules|dist|\\.next|\\.turbo|coverage)/',
        '^tools/',
        '^packages/(eslint-config|tsconfig)/',
        '(^|/)[^/]+\\.config\\.[cm]?[jt]s$',
        // Cliente Prisma gerado (US-081): ciclos internos do gerador, fora das fronteiras.
        '/shared/database/generated/',
      ],
    },
    tsPreCompilationDeps: true,
    // Alias `@/*` → `apps/web/src/*` do web (US-077); API e worker usam subpath imports (`#…`).
    tsConfig: { fileName: require('node:path').join(__dirname, 'depcruise.tsconfig.json') },
    combinedDependencies: false,
    preserveSymlinks: false,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['types', 'import', 'require', 'node', 'default'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
