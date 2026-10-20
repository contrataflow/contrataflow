import { describe, expect, it } from 'vitest';

import { TIMELINE_MESSAGES, processTimelineQuerySchema, timelineEntrySchema } from './timeline.js';

const ACTOR = '0192f111-0000-7000-8000-0000000000a1';
const OTHER = '0192f111-0000-7000-8000-0000000000a2';

function issuesOf(query: Record<string, unknown>) {
  const result = processTimelineQuerySchema.safeParse(query);
  if (result.success) throw new Error('esperava falha de validação');
  return result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: (issue as { params?: { code?: string } }).params?.code,
  }));
}

describe('PRC-12 — query da timeline (US-060)', () => {
  it('sem filtros: 50 itens, mais recente primeiro', () => {
    expect(processTimelineQuerySchema.parse({})).toEqual({ limit: 50 });
  });

  it('converte grupos e autores (vírgula ou repetição), sem repetir', () => {
    expect(
      processTimelineQuerySchema.parse({
        group: 'APROVACOES,TRAMITACAO,APROVACOES',
        actorId: [ACTOR, OTHER, ACTOR],
        occurredFrom: '2026-10-01T00:00:00Z',
        occurredTo: '2026-10-08T00:00:00Z',
        limit: '20',
        cursor: 'eyJhIjoxfQ',
      }),
    ).toEqual({
      group: ['APROVACOES', 'TRAMITACAO'],
      actorId: [ACTOR, OTHER],
      occurredFrom: '2026-10-01T00:00:00Z',
      occurredTo: '2026-10-08T00:00:00Z',
      limit: 20,
      cursor: 'eyJhIjoxfQ',
    });
  });

  it('valor vazio equivale a filtro ausente', () => {
    expect(processTimelineQuerySchema.parse({ group: '', actorId: ' , ' })).toEqual({ limit: 50 });
  });

  it('V-01: período invertido → OUT_OF_RANGE em occurredTo', () => {
    expect(
      issuesOf({ occurredFrom: '2026-10-08T00:00:00Z', occurredTo: '2026-10-01T00:00:00Z' }),
    ).toEqual([
      { path: 'occurredTo', message: TIMELINE_MESSAGES.periodRange, code: 'OUT_OF_RANGE' },
    ]);
  });

  it('período de um único instante é válido (inclusivo)', () => {
    expect(
      processTimelineQuerySchema.safeParse({
        occurredFrom: '2026-10-08T00:00:00Z',
        occurredTo: '2026-10-08T00:00:00Z',
      }).success,
    ).toBe(true);
  });

  it('V-04: grupo fora da tabela → INVALID_ENUM em group', () => {
    expect(issuesOf({ group: 'APROVACOES,FINANCEIRO' })).toEqual([
      { path: 'group', message: TIMELINE_MESSAGES.invalidGroup, code: 'INVALID_ENUM' },
    ]);
  });

  it.each([
    [{ limit: '0' }, 'limit'],
    [{ limit: '101' }, 'limit'],
    [{ cursor: 'a b' }, 'cursor'],
    [{ actorId: 'ana' }, 'actorId.0'],
    [{ occurredFrom: '2026-10-08' }, 'occurredFrom'],
    [{ group: Array.from({ length: 51 }, () => 'PROCESSO').join(',') }, 'group'],
  ])('recusa %o (%s)', (query, path) => {
    expect(issuesOf(query).map((issue) => issue.path)).toContain(path);
  });

  it('recusa parâmetros desconhecidos (estrito)', () => {
    expect(issuesOf({ type: 'PROCESS_CREATED' })).toHaveLength(1);
  });
});

describe('PRC-12 — TimelineEntry', () => {
  it('aceita a entrada com nomes congelados e params', () => {
    const entry = {
      id: '0192f111-0000-7000-8000-0000000000e1',
      occurredAt: '2026-10-05T14:30:00.000Z',
      type: 'PROCESS_CREATED',
      actorType: 'USER',
      actorId: ACTOR,
      actorName: 'Ana',
      actorDepartmentName: null,
      entityType: 'Process',
      entityId: '0192f111-0000-7000-8000-0000000000f1',
      movementId: null,
      params: { code: '0012/2026' },
      visibility: 'STANDARD',
    };
    expect(timelineEntrySchema.parse(entry)).toEqual(entry);
    expect(timelineEntrySchema.safeParse({ ...entry, visibility: 'SECRET' }).success).toBe(false);
  });
});
