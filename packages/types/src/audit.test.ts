import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AUDIT_ACTION_NAMES, AUDIT_ACTIONS, AUDIT_CATEGORIES, isAuditAction } from './audit.js';

const EVENTS_DOC = fileURLToPath(new URL('../../../docs/mvp-01/events.md', import.meta.url));

/**
 * Linhas de events.md §7 já especificadas cujas stories ainda não foram implementadas: as ações
 * entram no catálogo com elas, que removem a área daqui. (A área de IA entrou inteira com a
 * US-115, inclusive `ai.content_apply`/`ai.content_review` usados pelas US-117/US-122.)
 */
const PENDING_AREAS: readonly string[] = [];

/** Ações `resource.action` citadas na tabela de events.md §7 (fonte canônica do catálogo). */
function documentedActions(): string[] {
  const doc = readFileSync(EVENTS_DOC, 'utf8');
  const section = doc.slice(
    doc.indexOf('## 7. Catálogo de ações de auditoria'),
    doc.indexOf('## 8. Versionamento'),
  );
  const rows = section
    .split('\n')
    .filter((line) => /^\| [A-Z]/.test(line) && !line.startsWith('| Área'))
    .filter((line) => !PENDING_AREAS.some((area) => line.startsWith(area)));
  return [
    ...new Set(rows.flatMap((row) => [...row.matchAll(/`([a-z_]+\.[a-z_]+)`/g)].map((m) => m[1]))),
  ]
    .filter((action): action is string => action !== undefined)
    .sort();
}

describe('catálogo de ações de auditoria (events.md §7 · US-073)', () => {
  it('é exatamente o da tabela de events.md §7', () => {
    expect(AUDIT_ACTION_NAMES).toEqual(documentedActions());
    expect(AUDIT_ACTION_NAMES).toHaveLength(149);
  });

  it('cada ação segue `resource.action` e tem uma categoria válida', () => {
    for (const action of AUDIT_ACTION_NAMES) {
      expect(action).toMatch(/^[a-z][a-z_]*\.[a-z][a-z_]*$/);
      expect(AUDIT_CATEGORIES).toContain(AUDIT_ACTIONS[action].category);
    }
  });

  it('categorias anotadas no catálogo e coalescência só no autosave', () => {
    expect(AUDIT_ACTIONS['access.denied'].category).toBe('ACCESS');
    expect(AUDIT_ACTIONS['auth.session_start'].category).toBe('SECURITY');
    expect(AUDIT_ACTIONS['auth.tenant_switch'].category).toBe('ACCESS');
    expect(AUDIT_ACTIONS['process.forward'].category).toBe('WORKFLOW');
    expect(AUDIT_ACTIONS['process.export'].category).toBe('EXPORT');
    expect(AUDIT_ACTIONS['audit.seal'].category).toBe('SYSTEM');
    expect(AUDIT_ACTIONS['queue_dashboard.access'].category).toBe('ACCESS');
    expect(AUDIT_ACTIONS['dead_letter.retry'].category).toBe('SYSTEM');
    expect(AUDIT_ACTION_NAMES.filter((action) => AUDIT_ACTIONS[action].coalescible)).toEqual([
      'document.draft_update',
    ]);
  });

  it('isAuditAction recusa o que está fora do catálogo', () => {
    expect(isAuditAction('process.create')).toBe(true);
    expect(isAuditAction('foo.bar')).toBe(false);
    expect(isAuditAction('toString')).toBe(false);
  });
});
