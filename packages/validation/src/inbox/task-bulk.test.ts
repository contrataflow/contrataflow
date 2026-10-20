import { describe, expect, it } from 'vitest';

import { TASK_BULK_MESSAGES, bulkAssignSchema, bulkClaimSchema } from './task-bulk.js';

const ids = (count: number) =>
  Array.from(
    { length: count },
    (_, index) => `0192d058-0000-7000-8000-${String(index).padStart(12, '0')}`,
  );

function issuesOf(result: { success: boolean; error?: { issues: unknown[] } }) {
  return (result.error?.issues ?? []) as {
    code: string;
    path: (string | number)[];
    message: string;
    params?: { code?: string };
  }[];
}

describe('bulkClaimSchema (US-058 · TSK-03 · RN-INBOX-19)', () => {
  it('aceita de 2 a 50 processos distintos', () => {
    expect(bulkClaimSchema.parse({ processIds: ids(2) }).processIds).toHaveLength(2);
    expect(bulkClaimSchema.parse({ processIds: ids(50) }).processIds).toHaveLength(50);
  });

  it('V-01: menos de 2 itens', () => {
    const [issue] = issuesOf(bulkClaimSchema.safeParse({ processIds: ids(1) }));
    expect(issue).toMatchObject({ code: 'too_small', message: TASK_BULK_MESSAGES.tooShort });
  });

  it('V-02: mais de 50 itens', () => {
    const [issue] = issuesOf(bulkClaimSchema.safeParse({ processIds: ids(51) }));
    expect(issue).toMatchObject({ code: 'too_big', message: TASK_BULK_MESSAGES.tooLong });
  });

  it('V-03: item repetido', () => {
    const [first = ''] = ids(1);
    const [issue] = issuesOf(bulkClaimSchema.safeParse({ processIds: [first, first] }));
    expect(issue).toMatchObject({ code: 'custom', params: { code: 'DUPLICATE_IN_LIST' } });
  });

  it('recusa campo fora do contrato e id que não é uuid', () => {
    expect(bulkClaimSchema.safeParse({ processIds: ids(2), extra: 1 }).success).toBe(false);
    expect(bulkClaimSchema.safeParse({ processIds: ['x', 'y'] }).success).toBe(false);
  });
});

describe('bulkAssignSchema (US-058 · TSK-04 · RN-INBOX-21)', () => {
  const [assigneeId = ''] = ids(1);

  it('exige responsável e motivo (V-04) e apara o motivo', () => {
    expect(
      bulkAssignSchema.parse({ processIds: ids(3), assigneeId, reason: '  Mutirão de triagem  ' }),
    ).toEqual({ processIds: ids(3), assigneeId, reason: 'Mutirão de triagem' });
    const missing = issuesOf(bulkAssignSchema.safeParse({ processIds: ids(2) }));
    expect(missing.map((issue) => issue.path.join('.'))).toEqual(['assigneeId', 'reason']);
    expect(missing.every((issue) => issue.message === TASK_BULK_MESSAGES.assignRequired)).toBe(
      true,
    );
  });

  it('motivo com os limites da reatribuição manual (10–2.000)', () => {
    const [short] = issuesOf(
      bulkAssignSchema.safeParse({ processIds: ids(2), assigneeId, reason: 'curto' }),
    );
    expect(short?.message).toBe(TASK_BULK_MESSAGES.reasonTooShort);
    const [long] = issuesOf(
      bulkAssignSchema.safeParse({ processIds: ids(2), assigneeId, reason: 'x'.repeat(2001) }),
    );
    expect(long?.message).toBe(TASK_BULK_MESSAGES.reasonTooLong);
  });
});
