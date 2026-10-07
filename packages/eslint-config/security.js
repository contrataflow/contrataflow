import { plugin } from './plugin/index.js';

/** Arquivos de código verificados pelas proibições de segurança. */
export const CODE_FILES = ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'];

/**
 * Únicos caminhos em que cada API proibida é permitida (RN-FND-06).
 * Alterar exige revisão do Tech Lead + segurança (CODEOWNERS de packages/eslint-config).
 */
export const SECURITY_ALLOWLISTS = Object.freeze({
  /** Módulo de configuração (US-080) e arquivos de configuração de ferramentas. */
  processEnv: ['**/src/config/**', '**/*.config.{ts,mts,cts,js,mjs,cjs}'],
  /** Wrapper TenantCache e infraestrutura de plataforma (RM-03). */
  redis: ['**/shared/cache/**', '**/modules/platform/**'],
  /** Repositórios Prisma e shared kernel de banco (DEC-041). */
  prisma: ['**/infrastructure/**', '**/shared/database/**'],
  /** Componente de pré-visualização sanitizada (DEC-056). */
  dangerousHtml: ['**/sanitized-html-preview.tsx'],
  /** Arquivos de configuração de ferramentas (os scripts de tools/ desligam a regra no próprio pacote). */
  console: ['**/*.config.{ts,mts,cts,js,mjs,cjs}'],
});

/** Arquivos do BFF que exigem `import 'server-only'`. */
export const BFF_FILES = ['**/src/bff/**/*.{ts,tsx}'];

/**
 * Proibições de segurança da RN-FND-06 (todas com severidade `error`).
 * Independe de informação de tipos: roda também sobre as fixtures de violação.
 * @returns {import('eslint').Linter.Config[]}
 */
export function security() {
  return [
    { name: 'contrataflow/security/plugin', plugins: { contrataflow: plugin } },
    {
      name: 'contrataflow/security/always',
      files: CODE_FILES,
      rules: {
        'contrataflow/no-unsafe-raw-query': 'error',
        'contrataflow/no-dynamic-code': 'error',
      },
    },
    {
      name: 'contrataflow/security/console',
      files: CODE_FILES,
      ignores: SECURITY_ALLOWLISTS.console,
      rules: { 'contrataflow/no-console': 'error' },
    },
    {
      name: 'contrataflow/security/process-env',
      files: CODE_FILES,
      ignores: SECURITY_ALLOWLISTS.processEnv,
      rules: { 'contrataflow/no-process-env': 'error' },
    },
    {
      name: 'contrataflow/security/redis',
      files: CODE_FILES,
      ignores: SECURITY_ALLOWLISTS.redis,
      rules: { 'contrataflow/no-direct-redis': 'error' },
    },
    {
      name: 'contrataflow/security/prisma',
      files: CODE_FILES,
      ignores: SECURITY_ALLOWLISTS.prisma,
      rules: { 'contrataflow/no-prisma-outside-infrastructure': 'error' },
    },
    {
      name: 'contrataflow/security/dangerous-html',
      files: CODE_FILES,
      ignores: SECURITY_ALLOWLISTS.dangerousHtml,
      rules: { 'contrataflow/no-dangerous-html': 'error' },
    },
    {
      name: 'contrataflow/security/bff-server-only',
      files: BFF_FILES,
      rules: { 'contrataflow/require-server-only': 'error' },
    },
  ];
}
