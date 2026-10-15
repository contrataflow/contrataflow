import { noConsole } from './rules/no-console.js';
import { noDangerousHtml } from './rules/no-dangerous-html.js';
import { noDynamicCode } from './rules/no-dynamic-code.js';
import { noProcessEnv } from './rules/no-process-env.js';
import { noUnsafeRawQuery } from './rules/no-unsafe-raw-query.js';
import { requireServerOnly } from './rules/require-server-only.js';
import { createRestrictedModuleRule } from './rules/restricted-module.js';
import { GUIDE } from './rules/utils.js';

/** Clientes Redis/Valkey: só em shared/cache/** e modules/platform/** (RM-03). */
export const REDIS_MODULES = Object.freeze(['ioredis', 'redis', '@redis/*', 'iovalkey']);

/** Cliente Prisma: só em infrastructure/** e shared/database/**. */
export const PRISMA_MODULES = Object.freeze(['@prisma/client', '.prisma/client']);

/**
 * Construção do `PrismaClient` e conexões diretas: só em shared/database/** (RN-FND-43). Os
 * repositórios recebem o `tx` da `TenantTransaction` e importam tipos de `#shared/database/prisma.js`.
 */
export const PRISMA_CLIENT_MODULES = Object.freeze([
  '#shared/database/generated/*',
  '#shared/database/prisma-client.js',
  '@prisma/adapter-pg',
  'pg',
]);

/** Plugin local `contrataflow` — proibições de segurança da RN-FND-06. */
export const plugin = {
  meta: { name: '@contrataflow/eslint-plugin', version: '0.0.0' },
  rules: {
    'no-unsafe-raw-query': noUnsafeRawQuery,
    'no-console': noConsole,
    'no-process-env': noProcessEnv,
    'no-dynamic-code': noDynamicCode,
    'no-dangerous-html': noDangerousHtml,
    'require-server-only': requireServerOnly,
    'no-direct-redis': createRestrictedModuleRule({
      description: 'Proíbe clientes Redis fora de shared/cache/** e modules/platform/** (RM-03).',
      modules: REDIS_MODULES,
      message: `Uso proibido: import de {{module}} fora de shared/cache/** e modules/platform/**. Use o TenantCache, que isola as chaves por tenant (RM-03). ${GUIDE}`,
    }),
    'no-prisma-outside-infrastructure': createRestrictedModuleRule({
      description: 'Proíbe @prisma/client fora de infrastructure/** e shared/database/**.',
      modules: PRISMA_MODULES,
      message: `Uso proibido: import de {{module}} fora de infrastructure/** e shared/database/**. Acesse os dados pelo repositório do módulo (interface no domain, implementação Prisma no infrastructure). ${GUIDE}`,
    }),
    'no-prisma-client-outside-database': createRestrictedModuleRule({
      description:
        'Proíbe instanciar o PrismaClient ou abrir conexão fora de shared/database/** (RN-FND-43).',
      modules: PRISMA_CLIENT_MODULES,
      message: `Uso proibido: import de {{module}} fora de shared/database/**. Todo acesso a dados passa pela TenantTransaction (app.tenant_id por transação); o repositório recebe o tx e importa tipos de #shared/database/prisma.js. ${GUIDE}`,
    }),
  },
};

export default plugin;
