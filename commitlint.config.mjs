// Conventional Commits 1.0 (RN-FND-07). Os escopos dos módulos vêm de tools/module-levels.json
// (lista de DEC-040), para que um módulo novo seja um escopo válido sem editar este arquivo.
import { readFileSync } from 'node:fs';

const moduleLevels = JSON.parse(
  readFileSync(new URL('./tools/module-levels.json', import.meta.url), 'utf8'),
);

export const TYPES = [
  'feat',
  'fix',
  'refactor',
  'perf',
  'test',
  'docs',
  'build',
  'ci',
  'chore',
  'revert',
];

export const SCOPES = [
  // apps
  'web',
  'api',
  'worker',
  // pacotes do workspace
  'ui',
  'types',
  'validation',
  'editor',
  'observability',
  'eslint-config',
  'tsconfig',
  'tools',
  // módulos de DEC-040
  ...moduleLevels.levels.flatMap(({ modules }) => modules),
  // transversais
  'infra',
  'deps',
  'docs',
  'repo',
];

/** Escopos isentos do rodapé `Refs: US-NNN` (atualizações automáticas do Renovate). */
const SCOPES_WITHOUT_STORY = new Set(['deps']);

const STORY_REF = /^Refs:\s*US-\d{3}(\s*,\s*US-\d{3})*\s*$/m;
const DECISION_REF = /\b(DEC|ADR)-\d{3}\b/;

/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        'footer-story-ref': ({ type, scope, raw }) => {
          if (type === 'revert' || (scope && SCOPES_WITHOUT_STORY.has(scope))) return [true];
          return [
            STORY_REF.test(raw ?? ''),
            'inclua o rodapé "Refs: US-NNN" com a story do commit',
          ];
        },
        'breaking-change-decision-ref': ({ notes }) => {
          const breaking = (notes ?? []).filter((note) => note.title.startsWith('BREAKING'));
          if (breaking.length === 0) return [true];
          return [
            breaking.every((note) => DECISION_REF.test(note.text)),
            'BREAKING CHANGE deve citar a decisão que o autoriza (DEC-NNN ou ADR-NNN)',
          ];
        },
      },
    },
  ],
  rules: {
    'type-enum': [2, 'always', TYPES],
    'scope-enum': [2, 'always', SCOPES],
    'scope-empty': [2, 'never'],
    'subject-max-length': [2, 'always', 100],
    'header-max-length': [2, 'always', 120],
    'footer-story-ref': [2, 'always'],
    'breaking-change-decision-ref': [2, 'always'],
  },
  helpUrl: 'CONTRIBUTING.md#commits',
  prompt: {
    messages: {
      emptyWarning: 'Use `tipo(escopo): assunto` — ex.: `feat(api): adiciona filtro RFC 9457`.',
    },
  },
};
