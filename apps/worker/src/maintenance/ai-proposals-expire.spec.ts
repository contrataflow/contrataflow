import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';

import { AiProposalsExpireTask } from './ai-proposals-expire.js';

const TENANT = '0192d115-0000-7000-8000-00000000000a';
const NOW = new Date('2026-10-23T12:00:00.000Z');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ai-proposals-expire (US-115 · RN-AI-11)', () => {
  it('vence só as SUCCEEDED do tenant com expires_at passado, mantendo o conteúdo', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const client: SqlClient = {
      query: (sql, params = []) => {
        calls.push({ sql, params });
        return Promise.resolve({ rows: [], rowCount: 3 });
      },
    };
    const result = await new AiProposalsExpireTask(() => NOW).run(client, TENANT);
    expect(result).toEqual({ expired: 3 });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.params).toEqual([TENANT, NOW]);
    expect(call?.sql).toMatch(/SET status = 'EXPIRED'/);
    expect(call?.sql).toMatch(/status = 'SUCCEEDED' AND expires_at <= \$2/);
    expect(call?.sql).toMatch(/tenant_id = \$1/);
    // Não apaga nem limpa a proposta (rastreabilidade).
    expect(call?.sql).not.toMatch(/output|DELETE/i);
  });

  it('sem linhas afetadas: conta zero', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const client: SqlClient = { query: () => Promise.resolve({ rows: [], rowCount: null }) };
    await expect(new AiProposalsExpireTask(() => NOW).run(client, TENANT)).resolves.toEqual({
      expired: 0,
    });
  });
});
