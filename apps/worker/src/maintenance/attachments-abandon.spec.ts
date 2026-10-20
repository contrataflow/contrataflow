import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';

import { AttachmentsAbandonTask } from './attachments-abandon.js';

const TENANT = '0192d068-0000-7000-8000-00000000000a';
const NOW = new Date('2026-10-18T12:00:00.000Z');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('attachments-abandon (US-068 · RN-DOC-78)', () => {
  it('intenções PENDING_UPLOAD do tenant com mais de 24 h viram DELETED com o motivo de sistema', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const client: SqlClient = {
      query: (sql, params = []) => {
        calls.push({ sql, params });
        return Promise.resolve({ rows: [], rowCount: 2 });
      },
    };
    const result = await new AttachmentsAbandonTask(() => NOW).run(client, TENANT);
    expect(result).toEqual({ abandoned: 2 });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.params).toEqual([
      TENANT,
      NOW,
      new Date('2026-10-17T12:00:00.000Z'),
      'Upload não concluído',
    ]);
    expect(call?.sql).toMatch(/SET status = 'DELETED'/);
    expect(call?.sql).toMatch(/status = 'PENDING_UPLOAD'/);
    expect(call?.sql).toMatch(/tenant_id = \$1/);
  });
});
