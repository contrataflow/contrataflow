import { describe, expect, it } from 'vitest';

import {
  formatTaskInboxSort,
  parseTaskInboxSort,
  TASK_INBOX_MESSAGES,
  taskInboxCountersSchema,
  taskInboxQuerySchema,
  taskInboxSortFieldsOf,
} from './task-inbox.js';

describe('taskInboxQuerySchema (US-056 · TSK-01)', () => {
  it('aplica os padrões: visão MINE, página 1, 20 itens e -dueAt (RN-INBOX-02/10)', () => {
    expect(taskInboxQuerySchema.parse({})).toEqual({
      view: 'MINE',
      page: 1,
      pageSize: 20,
      sort: { field: 'dueAt', direction: 'desc' },
    });
  });

  it('aceita os campos de ordenação de cada visão', () => {
    expect(taskInboxQuerySchema.parse({ view: 'UNIT_QUEUE', sort: 'enteredAt' }).sort).toEqual({
      field: 'enteredAt',
      direction: 'asc',
    });
    expect(
      taskInboxQuerySchema.parse({ view: 'PENDING_APPROVALS', sort: '-requestedAt' }).sort,
    ).toEqual({ field: 'requestedAt', direction: 'desc' });
  });

  it('V-03: campo não permitido para a visão → INVALID_ENUM em sort', () => {
    for (const input of [
      { view: 'MINE', sort: 'invalidField' },
      { view: 'MINE', sort: 'requestedAt' },
      { view: 'PENDING_APPROVALS', sort: 'enteredAt' },
      { sort: '--dueAt' },
    ]) {
      const result = taskInboxQuerySchema.safeParse(input);
      expect(result.success).toBe(false);
      const issue = result.error?.issues[0];
      expect(issue?.path).toEqual(['sort']);
      expect(issue?.message).toBe(TASK_INBOX_MESSAGES.invalidSort);
      expect(issue?.code === 'custom' ? issue.params?.code : undefined).toBe('INVALID_ENUM');
    }
  });

  it('V-01/V-02: visão fora do enum e pageSize acima de 100 são recusados', () => {
    expect(taskInboxQuerySchema.safeParse({ view: 'ALL' }).success).toBe(false);
    expect(taskInboxQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
    expect(taskInboxQuerySchema.parse({ pageSize: '100', page: '3' })).toMatchObject({
      page: 3,
      pageSize: 100,
    });
  });
});

describe('ordenação da caixa (RN-INBOX-10)', () => {
  it('lista os campos por visão e ida e volta do texto', () => {
    expect(taskInboxSortFieldsOf('FOLLOWING')).toEqual(['dueAt', 'code', 'enteredAt']);
    expect(taskInboxSortFieldsOf('PENDING_APPROVALS')).toEqual(['dueAt', 'code', 'requestedAt']);
    const sort = parseTaskInboxSort('-code', 'OVERDUE');
    expect(sort).toEqual({ field: 'code', direction: 'desc' });
    expect(sort && formatTaskInboxSort(sort)).toBe('-code');
    expect(parseTaskInboxSort('due-At', 'MINE')).toBeNull();
  });
});

describe('taskInboxCountersSchema (TSK-02)', () => {
  it('unitQueue é opcional (só quando a fila se aplica — FA-01)', () => {
    const base = { mine: 3, pendingApprovals: 0, returned: 1, overdue: 0, following: 2 };
    expect(taskInboxCountersSchema.parse(base)).toEqual(base);
    expect(taskInboxCountersSchema.parse({ ...base, unitQueue: 4 }).unitQueue).toBe(4);
  });
});
