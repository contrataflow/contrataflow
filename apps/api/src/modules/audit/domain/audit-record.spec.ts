import { describe, expect, it } from 'vitest';

import { canonicalRecord, HASHED_FIELDS, rowHashOf, seal } from './audit-record.js';
import type { AuditRecord } from './audit-record.js';

/** Registro fixo: o `rowHash` dele é a regressão do formato canônico (US-074 o recalcula). */
const RECORD: AuditRecord = {
  id: '0192f000-0000-7000-8000-000000000001',
  occurredAt: new Date('2026-10-14T21:00:00.123Z'),
  tenantId: '0192f000-0000-7000-8000-00000000000a',
  actorType: 'USER',
  actorUserId: '0192f000-0000-7000-8000-0000000000a1',
  actorName: 'Ana Ribeiro',
  actorMembershipId: '0192f000-0000-7000-8000-0000000001a1',
  onBehalfOfUserId: null,
  action: 'process.create',
  category: 'DATA_CHANGE',
  result: 'SUCCESS',
  entityType: 'Process',
  entityId: '0192f000-0000-7000-8000-0000000000f1',
  processId: '0192f000-0000-7000-8000-0000000000f1',
  changes: [{ path: 'title', old: null, new: 'Aquisição de papel A4' }],
  metadata: { processCode: 'PRC-2026/0001' },
  reasonCode: null,
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  correlationId: '0192f000-0000-7000-8000-0000000000c0',
  requestId: 'req-1',
  sessionIdHash: 'a'.repeat(64),
};

describe('rowHash (RN-AUD-08)', () => {
  it('cobre todos os campos do registro, exceto o próprio rowHash', () => {
    expect([...HASHED_FIELDS].sort()).toEqual(Object.keys(RECORD).sort());
  });

  it('forma canônica: JCS com occurredAt em ISO UTC (regressão do formato)', () => {
    expect(canonicalRecord(RECORD)).toBe(
      '{"action":"process.create","actorMembershipId":"0192f000-0000-7000-8000-0000000001a1","actorName":"Ana Ribeiro","actorType":"USER","actorUserId":"0192f000-0000-7000-8000-0000000000a1","category":"DATA_CHANGE","changes":[{"new":"Aquisição de papel A4","old":null,"path":"title"}],"correlationId":"0192f000-0000-7000-8000-0000000000c0","entityId":"0192f000-0000-7000-8000-0000000000f1","entityType":"Process","id":"0192f000-0000-7000-8000-000000000001","ip":"203.0.113.7","metadata":{"processCode":"PRC-2026/0001"},"occurredAt":"2026-10-14T21:00:00.123Z","onBehalfOfUserId":null,"processId":"0192f000-0000-7000-8000-0000000000f1","reasonCode":null,"requestId":"req-1","result":"SUCCESS","sessionIdHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","tenantId":"0192f000-0000-7000-8000-00000000000a","userAgent":"Mozilla/5.0"}',
    );
    expect(rowHashOf(RECORD)).toBe(rowHashOf({ ...RECORD }));
    expect(rowHashOf(RECORD)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('qualquer campo alterado muda o hash; a ordem das chaves do metadata não', () => {
    const base = rowHashOf(RECORD);
    for (const field of HASHED_FIELDS) {
      const changed =
        field === 'occurredAt'
          ? { ...RECORD, occurredAt: new Date(RECORD.occurredAt.getTime() + 1) }
          : field === 'changes'
            ? { ...RECORD, changes: [] }
            : field === 'metadata'
              ? { ...RECORD, metadata: { processCode: 'PRC-2026/0002' } }
              : {
                  ...RECORD,
                  [field]: field === 'onBehalfOfUserId' || field === 'reasonCode' ? 'x' : null,
                };
      expect(rowHashOf(changed as AuditRecord), field).not.toBe(base);
    }
    expect(rowHashOf({ ...RECORD, metadata: { b: 1, a: 2 } })).toBe(
      rowHashOf({ ...RECORD, metadata: { a: 2, b: 1 } }),
    );
  });

  it('seal acrescenta o hash sem alterar o registro', () => {
    const sealed = seal(RECORD);
    expect(sealed).toEqual({ ...RECORD, rowHash: rowHashOf(RECORD) });
  });
});
