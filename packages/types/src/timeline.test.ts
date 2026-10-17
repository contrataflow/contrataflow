import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  TIMELINE_ENTRY_TYPES,
  TIMELINE_GROUPS,
  TIMELINE_GROUP_TYPES,
  TIMELINE_VISIBILITIES,
  isTimelineEntryType,
  isTimelineGroup,
  timelineGroupOf,
  timelineTypesOfGroups,
} from './timeline.js';

const EVENTS_DOC = fileURLToPath(new URL('../../../docs/mvp-01/events.md', import.meta.url));

/**
 * Linhas de events.md §5 já especificadas cujas stories produtoras ainda não foram implementadas
 * (EP-020 — IA): entram no registro, no mapeamento do projetor e num grupo (RN-TML-12) com elas.
 * A story que implementar o produtor remove o tipo daqui.
 */
const PENDING_DOCUMENTED_TYPES: Readonly<Record<string, string>> = {
  AI_CONTENT_APPLIED: 'US-117',
};

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
    .filter((type): type is string => type !== undefined)
    .filter((type) => !(type in PENDING_DOCUMENTED_TYPES));
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

describe('grupos de apresentação (US-060 · RN-TML-12)', () => {
  it('todo tipo do registro está em exatamente um grupo', () => {
    const grouped = TIMELINE_GROUPS.flatMap((group) => TIMELINE_GROUP_TYPES[group]);
    expect([...grouped].sort()).toEqual([...TIMELINE_ENTRY_TYPES].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('mapeia cada tipo ao grupo da tabela da story', () => {
    expect(timelineGroupOf('PROCESS_CREATED')).toBe('PROCESSO');
    expect(timelineGroupOf('PARTICIPANT_REMOVED')).toBe('PROCESSO');
    expect(timelineGroupOf('STAGE_OVERDUE')).toBe('TRAMITACAO');
    expect(timelineGroupOf('RISK_LEVEL_CHANGED')).toBe('DOCUMENTOS');
    expect(timelineGroupOf('APPROVAL_REASSIGNED')).toBe('APROVACOES');
    expect(timelineGroupOf('ATTACHMENT_ADDED')).toBe('COMENTARIOS');
    expect(timelineGroupOf('TIPO_RETIRADO')).toBe('PROCESSO');
  });

  it('combina grupos por OU, sem repetir tipos', () => {
    expect(timelineTypesOfGroups(['APROVACOES', 'APROVACOES'])).toEqual([
      'APPROVAL_REQUESTED',
      'APPROVAL_DECIDED',
      'APPROVAL_CANCELED',
      'APPROVAL_REASSIGNED',
    ]);
    expect(timelineTypesOfGroups(['TRAMITACAO', 'COMENTARIOS'])).toHaveLength(10);
    expect(timelineTypesOfGroups([])).toEqual([]);
  });

  it('isTimelineGroup só aceita os grupos da tabela', () => {
    expect(isTimelineGroup('APROVACOES')).toBe(true);
    expect(isTimelineGroup('aprovacoes')).toBe(false);
    expect(isTimelineGroup(1)).toBe(false);
  });
});
