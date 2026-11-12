import type { DomainEventEnvelope } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';

import { ApprovalRequesterLookup } from './approval-requester.lookup.js';

/* US-134 — destinatário de `APPROVAL_VOTE_RECORDED`: o solicitante da aprovação do evento. */

const APPROVAL = '0192f134-0000-7000-8000-0000000000a1';
const ANA = '0192f134-0000-7000-8000-0000000000c1';

const event = (payload: Record<string, unknown>) =>
  ({ processId: null, payload }) as unknown as DomainEventEnvelope<Record<string, unknown>>;

function clientWith(rows: readonly unknown[]): { client: SqlClient; params: unknown[][] } {
  const params: unknown[][] = [];
  const client: SqlClient = {
    query: (_sql, values = []) => {
      params.push([...values]);
      return Promise.resolve({ rows: rows as never[], rowCount: rows.length });
    },
  };
  return { client, params };
}

describe('ApprovalRequesterLookup (US-134 · APPROVAL_REQUESTER)', () => {
  const lookup = new ApprovalRequesterLookup();

  it('o solicitante da aprovação do evento', async () => {
    const { client, params } = clientWith([{ user_id: ANA }]);
    expect(lookup.lookup).toBe('APPROVAL_REQUESTER');
    await expect(lookup.resolve(client, event({ approvalId: APPROVAL }))).resolves.toEqual([ANA]);
    expect(params).toEqual([[APPROVAL]]);
  });

  it('evento sem aprovação não consulta nada', async () => {
    const { client, params } = clientWith([]);
    await expect(lookup.resolve(client, event({}))).resolves.toEqual([]);
    expect(params).toEqual([]);
  });
});
