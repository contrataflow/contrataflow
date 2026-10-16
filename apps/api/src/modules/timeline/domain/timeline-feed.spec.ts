import { describe, expect, it } from 'vitest';

import type { ProcessTimelineEntry } from './timeline-entry.js';
import {
  compareTimelineEntries,
  isAfterCursor,
  isEntryVisible,
  matchesTimelineSearch,
  timelineCriteriaOf,
  timelineFilterKeys,
} from './timeline-feed.js';
import type { TimelineFeedSearch } from './timeline-feed.js';

const PROCESS = '0192f060-0000-7000-8000-000000000001';
const OTHER_PROCESS = '0192f060-0000-7000-8000-000000000002';
const CARLOS = '0192f060-0000-7000-8000-0000000000c1';
const ANA = '0192f060-0000-7000-8000-0000000000a1';

function entry(overrides: Partial<ProcessTimelineEntry> = {}): ProcessTimelineEntry {
  return {
    id: '0192f060-0000-7000-8000-000000000e05',
    tenantId: '0192f060-0000-7000-8000-00000000000a',
    processId: PROCESS,
    occurredAt: new Date('2026-10-03T12:00:00.000Z'),
    type: 'APPROVAL_DECIDED',
    actorType: 'USER',
    actorId: CARLOS,
    actorName: 'Carlos',
    actorDepartmentName: null,
    entityType: 'Approval',
    entityId: null,
    movementId: null,
    params: {},
    visibility: 'STANDARD',
    sourceEventId: '0192f060-0000-7000-8000-000000000f05',
    ...overrides,
  };
}

const search = (overrides: Partial<TimelineFeedSearch> = {}): TimelineFeedSearch => ({
  processId: PROCESS,
  types: null,
  actorIds: null,
  occurredFrom: null,
  occurredTo: null,
  includeRestricted: false,
  after: null,
  take: 51,
  ...overrides,
});

describe('critérios da timeline (US-060 · RN-TML-10..12)', () => {
  it('sem filtros: tudo nulo e nenhuma chave', () => {
    expect(timelineCriteriaOf({})).toEqual({
      types: null,
      actorIds: null,
      occurredFrom: null,
      occurredTo: null,
    });
    expect(timelineFilterKeys({})).toEqual([]);
  });

  it('grupos viram tipos (OU) e o período vira instantes', () => {
    const criteria = timelineCriteriaOf({
      group: ['APROVACOES'],
      actorId: [CARLOS],
      occurredFrom: '2026-10-01T00:00:00Z',
      occurredTo: '2026-10-08T00:00:00Z',
    });
    expect(criteria.types).toEqual([
      'APPROVAL_REQUESTED',
      'APPROVAL_DECIDED',
      'APPROVAL_CANCELED',
      'APPROVAL_REASSIGNED',
    ]);
    expect(criteria.actorIds).toEqual([CARLOS]);
    expect(criteria.occurredFrom?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(criteria.occurredTo?.toISOString()).toBe('2026-10-08T00:00:00.000Z');
    expect(
      timelineFilterKeys({ group: ['APROVACOES'], occurredTo: '2026-10-08T00:00:00Z' }),
    ).toEqual(['group', 'occurredTo']);
  });
});

describe('visibilidade BUDGET_RESTRICTED (RN-TML-13)', () => {
  it.each([
    ['STANDARD', false, true],
    ['STANDARD', true, true],
    ['BUDGET_RESTRICTED', false, false],
    ['BUDGET_RESTRICTED', true, true],
  ] as const)('%s com POL-09=%s → visível=%s', (visibility, pol09, visible) => {
    expect(isEntryVisible({ visibility }, pol09)).toBe(visible);
  });
});

describe('ordem e cursor (RN-TML-09)', () => {
  const older = entry({ occurredAt: new Date('2026-10-01T00:00:00Z') });
  const newer = entry({ occurredAt: new Date('2026-10-02T00:00:00Z') });
  const tieLow = entry({ id: '0192f060-0000-7000-8000-000000000e01' });
  const tieHigh = entry({ id: '0192f060-0000-7000-8000-000000000e09' });

  it('mais recente primeiro; empate no instante pelo id decrescente', () => {
    expect([older, newer].sort(compareTimelineEntries)).toEqual([newer, older]);
    expect([tieLow, tieHigh].sort(compareTimelineEntries)).toEqual([tieHigh, tieLow]);
    expect(compareTimelineEntries(tieLow, tieLow)).toBe(0);
  });

  it('o cursor exclui a própria posição e tudo antes dela', () => {
    const position = { occurredAt: tieHigh.occurredAt, id: tieHigh.id };
    expect(isAfterCursor(tieHigh, position)).toBe(false);
    expect(isAfterCursor(tieLow, position)).toBe(true);
    expect(isAfterCursor(entry({ occurredAt: new Date('2026-10-04T00:00:00Z') }), position)).toBe(
      false,
    );
    expect(isAfterCursor(older, position)).toBe(true);
    expect(isAfterCursor(newer, null)).toBe(true);
  });
});

describe('matchesTimelineSearch', () => {
  it('casa sem filtros e respeita o processo', () => {
    expect(matchesTimelineSearch(entry(), search())).toBe(true);
    expect(matchesTimelineSearch(entry({ processId: OTHER_PROCESS }), search())).toBe(false);
  });

  it('tipo, autor (ator de sistema nunca casa filtro de autor) e período inclusivo', () => {
    expect(matchesTimelineSearch(entry(), search({ types: ['COMMENT_ADDED'] }))).toBe(false);
    expect(matchesTimelineSearch(entry(), search({ actorIds: [ANA] }))).toBe(false);
    expect(
      matchesTimelineSearch(
        entry({ actorType: 'SYSTEM', actorId: null }),
        search({ actorIds: [CARLOS] }),
      ),
    ).toBe(false);
    const at = entry().occurredAt;
    expect(matchesTimelineSearch(entry(), search({ occurredFrom: at, occurredTo: at }))).toBe(true);
    expect(
      matchesTimelineSearch(entry(), search({ occurredFrom: new Date(at.getTime() + 1) })),
    ).toBe(false);
    expect(matchesTimelineSearch(entry(), search({ occurredTo: new Date(at.getTime() - 1) }))).toBe(
      false,
    );
  });

  it('restrita só com POL-09', () => {
    const restricted = entry({ visibility: 'BUDGET_RESTRICTED' });
    expect(matchesTimelineSearch(restricted, search())).toBe(false);
    expect(matchesTimelineSearch(restricted, search({ includeRestricted: true }))).toBe(true);
  });
});
