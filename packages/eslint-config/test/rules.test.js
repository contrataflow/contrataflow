import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterAll, describe, it } from 'vitest';

import { plugin } from '../plugin/index.js';
import { matchesModule } from '../plugin/rules/restricted-module.js';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2024,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const rules = plugin.rules;

tester.run('no-unsafe-raw-query', rules['no-unsafe-raw-query'], {
  valid: [
    'await prisma.$queryRaw`SELECT 1 WHERE id = ${id}`',
    'await tx.$executeRaw`UPDATE t SET a = ${a}`',
    'obj[name]()',
  ],
  invalid: [
    {
      code: 'await prisma.$queryRawUnsafe(sql)',
      errors: [{ messageId: 'forbidden', data: { api: '$queryRawUnsafe' } }],
    },
    {
      code: "await prisma['$executeRawUnsafe'](sql)",
      errors: [{ messageId: 'forbidden', data: { api: '$executeRawUnsafe' } }],
    },
    {
      code: 'await prisma[`$queryRawUnsafe`](sql)',
      errors: [{ messageId: 'forbidden', data: { api: '$queryRawUnsafe' } }],
    },
    {
      code: 'const { $queryRawUnsafe } = prisma',
      errors: [{ messageId: 'forbidden', data: { api: '$queryRawUnsafe' } }],
    },
  ],
});

tester.run('no-console', rules['no-console'], {
  valid: ['logger.log("ok")', 'const console = { log() {} }; console.log("local")'],
  invalid: [
    { code: 'console.log("x")', errors: [{ messageId: 'forbidden', data: { method: 'log' } }] },
    {
      code: 'console["error"]("x")',
      errors: [{ messageId: 'forbidden', data: { method: 'error' } }],
    },
    { code: 'const c = console', errors: [{ messageId: 'forbidden', data: { method: '*' } }] },
  ],
});

tester.run('no-process-env', rules['no-process-env'], {
  valid: ['config.env.PORT', 'process.cwd()'],
  invalid: [
    { code: 'process.env.DATABASE_URL', errors: [{ messageId: 'forbidden' }] },
    { code: "process['env']", errors: [{ messageId: 'forbidden' }] },
    { code: 'const { env } = process', errors: [{ messageId: 'forbidden' }] },
    { code: "import { env } from 'node:process'", errors: [{ messageId: 'forbidden' }] },
    { code: "import { env as e } from 'process'", errors: [{ messageId: 'forbidden' }] },
  ],
});

tester.run('no-dynamic-code', rules['no-dynamic-code'], {
  valid: [
    'setTimeout(() => run(), 10)',
    'const fn = new Map()',
    'function f(eval2) { return eval2 }',
    'class Function2 {}',
    'const x = Function.prototype',
  ],
  invalid: [
    { code: 'eval(code)', errors: [{ messageId: 'forbidden', data: { api: 'eval' } }] },
    {
      code: 'new Function("a", "return a")',
      errors: [{ messageId: 'forbidden', data: { api: 'new Function' } }],
    },
    {
      code: 'Function("return 1")()',
      errors: [{ messageId: 'forbidden', data: { api: 'Function()' } }],
    },
    {
      code: 'globalThis.eval(code)',
      errors: [{ messageId: 'forbidden', data: { api: 'globalThis.eval' } }],
    },
    {
      code: 'setTimeout("run()", 10)',
      errors: [{ messageId: 'forbidden', data: { api: 'setTimeout com string' } }],
    },
    {
      code: 'setInterval(`tick()`, 10)',
      errors: [{ messageId: 'forbidden', data: { api: 'setInterval com string' } }],
    },
  ],
});

tester.run('no-dangerous-html', rules['no-dangerous-html'], {
  valid: ['const el = <div className="a">{text}</div>'],
  invalid: [
    {
      code: 'const el = <div dangerouslySetInnerHTML={{ __html: html }} />',
      errors: [{ messageId: 'forbidden' }],
    },
    {
      code: "createElement('div', { dangerouslySetInnerHTML: { __html: html } })",
      errors: [{ messageId: 'forbidden' }],
    },
  ],
});

