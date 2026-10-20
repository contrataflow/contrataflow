import type { DomainEventEnvelope } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';

import { RenditionRequesterLookup } from './rendition-requester.lookup.js';

const TENANT = '0192d067-0000-7000-8000-00000000000a';
const RENDITION = '0192d067-0000-7000-8000-0000000000b1';
const REQUESTER = '0192d067-0000-7000-8000-0000000000c1';

function event(payload: Record<string, unknown>): DomainEventEnvelope<Record<string, unknown>> {
  return { tenantId: TENANT, payload } as unknown as DomainEventEnvelope<Record<string, unknown>>;
}

describe('RenditionRequesterLookup (US-067 · DOCUMENT_RENDER_FAILED)', () => {
  it('quem pediu o PDF, filtrado pelo tenant do evento', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const client: SqlClient = {
      query: (sql, values = []) => {
        calls.push({ sql, params: [...values] });
        return Promise.resolve({ rows: [{ requested_by_id: REQUESTER }] as never[], rowCount: 1 });
      },
    };
    const lookup = new RenditionRequesterLookup();
    expect(lookup.lookup).toBe('RENDITION_REQUESTER');
    await expect(lookup.resolve(client, event({ renditionId: RENDITION }))).resolves.toEqual([
      REQUESTER,
    ]);
    expect(calls[0]?.params).toEqual([RENDITION, TENANT]);
    expect(calls[0]?.sql).toMatch(/FROM document_renditions/);
  });

  it('sem rendition no payload, sem linha ou sem solicitante → ninguém', async () => {
    let rows: never[] = [];
    const client: SqlClient = {
      query: () => Promise.resolve({ rows, rowCount: rows.length }),
    };
    const lookup = new RenditionRequesterLookup();
    await expect(lookup.resolve(client, event({}))).resolves.toEqual([]);
    await expect(lookup.resolve(client, event({ renditionId: RENDITION }))).resolves.toEqual([]);
    rows = [{ requested_by_id: null }] as never[];
    await expect(lookup.resolve(client, event({ renditionId: RENDITION }))).resolves.toEqual([]);
  });
});
