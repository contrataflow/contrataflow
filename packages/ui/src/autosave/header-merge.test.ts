import { describe, expect, it } from 'vitest';

import { changedHeaderFields, mergeHeader, sameHeaderValue } from './header-merge.js';
import { diffParagraphs } from './text-diff.js';

const FIELDS = ['priority', 'expectedDate', 'wizardStep', 'completedSteps'];
const STEPS = ['IDENTIFICATION', 'JUSTIFICATION', 'PLANNING', 'REVIEW', 'CONCLUSION'];
const rules = {
  lastWriteWins: ['wizardStep'],
  union: ['completedSteps'],
  unionOrder: { completedSteps: STEPS },
};

const base = {
  priority: 'MEDIUM',
  expectedDate: null,
  wizardStep: 'IDENTIFICATION',
  completedSteps: [],
};

describe('mergeHeader (US-015 · FA-02 · RN-DFD-28)', () => {
  it('campos diferentes: sem conflito, reenvia só os locais', () => {
    const result = mergeHeader(
      {
        base,
        local: { ...base, priority: 'HIGH' },
        server: { ...base, expectedDate: '2027-03-01' },
        fields: FIELDS,
      },
      rules,
    );
    expect(result).toEqual({ conflicts: [], patch: { priority: 'HIGH' } });
  });

  it('mesmo campo com valores diferentes: conflito; valor igual não conflita', () => {
    expect(
      mergeHeader(
        {
          base,
          local: { ...base, priority: 'HIGH' },
          server: { ...base, priority: 'URGENT' },
          fields: FIELDS,
        },
        rules,
      ),
    ).toEqual({ conflicts: ['priority'], patch: {} });
    expect(
      mergeHeader(
        {
          base,
          local: { ...base, priority: 'HIGH' },
          server: { ...base, priority: 'HIGH' },
          fields: FIELDS,
        },
        rules,
      ).conflicts,
    ).toEqual([]);
  });

  it('wizardStep: última gravação vence; completedSteps: união na ordem do wizard', () => {
    const result = mergeHeader(
      {
        base,
        local: { ...base, wizardStep: 'PLANNING', completedSteps: ['JUSTIFICATION'] },
        server: { ...base, wizardStep: 'REVIEW', completedSteps: ['IDENTIFICATION'] },
        fields: FIELDS,
      },
      rules,
    );
    expect(result).toEqual({
      conflicts: [],
      patch: { wizardStep: 'PLANNING', completedSteps: ['IDENTIFICATION', 'JUSTIFICATION'] },
    });
  });

  it('auxiliares: comparação de listas e campos alterados', () => {
    expect(sameHeaderValue(['a'], ['a'])).toBe(true);
    expect(sameHeaderValue(null, undefined)).toBe(true);
    expect(sameHeaderValue(['a'], ['b'])).toBe(false);
    expect(changedHeaderFields(base, { ...base, priority: 'LOW' }, FIELDS)).toEqual(['priority']);
  });
});

describe('diffParagraphs (FA-01 — "Ver diferenças")', () => {
  it('marca removido (servidor) e inserido (local) por parágrafo', () => {
    expect(diffParagraphs('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'inserted', text: 'B' },
      { kind: 'same', text: 'c' },
      { kind: 'inserted', text: 'd' },
    ]);
    expect(diffParagraphs('', 'novo')).toEqual([
      { kind: 'removed', text: '' },
      { kind: 'inserted', text: 'novo' },
    ]);
  });
});
