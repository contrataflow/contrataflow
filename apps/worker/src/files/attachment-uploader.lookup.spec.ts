import type { DomainEventEnvelope } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';

import { AttachmentUploaderLookup } from './attachment-uploader.lookup.js';

const TENANT = '0192d068-0000-7000-8000-00000000000a';
const ATTACHMENT = '0192d068-0000-7000-8000-0000000000b1';
const UPLOADER = '0192d068-0000-7000-8000-0000000000c1';

function event(payload: Record<string, unknown>): DomainEventEnvelope<Record<string, unknown>> {
  return { tenantId: TENANT, payload } as unknown as DomainEventEnvelope<Record<string, unknown>>;
}

describe('AttachmentUploaderLookup (US-068 · ATTACHMENT_REJECTED)', () => {
  it('quem enviou o anexo, filtrado pelo tenant do evento', async () => {
    const params: unknown[][] = [];
    const client: SqlClient = {
      query: (_sql, values = []) => {
        params.push([...values]);
        return Promise.resolve({ rows: [{ uploaded_by_id: UPLOADER }] as never[], rowCount: 1 });
      },
    };
    const lookup = new AttachmentUploaderLookup();
    expect(lookup.lookup).toBe('ATTACHMENT_UPLOADER');
    await expect(lookup.resolve(client, event({ attachmentId: ATTACHMENT }))).resolves.toEqual([
      UPLOADER,
    ]);
    expect(params).toEqual([[ATTACHMENT, TENANT]]);
  });

  it('sem anexo no payload ou sem linha → ninguém', async () => {
    const client: SqlClient = {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    };
    const lookup = new AttachmentUploaderLookup();
    await expect(lookup.resolve(client, event({}))).resolves.toEqual([]);
    await expect(lookup.resolve(client, event({ attachmentId: ATTACHMENT }))).resolves.toEqual([]);
  });
});
