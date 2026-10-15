import { sectionDefinitionSchema } from '@contrataflow/validation';
import type { Violation } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  availableRenders,
  duplicateSection,
  insertVariable,
  localProblems,
  moveSection,
  newSection,
  toDraft,
  toSections,
  violationsBySection,
} from './template-editor-model';
import type { SectionDraft } from './template-editor-model';

const FREE_TEXT = { kind: 'FREE_TEXT', systemModule: null } as const;
const TR = { kind: 'STRUCTURED', systemModule: 'TERM_OF_REFERENCE' } as const;

const draft = (key: string, extra: Partial<SectionDraft> = {}): SectionDraft => ({
  ...newSection(),
  key,
  title: `Seção ${key}`,
  ...extra,
});

describe('template-editor-model (SCR-114 · US-107)', () => {
  it('ida e volta: seção da API → rascunho → corpo do TPL-08 com ordem pela posição', () => {
    const section = sectionDefinitionSchema.parse({
      key: 'OBJETO',
      title: 'Objeto',
      order: 3,
      helpText: 'Ajuda',
      legalBasis: 'Lei 14.133',
      minChars: 10,
      defaultContent: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Linha 1' }] },
          { type: 'paragraph', content: [{ type: 'text', text: '{{today}}' }] },
        ],
      },
    });
    const value = toDraft(section);
    expect(value).toMatchObject({
      defaultContent: 'Linha 1\n{{today}}',
      minChars: '10',
      maxChars: '50000',
    });
    const [body] = toSections([value]);
    expect(body).toMatchObject({
      key: 'OBJETO',
      order: 1,
      helpText: 'Ajuda',
      legalBasis: 'Lei 14.133',
      minChars: 10,
      maxChars: 50_000,
      render: 'TEXT',
      allowNarrative: true,
    });
    expect(body?.defaultContent?.content).toHaveLength(2);
    // Campos opcionais vazios não vão no corpo.
    const [bare] = toSections([draft('A', { maxChars: '' })]);
    expect(bare).not.toHaveProperty('helpText');
    expect(bare).not.toHaveProperty('defaultContent');
    expect(bare).not.toHaveProperty('minChars');
    expect(bare?.maxChars).toBe(50_000);
  });

  it('FA-01: mover recalcula a ordem; índices fora da lista não mudam nada', () => {
    const list = [draft('A'), draft('B'), draft('C')];
    expect(moveSection(list, 0, 2).map((item) => item.key)).toEqual(['B', 'C', 'A']);
    expect(moveSection(list, 2, 0).map((item) => item.key)).toEqual(['C', 'A', 'B']);
    expect(moveSection(list, 0, 5).map((item) => item.key)).toEqual(['A', 'B', 'C']);
    expect(toSections(moveSection(list, 2, 0)).map((item) => [item.key, item.order])).toEqual([
      ['C', 1],
      ['A', 2],
      ['B', 3],
    ]);
  });

  it('FA-02: duplicar sugere <CHAVE>_COPIA única logo abaixo da original', () => {
    const list = [draft('OBJETO'), draft('OBJETO_COPIA'), draft('FIM')];
    const result = duplicateSection(list, list[0]?.uid ?? '');
    expect(result.drafts.map((item) => item.key)).toEqual([
      'OBJETO',
      'OBJETO_COPIA_2',
      'OBJETO_COPIA',
      'FIM',
    ]);
    expect(result.copyUid).toBe(result.drafts[1]?.uid);
    expect(duplicateSection(list, 'inexistente').copyUid).toBeNull();
  });

  it('validação local: chave vazia/fora do padrão/duplicada, título, variáveis, mínimo × máximo e bloco', () => {
    const list = [
      draft(''),
      draft('objeto'),
      draft('OK', { title: ' ' }),
      draft('OK'),
      draft('VAR', { helpText: '{{document.assinante}}', defaultContent: '{{page}}' }),
      draft('LIMITES', { minChars: '100', maxChars: '10' }),
      draft('NUM', { minChars: '-1', maxChars: '1.5' }),
      draft('ITENS', { render: 'ITEMS_TABLE' }),
    ];
    const problems = localProblems(list, FREE_TEXT).map((item) => [
      list.find((entry) => entry.uid === item.uid)?.key,
      item.field,
      item.message,
    ]);
    expect(problems).toEqual([
      ['', 'key', 'Informe a chave.'],
      ['objeto', 'key', 'Use letras maiúsculas, números e _ (ex.: OBJETO).'],
      ['OK', 'title', 'Informe o título.'],
      ['OK', 'key', 'A chave "OK" já existe nesta versão.'],
      ['VAR', 'helpText', 'A variável {{document.assinante}} não é reconhecida.'],
      ['VAR', 'defaultContent', 'A variável {{page}} não é reconhecida.'],
      ['LIMITES', 'minChars', 'O mínimo não pode ser maior que o máximo.'],
      ['NUM', 'minChars', 'Informe um número inteiro válido.'],
      ['NUM', 'maxChars', 'Informe um número inteiro válido.'],
      ['ITENS', 'render', 'Este tipo de bloco não é permitido para este tipo de documento.'],
    ]);
    expect(localProblems([draft('ITENS', { render: 'ITEMS_TABLE' })], TR)).toEqual([]);
  });

  it('blocos por tipo de documento (RN-TPL-05)', () => {
    expect(availableRenders(FREE_TEXT)).toEqual(['TEXT']);
    expect(availableRenders(TR)).toContain('ITEMS_TABLE');
    expect(availableRenders(TR)).not.toContain('RISK_MATRIX');
  });

  it('violações do 422 agrupadas por seção, e as gerais à parte', () => {
    const violation = (sectionKey: string | null, code: string): Violation => ({
      code,
      severity: 'BLOCKING',
      message: code,
      ruleId: null,
      sectionKey,
      field: null,
      itemId: null,
      params: {},
    });
    const grouped = violationsBySection([
      violation('OBJETO', 'A'),
      violation('OBJETO', 'B'),
      violation(null, 'C'),
    ]);
    expect(grouped.bySection.get('OBJETO')?.map((item) => item.code)).toEqual(['A', 'B']);
    expect(grouped.general.map((item) => item.code)).toEqual(['C']);
  });

  it('paleta de variáveis insere no cursor ou no fim', () => {
    expect(insertVariable('Hoje é .', 'today', { start: 7, end: 7 })).toEqual({
      text: 'Hoje é {{today}}.',
      cursor: 16,
    });
    expect(insertVariable('Abc', 'user.name').text).toBe('Abc{{user.name}}');
    expect(insertVariable('Trocar XX', 'today', { start: 7, end: 9 }).text).toBe(
      'Trocar {{today}}',
    );
  });
});
