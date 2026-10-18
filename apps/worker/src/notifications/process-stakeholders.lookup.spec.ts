import type { DomainEventEnvelope } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';

import { ProcessStakeholdersLookup } from './process-stakeholders.lookup.js';

/* US-008 — destinatários de `PROCESS_STATUS_CHANGED` (o SQL roda no PostgreSQL em
 * test/tenant-leak/process-stakeholders.spec.ts; aqui, os parâmetros e o processo ausente). */

const PROCESS = '0192f008-0000-7000-8000-0000000000b1';
const ANA = '0192f008-0000-7000-8000-0000000000c1';
const JULIANA = '0192f008-0000-7000-8000-0000000000c2';
const NOW = new Date('2026-10-06T13:00:00.000Z');

const event = (processId: string | null = PROCESS) =>
  ({ processId, payload: {} }) as unknown as DomainEventEnvelope<Record<string, unknown>>;

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

describe('ProcessStakeholdersLookup (US-008 · PROCESS_STAKEHOLDERS)', () => {
  const lookup = new ProcessStakeholdersLookup(() => NOW);

  it('criador, responsável e participantes com notify do processo do evento, no instante', async () => {
    const { client, params } = clientWith([{ user_id: ANA }, { user_id: JULIANA }]);
    expect(lookup.lookup).toBe('PROCESS_STAKEHOLDERS');
    await expect(lookup.resolve(client, event())).resolves.toEqual([ANA, JULIANA]);
    expect(params).toEqual([[PROCESS, NOW]]);
  });

  it('evento sem processo não consulta nada', async () => {
    const { client, params } = clientWith([]);
    await expect(lookup.resolve(client, event(null))).resolves.toEqual([]);
    expect(params).toEqual([]);
  });
});
