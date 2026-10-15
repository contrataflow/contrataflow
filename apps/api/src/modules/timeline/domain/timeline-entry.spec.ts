import { describe, expect, it } from 'vitest';

import {
  COMMENT_EXCERPT_MAX,
  TimelinePayloadError,
  budgetVisibility,
  commentExcerpt,
  graphemesOf,
} from './timeline-entry.js';
import { TimelineLookups, lookupRef } from './timeline-lookups.js';

describe('budgetVisibility (POL-09 · RN-TML-05)', () => {
  it.each([
    [false, { isBudgetConfidential: true }, 'STANDARD'],
    [false, null, 'STANDARD'],
    [true, { isBudgetConfidential: false }, 'STANDARD'],
    [true, { isBudgetConfidential: true }, 'BUDGET_RESTRICTED'],
    // Sigilo desconhecido falha fechado.
    [true, null, 'BUDGET_RESTRICTED'],
  ] as const)('revela valor=%s, processo=%o → %s', (revealsBudget, process, expected) => {
    expect(budgetVisibility(revealsBudget, process)).toBe(expected);
  });
});

describe('commentExcerpt', () => {
  it('mantém trechos curtos e corta em 140 caracteres (grafemas, sem partir emoji)', () => {
    expect(commentExcerpt(null)).toBeNull();
    expect(commentExcerpt('  ok  ')).toBe('ok');
    const long = '👩‍💻'.repeat(200);
    const excerpt = commentExcerpt(long) ?? '';
    expect(graphemesOf(excerpt)).toHaveLength(COMMENT_EXCERPT_MAX);
    expect(excerpt.startsWith('👩‍💻'.repeat(COMMENT_EXCERPT_MAX - 1))).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(commentExcerpt('a'.repeat(COMMENT_EXCERPT_MAX))).toBe('a'.repeat(COMMENT_EXCERPT_MAX));
  });
});

describe('TimelinePayloadError (V-01)', () => {
  it('lista só caminhos e códigos', () => {
    const error = new TimelinePayloadError('ProcessCreated', ['title: invalid_type']);
    expect(error).toMatchObject({ name: 'TimelinePayloadError', eventType: 'ProcessCreated' });
    expect(error.message).toContain('title: invalid_type');
  });
});

describe('TimelineLookups', () => {
  const id = '0192f000-0000-7000-8000-000000000001';

  it('lookupRef ignora IDs ausentes', () => {
    expect(lookupRef('USER', null)).toEqual([]);
    expect(lookupRef('USER', undefined)).toEqual([]);
    expect(lookupRef('USER', id)).toEqual([{ kind: 'USER', id }]);
  });

  it('get devolve o registro ou null (tipo não resolvido, ID ausente ou não encontrado)', () => {
    const lookups = new TimelineLookups({ USER: new Map([[id, { name: 'Ana' }]]) });
    expect(lookups.get('USER', id)).toEqual({ name: 'Ana' });
    expect(lookups.get('USER', null)).toBeNull();
    expect(lookups.get('USER', '0192f000-0000-7000-8000-000000000002')).toBeNull();
    expect(lookups.get('DEPARTMENT', id)).toBeNull();
    expect(new TimelineLookups().get('USER', id)).toBeNull();
  });
});
