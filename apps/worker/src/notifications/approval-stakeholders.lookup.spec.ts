import type { DomainEventEnvelope } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';

import { ApprovalStakeholdersLookup } from './approval-stakeholders.lookup.js';

/* US-052 — destinatários de `APPROVAL_DECIDED` (o SQL roda no PostgreSQL em
 * test/tenant-leak/approval-stakeholders.spec.ts; aqui, os parâmetros e o evento sem aprovação). */

const APPROVAL = '0192f052-0000-7000-8000-0000000000a1';
const ANA = '0192f052-0000-7000-8000-0000000000c1';
const JULIANA = '0192f052-0000-7000-8000-0000000000c2';

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

describe('ApprovalStakeholdersLookup (US-052 · APPROVAL_STAKEHOLDERS)', () => {
  const lookup = new ApprovalStakeholdersLookup();

  it('solicitante e responsáveis dos documentos cobertos da aprovação do evento', async () => {
    const { client, params } = clientWith([{ user_id: ANA }, { user_id: JULIANA }]);
    expect(lookup.lookup).toBe('APPROVAL_STAKEHOLDERS');
    await expect(lookup.resolve(client, event({ approvalId: APPROVAL }))).resolves.toEqual([
      ANA,
      JULIANA,
    ]);
    expect(params).toEqual([[APPROVAL]]);
  });

  it('evento sem aprovação não consulta nada', async () => {
    const { client, params } = clientWith([]);
    await expect(lookup.resolve(client, event({}))).resolves.toEqual([]);
    expect(params).toEqual([]);
  });
});
