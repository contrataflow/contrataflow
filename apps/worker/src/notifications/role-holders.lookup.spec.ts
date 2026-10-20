import type { DomainEventEnvelope } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';

import { RoleHoldersLookup } from './role-holders.lookup.js';

/* US-051 — destinatários de `APPROVAL_REQUESTED` para aprovador `ROLE` (o SQL roda no PostgreSQL em
 * test/tenant-leak/role-holders.spec.ts; aqui, os parâmetros e o limite de 50 → titular/substituto). */

const PROCESS = '0192f051-0000-7000-8000-0000000000b1';
const ROLE = '0192f051-0000-7000-8000-0000000000b2';
const HEAD = '0192f051-0000-7000-8000-0000000000c1';
const DEPUTY = '0192f051-0000-7000-8000-0000000000c2';
const NOW = new Date('2026-10-18T12:00:00.000Z');

const event = (payload: Record<string, unknown>, processId: string | null = PROCESS) =>
  ({ processId, payload }) as unknown as DomainEventEnvelope<Record<string, unknown>>;

const holders = (count: number) =>
  Array.from({ length: count }, (_, n) => ({
    user_id: `0192f051-0000-7000-8000-${n.toString(16).padStart(12, '0')}`,
  }));

function clientWith(rows: readonly unknown[][]): { client: SqlClient; params: unknown[][] } {
  const params: unknown[][] = [];
  let call = 0;
  const client: SqlClient = {
    query: (_sql, values = []) => {
      params.push([...values]);
      const result = rows[call] ?? [];
      call += 1;
      return Promise.resolve({ rows: result as never[], rowCount: result.length });
    },
  };
  return { client, params };
}

describe('RoleHoldersLookup (US-051 · ROLE_HOLDERS)', () => {
  const lookup = new RoleHoldersLookup(() => NOW);

  it('detentores do perfil do evento, com o processo, o instante e o limite de 50 + 1', async () => {
    const { client, params } = clientWith([holders(2)]);
    expect(lookup.lookup).toBe('ROLE_HOLDERS');
    await expect(lookup.resolve(client, event({ approverRoleId: ROLE }))).resolves.toEqual(
      holders(2).map((row) => row.user_id),
    );
    expect(params).toEqual([[PROCESS, ROLE, NOW, 51]]);
  });

  it('reatribuição para um perfil usa toApproverRoleId', async () => {
    const { client, params } = clientWith([holders(1)]);
    await lookup.resolve(client, event({ approverRoleId: null, toApproverRoleId: ROLE }));
    expect(params[0]?.[1]).toBe(ROLE);
  });

  it('acima de 50 detentores: a unidade atual pelo titular e pelo substituto', async () => {
    const { client, params } = clientWith([
      holders(51),
      [{ head_user_id: HEAD, deputy_user_id: DEPUTY }],
    ]);
    await expect(lookup.resolve(client, event({ approverRoleId: ROLE }))).resolves.toEqual([
      HEAD,
      DEPUTY,
    ]);
    expect(params[1]).toEqual([PROCESS]);
    const noDeputy = clientWith([holders(51), [{ head_user_id: HEAD, deputy_user_id: null }]]);
    await expect(lookup.resolve(noDeputy.client, event({ approverRoleId: ROLE }))).resolves.toEqual(
      [HEAD],
    );
    const inactive = clientWith([holders(51), []]);
    await expect(lookup.resolve(inactive.client, event({ approverRoleId: ROLE }))).resolves.toEqual(
      [],
    );
  });

  it('sem perfil no payload ou sem processo → ninguém, sem consulta', async () => {
    const { client, params } = clientWith([]);
    await expect(lookup.resolve(client, event({}))).resolves.toEqual([]);
    await expect(lookup.resolve(client, event({ approverRoleId: ROLE }, null))).resolves.toEqual(
      [],
    );
    expect(params).toEqual([]);
  });
});
