import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { CATEGORIES, applyExceptions, checkBacklog } from '../docs/check-backlog.js';

const realDocs = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');
const SECTIONS = [
  ...readFileSync(join(realDocs, 'backlog/_templates/story-template.md'), 'utf8').matchAll(
    /^## (.+)$/gm,
  ),
].map((m) => m[1] ?? '');
const TEMPLATE = `---\nstatus: Especificada  # Especificada | Pronta para desenvolvimento | Concluída\n---\n\n${SECTIONS.map((s) => `## ${s}\n`).join('\n')}`;

function storyText(id: string, drop?: string): string {
  const fm = `---\nid: ${id}\ntitle: "T"\nepic: EP-001\nfeature: FT-001\nmvp: 1\npriority: P0\nestimate: M\nstatus: Especificada\ndepends_on: []\nmodules: [process]\nscreens: []\nendpoints: []\npermissions: []\nevents: []\n---\n\n`;
  const scenarios = CATEGORIES.filter((c) => c !== drop).map(
    (c) => `  Scenario: [${c}] x\n    Given a\n`,
  );
  const body = SECTIONS.map((s) =>
    s.startsWith('Critérios de aceite')
      ? `## ${s}\n\`\`\`gherkin\nFeature: f\n\n${scenarios.join('\n')}\`\`\`\n`
      : `## ${s}\nx\n`,
  ).join('\n');
  return `${fm}# ${id}\n\n${body}`;
}

const dirs: string[] = [];
function fixture(stories: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'check-backlog-'));
  dirs.push(root);
  const w = (p: string, c: string): void => {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  };
  w('backlog/_templates/story-template.md', TEMPLATE);
  w('backlog/epic-001-e.md', '---\nid: EP-001\ntitle: E\nmvp: 1\n---\n');
  w('backlog/feature-001-f.md', '---\nid: FT-001\ntitle: F\nepic: EP-001\nmvp: 1\n---\n');
  const rows = ['| EP-001 | E | `epic-001-e.md` |', '| FT-001 F | d | `feature-001-f.md` |'];
  for (const [file, text] of Object.entries(stories)) {
    w(`backlog/${file}`, text);
    rows.push(`| US-${file.slice(6, 9)} | T | FT-001 | P0 | M | - | \`${file}\` |`);
  }
  w('mvp-01/features.md', `${[...new Set(rows)].join('\n')}\n`);
  return root;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('checkBacklog', () => {
  it('aceita um card válido', () => {
    const root = fixture({ 'story-001-a.md': storyText('US-001') });
    expect(checkBacklog({ root })).toEqual([]);
  });

  it('aponta a categoria Gherkin ausente', () => {
    const root = fixture({ 'story-001-a.md': storyText('US-001', 'Concorrência') });
    const problems = checkBacklog({ root });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ file: 'backlog/story-001-a.md', rule: 'gherkin' });
    expect(problems[0]?.message).toContain('[Concorrência]');
  });

  it('rejeita id duplicado', () => {
    const root = fixture({
      'story-001-a.md': storyText('US-001'),
      'story-002-b.md': storyText('US-001'),
    });
    const rules = checkBacklog({ root }).map((p) => `${p.file}:${p.rule}`);
    expect(rules).toContain('backlog/story-002-b.md:id-duplicado');
    expect(rules).toContain('backlog/story-002-b.md:id');
  });

  it('rejeita story sem linha no features.md', () => {
    const root = fixture({ 'story-001-a.md': storyText('US-001') });
    writeFileSync(
      join(root, 'mvp-01/features.md'),
      '| EP-001 | E | `epic-001-e.md` |\n| FT-001 F | d | `feature-001-f.md` |\n',
    );
    expect(checkBacklog({ root }).map((p) => p.rule)).toContain('cobertura');
  });

  it('aceita story reservada com ⏳ e sem arquivo', () => {
    const root = fixture({ 'story-001-a.md': storyText('US-001') });
    const text = readFileSync(join(root, 'mvp-01/features.md'), 'utf8');
    writeFileSync(
      join(root, 'mvp-01/features.md'),
      `${text}| US-002 | T | FT-001 | P1 | M | US-001 | \`story-002-b.md\` ⏳ |\n`,
    );
    expect(checkBacklog({ root })).toEqual([]);
  });

  it('exige tirar o ⏳ quando a story já foi escrita', () => {
    const root = fixture({ 'story-001-a.md': storyText('US-001') });
    const text = readFileSync(join(root, 'mvp-01/features.md'), 'utf8');
    writeFileSync(
      join(root, 'mvp-01/features.md'),
      text.replace('`story-001-a.md` |', '`story-001-a.md` ⏳ |'),
    );
    expect(checkBacklog({ root }).map((p) => p.rule)).toEqual(['pendente']);
  });

  it('aceita depends_on para story reservada (⏳) e recusa a desconhecida', () => {
    const root = fixture({
      'story-001-a.md': storyText('US-001').replace('depends_on: []', 'depends_on: [US-002]'),
    });
    const path = join(root, 'mvp-01/features.md');
    const text = readFileSync(path, 'utf8');
    writeFileSync(
      path,
      `${text}| US-002 | T | FT-001 | P1 | M | - | \`story-002-b.md\` ⏳ |
`,
    );
    expect(checkBacklog({ root })).toEqual([]);
    writeFileSync(path, text);
    expect(checkBacklog({ root }).map((p) => p.rule)).toEqual(['referencia']);
  });

  it('confere endpoints e telas das stories contra api/*.md e screens.md', () => {
    const root = fixture({
      'story-001-a.md': storyText('US-001')
        .replace('endpoints: []', 'endpoints: [PRC-01, PRC-99]')
        .replace('screens: []', 'screens: [SCR-004, SCR-999]'),
    });
    mkdirSync(join(root, 'mvp-01/api'), { recursive: true });
    writeFileSync(
      join(root, 'mvp-01/api/02-processes.md'),
      '### PRC-01 — Listar\nx\n### PRC-02 — Criar\nx\n',
    );
    writeFileSync(join(root, 'mvp-01/screens.md'), '### SCR-004 — Processos\n### SCR-005 — Novo\n');
    const got = checkBacklog({ root }).map(
      (p) => `${p.file}:${p.rule}:${/[A-Z]{2,5}-\d{2,3}/.exec(p.message)?.[0] ?? ''}`,
    );
    expect(got.sort()).toEqual(
      [
        'backlog/story-001-a.md:endpoint:PRC-99',
        'backlog/story-001-a.md:tela:SCR-999',
        'mvp-01/api/02-processes.md:endpoint-orfao:PRC-02',
        'mvp-01/screens.md:tela-orfa:SCR-005',
      ].sort(),
    );
  });

  it('só confere endpoints e telas quando os documentos consolidados existem', () => {
    const root = fixture({
      'story-001-a.md': storyText('US-001').replace('endpoints: []', 'endpoints: [PRC-99]'),
    });
    expect(checkBacklog({ root })).toEqual([]);
  });

  it('passa no backlog real do repositório', () => {
    expect(applyExceptions(checkBacklog({ root: realDocs }))).toEqual([]);
  });
});
