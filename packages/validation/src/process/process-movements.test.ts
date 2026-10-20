import { describe, expect, it } from 'vitest';

import {
  PROCESS_MOVEMENTS_MESSAGES,
  isMovementAction,
  movementItemSchema,
  processMovementsQuerySchema,
} from './process-movements.js';

const UNIT = '0192f054-0000-7000-8000-0000000000a1';
const ACTOR = '0192f054-0000-7000-8000-0000000000a2';

function issuesOf(query: Record<string, unknown>) {
  const result = processMovementsQuerySchema.safeParse(query);
  if (result.success) throw new Error('esperava falha de validação');
  return result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: (issue as { params?: { code?: string } }).params?.code,
  }));
}

describe('PRC-11 — query do histórico de tramitações (US-054)', () => {
  it('sem filtros: 50 itens', () => {
    expect(processMovementsQuerySchema.parse({})).toEqual({ limit: 50 });
  });

  it('ações por vírgula ou repetição (OU), sem repetir; demais filtros por E', () => {
    expect(
      processMovementsQuerySchema.parse({
        action: ['FORWARD,RETURN', 'FORWARD'],
        fromDepartmentId: UNIT,
        toDepartmentId: UNIT,
        actorId: ACTOR,
        occurredFrom: '2026-10-01T00:00:00Z',
        occurredTo: '2026-10-01T00:00:00Z',
        limit: '20',
        cursor: 'eyJzIjoxfQ',
      }),
    ).toEqual({
      action: ['FORWARD', 'RETURN'],
      fromDepartmentId: UNIT,
      toDepartmentId: UNIT,
      actorId: ACTOR,
      occurredFrom: '2026-10-01T00:00:00Z',
      occurredTo: '2026-10-01T00:00:00Z',
      limit: 20,
      cursor: 'eyJzIjoxfQ',
    });
    expect(processMovementsQuerySchema.parse({ action: ' , ' })).toEqual({ limit: 50 });
  });

  it('V-01: ação fora do enum → INVALID_ENUM em action', () => {
    expect(issuesOf({ action: 'FORWARD,TELEPORT' })).toEqual([
      { path: 'action', message: PROCESS_MOVEMENTS_MESSAGES.invalidAction, code: 'INVALID_ENUM' },
    ]);
  });

  it('V-02: período invertido → OUT_OF_RANGE em occurredFrom', () => {
    expect(
      issuesOf({ occurredFrom: '2026-10-05T00:00:00Z', occurredTo: '2026-10-01T00:00:00Z' }),
    ).toEqual([
      {
        path: 'occurredFrom',
        message: PROCESS_MOVEMENTS_MESSAGES.periodRange,
        code: 'OUT_OF_RANGE',
      },
    ]);
  });

  it('V-03: limite acima de 100 é recusado; unidade/ator precisam ser UUID', () => {
    expect(processMovementsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(issuesOf({ actorId: 'ana' })[0]).toMatchObject({ path: 'actorId' });
    expect(issuesOf({ toDepartmentId: '1' })[0]).toMatchObject({ path: 'toDepartmentId' });
  });

  it('isMovementAction reconhece só o enum', () => {
    expect(isMovementAction('APPROVE')).toBe(true);
    expect(isMovementAction('approve')).toBe(false);
  });

  it('MovementItem aceita o item mínimo (CREATE) com ip nulo', () => {
    expect(
      movementItemSchema.safeParse({
        id: UNIT,
        sequence: 1,
        action: 'CREATE',
        fromStage: null,
        toStage: { id: UNIT, name: 'Abertura' },
        fromDepartment: null,
        toDepartment: { id: UNIT, name: 'Setor', isActive: true },
        fromUser: null,
        toUser: null,
        statusFrom: null,
        statusTo: 'DRAFT',
        actor: { type: 'USER', id: ACTOR, name: 'Ana', departmentName: null },
        comment: null,
        dueAt: null,
        documents: [],
        approvalId: null,
        approvalSummary: null,
        occurredAt: '2026-10-01T00:00:00.000Z',
        ip: null,
        userAgent: null,
        correlationId: 'c-1',
      }).success,
    ).toBe(true);
  });
});