tester.run('require-server-only', rules['require-server-only'], {
  valid: ["import 'server-only';\nexport const x = 1;"],
  invalid: [
    { code: 'export const token = 1;', errors: [{ messageId: 'missing' }] },
    { code: "import { x } from 'server-only';", errors: [{ messageId: 'missing' }] },
  ],
});

tester.run('no-direct-redis', rules['no-direct-redis'], {
  valid: [
    "import { TenantCache } from '#shared/cache/tenant-cache.js'",
    "import x from 'redis-like'",
  ],
  invalid: [
    {
      code: "import Redis from 'ioredis'",
      errors: [{ messageId: 'forbidden', data: { module: 'ioredis' } }],
    },
    {
      code: "import { createClient } from '@redis/client'",
      errors: [{ messageId: 'forbidden', data: { module: '@redis/client' } }],
    },
    {
      code: "export { default } from 'redis'",
      errors: [{ messageId: 'forbidden', data: { module: 'redis' } }],
    },
    {
      code: "export * from 'iovalkey'",
      errors: [{ messageId: 'forbidden', data: { module: 'iovalkey' } }],
    },
    {
      code: "const m = await import('ioredis')",
      errors: [{ messageId: 'forbidden', data: { module: 'ioredis' } }],
    },
    {
      code: "const Redis = require('ioredis')",
      errors: [{ messageId: 'forbidden', data: { module: 'ioredis' } }],
    },
  ],
});

tester.run('no-prisma-outside-infrastructure', rules['no-prisma-outside-infrastructure'], {
  valid: ["import { z } from 'zod'", "export { a } from './local.js'"],
  invalid: [
    {
      code: "import { PrismaClient } from '@prisma/client'",
      errors: [{ messageId: 'forbidden', data: { module: '@prisma/client' } }],
    },
    {
      code: "import type { Process } from '@prisma/client'",
      errors: [{ messageId: 'forbidden', data: { module: '@prisma/client' } }],
    },
    {
      code: "import { Prisma } from '@prisma/client/runtime/library'",
      errors: [{ messageId: 'forbidden', data: { module: '@prisma/client/runtime/library' } }],
    },
    {
      code: "import Prisma = require('@prisma/client')",
      errors: [{ messageId: 'forbidden', data: { module: '@prisma/client' } }],
    },
  ],
});

tester.run('no-prisma-client-outside-database', rules['no-prisma-client-outside-database'], {
  valid: [
    "import type { TenantTx } from '#shared/database/prisma.js'",
    "import { Prisma } from '#shared/database/prisma.js'",
    "import { TenantTransaction } from '#shared/database/database.module.js'",
    "import { PrismaClient } from '@prisma/client'",
  ],
  invalid: [
    {
      code: "import { PrismaClient } from '#shared/database/generated/prisma/client.js'",
      errors: [
        {
          messageId: 'forbidden',
          data: { module: '#shared/database/generated/prisma/client.js' },
        },
      ],
    },
    {
      code: "import { createTenantPrismaClient } from '#shared/database/prisma-client.js'",
      errors: [{ messageId: 'forbidden', data: { module: '#shared/database/prisma-client.js' } }],
    },
    {
      code: "import { PrismaPg } from '@prisma/adapter-pg'",
      errors: [{ messageId: 'forbidden', data: { module: '@prisma/adapter-pg' } }],
    },
    {
      code: "import pg from 'pg'",
      errors: [{ messageId: 'forbidden', data: { module: 'pg' } }],
    },
  ],
});

describe('matchesModule', () => {
  it('compara nomes exatos, subcaminhos e prefixos com /*', ({ expect }) => {
    expect(matchesModule('ioredis', ['ioredis'])).toBe(true);
    expect(matchesModule('ioredis/built/x', ['ioredis'])).toBe(true);
    expect(matchesModule('ioredis-mock', ['ioredis'])).toBe(false);
    expect(matchesModule('@redis/json', ['@redis/*'])).toBe(true);
    expect(matchesModule('@redisx/json', ['@redis/*'])).toBe(false);
  });
});
