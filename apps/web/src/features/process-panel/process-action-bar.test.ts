import type { ActionEntry } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { groupMenuActions } from './process-action-bar';

const entry = (action: ActionEntry['action']): ActionEntry => ({
  action,
  label: action,
  enabled: true,
  reasons: [],
});

describe('menu "Mais" do processo (prd-5 · card 4)', () => {
  it('agrupa por frequência: tramitação, gestão e situação do processo', () => {
    const groups = groupMenuActions(
      ['CANCEL', 'EDIT', 'SUSPEND', 'ASSIGN', 'DUPLICATE', 'FORWARD', 'MANAGE_TAGS', 'CLAIM'].map(
        (action) => entry(action as ActionEntry['action']),
      ),
    );
    expect(groups.map(({ group, entries }) => [group, entries.map((e) => e.action)])).toEqual([
      ['flow', ['FORWARD', 'CLAIM', 'ASSIGN']],
      ['manage', ['EDIT', 'DUPLICATE', 'MANAGE_TAGS']],
      ['lifecycle', ['SUSPEND', 'CANCEL']],
    ]);
  });

  it('omite grupos vazios', () => {
    expect(groupMenuActions([entry('EDIT')]).map(({ group }) => group)).toEqual(['manage']);
  });
});
