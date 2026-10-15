import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TIMELINE_ENTRY_TYPES, TIMELINE_VISIBILITIES, isTimelineEntryType } from './timeline.js';

const EVENTS_DOC = fileURLToPath(new URL('../../../docs/mvp-01/events.md', import.meta.url));

/** `type` da primeira coluna da tabela de events.md §5 (fonte canônica do registro). */
function documentedEntryTypes(): string[] {
  const doc = readFileSync(EVENTS_DOC, 'utf8');
  const section = doc.slice(
    doc.indexOf('## 5. Projeção na timeline'),
    doc.indexOf('## 6. Notificações'),
  );
  return section
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .flatMap((line) => [...(line.split('|')[1] ?? '').matchAll(/`([A-Z_]+)`/g)].map((m) => m[1]))
    .filter((type): type is string => type !== undefined);
}

describe('registro TimelineEntryType (events.md §5 · US-059)', () => {
  it('é exatamente o da tabela de events.md §5', () => {
    expect([...TIMELINE_ENTRY_TYPES].sort()).toEqual(documentedEntryTypes().sort());
  });

  it('segue SCREAMING_SNAKE_CASE, cabe em varchar(60) e não se repete', () => {
    for (const type of TIMELINE_ENTRY_TYPES) {
      expect(type).toMatch(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/);
      expect(type.length).toBeLessThanOrEqual(60);
    }
    expect(new Set(TIMELINE_ENTRY_TYPES).size).toBe(TIMELINE_ENTRY_TYPES.length);
  });

  it('isTimelineEntryType só aceita tipos registrados', () => {
    expect(isTimelineEntryType('PROCESS_CREATED')).toBe(true);
    expect(isTimelineEntryType('PROCESS_DELETED')).toBe(false);
    expect(isTimelineEntryType(42)).toBe(false);
  });

  it('visibilidades de entities.md §2 `TimelineVisibility`', () => {
    expect(TIMELINE_VISIBILITIES).toEqual(['STANDARD', 'BUDGET_RESTRICTED']);
  });
});
