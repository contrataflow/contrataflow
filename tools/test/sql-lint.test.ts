import { describe, expect, it } from 'vitest';

import {
  callArguments,
  lintRepository,
  lintSessionContext,
  SESSION_CONTEXT_MESSAGE,
  sqlLintTargets,
} from '../ci/lib/sql-lint.js';
import { REPO_ROOT } from '../lib/workspace.js';

const lines = (file: string, text: string) =>
  lintSessionContext(file, text).map((finding) => finding.line);

describe('lint de SQL: contexto de tenant só por transação (US-081 — RN-FND-44 · V-05)', () => {
  it('[Falha de integração] set_config(…, false) numa migração é barrado com a mensagem do CI', () => {
    const [finding] = lintSessionContext(
      'apps/api/prisma/migrations/x/migration.sql',
      "CREATE TABLE a (id int);\nSELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', false);",
    );
    expect(finding).toEqual({
      file: 'apps/api/prisma/migrations/x/migration.sql',
      line: 2,
      rule: 'tenant/session-context',
      message: SESSION_CONTEXT_MESSAGE,
    });
    expect(finding?.message).toContain('Migração bloqueada: contexto de sessão proibido.');
  });

  it('terceiro argumento diferente do literal true também é barrado (dinâmico ou string)', () => {
    expect(lines('a.sql', "SELECT set_config('app.tenant_id', '1', 'false');")).toEqual([1]);
    expect(
      lines('a.ts', "tx.$executeRaw`SELECT set_config('app.tenant_id', ${id}, ${local})`"),
    ).toEqual([1]);
    expect(lines('a.sql', "SELECT SET_CONFIG ( 'app.x' , upper('a,b') , FALSE )")).toEqual([1]);
  });

  it('SET de sessão de variáveis app.* é barrado; SET LOCAL e outros SET não', () => {
    expect(lines('a.sql', "SET app.tenant_id = '1';\nSET SESSION app.user_id TO '2';")).toEqual([
      1, 2,
    ]);
    expect(
      lines('a.sql', "SET LOCAL app.tenant_id = '1';\nSET ROLE cf_owner;\nSET search_path TO x;"),
    ).toEqual([]);
  });

  it('escopo de transação, comentários SQL e citações em texto passam', () => {
    expect(
      lines(
        'a.ts',
        "tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('statement_timeout', ${t}, true)`",
      ),
    ).toEqual([]);
    expect(lines('a.sql', "-- nunca: SELECT set_config('app.tenant_id', '1', false);")).toEqual([]);
    expect(lines('a.ts', '// RN-FND-44 proíbe set_config(…, false)')).toEqual([]);
  });

  it('callArguments respeita aspas, parênteses e interpolações', () => {
    const text = "set_config('a,b', coalesce(x, 'y'), ${f(1, 2)}) resto";
    expect(callArguments(text, 'set_config('.length)).toEqual([
      "'a,b'",
      "coalesce(x, 'y')",
      '${f(1, 2)}',
    ]);
    expect(callArguments("set_config('aberta", 'set_config('.length)).toBeNull();
    expect(callArguments('set_config(a, b', 'set_config('.length)).toBeNull();
  });

  it('o repositório está limpo e as migrações e o código das apps são verificados', () => {
    const targets = sqlLintTargets(REPO_ROOT);
    expect(targets).toEqual(
      expect.arrayContaining([
        'apps/api/src/shared/database/tenant-transaction.ts',
        'infra/postgres/init/20-contrataflow-extensions.sql',
      ]),
    );
    expect(targets.some((file) => file.startsWith('apps/api/prisma/migrations/'))).toBe(true);
    expect(targets.some((file) => file.includes('/generated/'))).toBe(false);
    expect(lintRepository(REPO_ROOT)).toEqual([]);
  });
});
