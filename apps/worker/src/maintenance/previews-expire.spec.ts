import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';

import { PreviewsExpireTask } from './previews-expire.js';

const TENANT = '0192d067-0000-7000-8000-00000000000a';
const NOW = new Date('2026-10-18T06:00:00.000Z');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('previews-expire (US-067 · RN-DOC-68)', () => {
  it('vence só as prévias do tenant com expires_at passado (nunca CONTENT nem as já encerradas)', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const client: SqlClient = {
      query: (sql, params = []) => {
        calls.push({ sql, params });
        return Promise.resolve({ rows: [], rowCount: 2 });
      },
    };
    const task = new PreviewsExpireTask(() => NOW);
    expect(task.name).toBe('previews-expire');
    await expect(task.run(client, TENANT)).resolves.toEqual({ expired: 2 });
    const [call] = calls;
    expect(call?.params).toEqual([TENANT, NOW]);
    expect(call?.sql).toMatch(/SET status = 'EXPIRED'/);
    expect(call?.sql).toMatch(/kind = 'PREVIEW'/);
    expect(call?.sql).toMatch(/NOT IN \('EXPIRED', 'FAILED'\)/);
    expect(call?.sql).toMatch(/expires_at <= \$2/);
    expect(call?.sql).toMatch(/tenant_id = \$1/);
    expect(call?.sql).not.toMatch(/DELETE/i);
  });

  it('sem linhas afetadas: conta zero', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const client: SqlClient = { query: () => Promise.resolve({ rows: [], rowCount: null }) };
    await expect(new PreviewsExpireTask(() => NOW).run(client, TENANT)).resolves.toEqual({
      expired: 0,
    });
  });
});
