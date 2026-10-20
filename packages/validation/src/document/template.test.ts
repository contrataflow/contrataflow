import { describe, expect, it } from 'vitest';

import {
  richTextDocSchema,
  richTextFromPlainText,
  richTextPlainText,
  richTextProblem,
} from './rich-text.js';
import {
  DEFAULT_SECTION_MAX_CHARS,
  DEFAULT_TR_IMPORT_MAPPINGS,
  importMappingsSchema,
  isRenderAllowed,
  SECTION_KEY_PATTERN,
  SECTION_TEMPLATE_VARIABLES,
  sectionDefinitionSchema,
  SYSTEM_MODULE_SECTION_KEYS,
  templateCreateSchema,
  templateListQuerySchema,
  templateUpdateSchema,
  templateVariablesIn,
  templateVersionUpdateSchema,
  unknownVariableMessage,
} from './template.js';

const TYPE_ID = '0192f000-0000-7000-8000-0000000000a1';

describe('sectionDefinitionSchema (entities.md §5.1 · RN-TPL-04)', () => {
  it('aplica os padrões: REQUIRED, maxChars 50.000, TEXT e allowNarrative', () => {
    const parsed = sectionDefinitionSchema.parse({ key: 'OBJETO', title: 'Objeto', order: 1 });
    expect(parsed).toEqual({
      key: 'OBJETO',
      title: 'Objeto',
      order: 1,
      requirement: 'REQUIRED',
      maxChars: DEFAULT_SECTION_MAX_CHARS,
      render: 'TEXT',
      allowNarrative: true,
    });
  });

  it('V-10: minChars maior que maxChars é erro de campo em minChars', () => {
    const result = sectionDefinitionSchema.safeParse({
      key: 'OBJETO',
      title: 'Objeto',
      order: 1,
      minChars: 200,
      maxChars: 100,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['minChars'],
      message: 'O mínimo não pode ser maior que o máximo.',
    });
  });

  it('recusa título vazio, ordem 0, requirement e render fora do enum e campos extras', () => {
    for (const section of [
      { key: 'A', title: '', order: 1 },
      { key: 'A', title: 'A', order: 0 },
      { key: 'A', title: 'A', order: 1, requirement: 'MAYBE' },
      { key: 'A', title: 'A', order: 1, render: 'CHART' },
      { key: 'A', title: 'A', order: 1, aiHints: 'x' },
      { key: 'A', title: 'A', order: 1, helpText: 'x'.repeat(2001) },
      { key: 'A', title: 'A', order: 1, legalBasis: 'x'.repeat(301) },
    ]) {
      expect(sectionDefinitionSchema.safeParse(section).success).toBe(false);
    }
  });

  it('a chave fora do padrão passa no schema (é TEMPLATE_INVALID no validador) e o padrão confere', () => {
    expect(sectionDefinitionSchema.safeParse({ key: 'objeto', title: 'A', order: 1 }).success).toBe(
      true,
    );
    expect(SECTION_KEY_PATTERN.test('OBJETO_2')).toBe(true);
    expect(SECTION_KEY_PATTERN.test('objeto')).toBe(false);
    expect(SECTION_KEY_PATTERN.test('OBJETO__X')).toBe(false);
    expect(SECTION_KEY_PATTERN.test('_OBJETO')).toBe(false);
  });
});

describe('conteúdo rico (DEC-056)', () => {
  const doc = (content: unknown[]) => ({ type: 'doc', content });

  it('aceita parágrafos, títulos, listas e marks permitidos', () => {
    const value = doc([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Objeto' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Ver ', marks: [{ type: 'bold' }] },
          {
            type: 'text',
            text: 'portal',
            marks: [{ type: 'link', attrs: { href: 'https://gov.br' } }],
          },
        ],
      },
      {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
      },
    ]);
    expect(richTextProblem(value)).toBeNull();
    expect(richTextDocSchema.safeParse(value).success).toBe(true);
  });

  it('rejeita nós e marks desconhecidos, links inseguros, atributos não primitivos e excesso de tamanho', () => {
    expect(richTextProblem(doc([{ type: 'script' }]))).toMatch(/não é permitido/);
    expect(
      richTextProblem(
        doc([
          { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'color' }] }] },
        ]),
      ),
    ).toMatch(/não é permitida/);
    expect(
      richTextProblem(
        doc([
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'x',
                marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
              },
            ],
          },
        ]),
      ),
    ).toMatch(/Links/);
    expect(richTextProblem(doc([{ type: 'paragraph', attrs: { style: { color: 'red' } } }]))).toBe(
      'Conteúdo rico malformado.',
    );
    expect(richTextProblem(doc([{ type: 'paragraph', onclick: 'x' }]))).toBe(
      'Conteúdo rico malformado.',
    );
    expect(richTextProblem(doc([{ type: 'doc' }]))).toMatch(/não é permitido/);
    expect(richTextProblem({ type: 'paragraph' })).toBe('Conteúdo rico malformado.');
    const big = doc([
      { type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(1024 * 1024) }] },
    ]);
    expect(richTextProblem(big)).toMatch(/1 MB/);
    expect(richTextDocSchema.safeParse(big).success).toBe(false);
  });

  it('texto puro ↔ documento', () => {
    const value = richTextFromPlainText('Linha 1\n\nLinha {{today}}');
    expect(value.content).toHaveLength(3);
    expect(richTextPlainText(value)).toBe('Linha 1\n\nLinha {{today}}');
    expect(richTextFromPlainText('   ')).toEqual({ type: 'doc', content: [] });
    expect(richTextPlainText(null)).toBe('');
  });
});

describe('variáveis (entities.md §5.2 · RN-TPL-06)', () => {
  it('extrai variáveis sem repetição e ignora espaços internos', () => {
    expect(templateVariablesIn('{{ process.code }} e {{today}} e {{process.code}}')).toEqual([
      'process.code',
      'today',
    ]);
    expect(templateVariablesIn('sem variáveis {chave}')).toEqual([]);
    expect(templateVariablesIn('{{ }} e {{\n process.code\t}}')).toEqual(['', 'process.code']);
  });

  it('entrada adversarial ({{ seguido de muitos espaços, sem fechamento) roda em tempo linear', () => {
    const startedAt = performance.now();
    expect(templateVariablesIn(`{{{{${' '.repeat(100_000)}`)).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it('variáveis de renderização ficam fora das seções e a mensagem segue V-05', () => {
    expect(SECTION_TEMPLATE_VARIABLES).not.toContain('document.hash');
    expect(SECTION_TEMPLATE_VARIABLES).not.toContain('page');
    expect(SECTION_TEMPLATE_VARIABLES).toContain('process.object');
    expect(unknownVariableMessage('document.assinante')).toBe(
      'A variável {{document.assinante}} não é reconhecida.',
    );
  });
});

describe('isRenderAllowed (RN-TPL-05)', () => {
  const structured = (
    systemModule: 'DFD' | 'ETP' | 'TERM_OF_REFERENCE' | 'RISK_MAP' | 'PRICE_RESEARCH',
  ) => ({ kind: 'STRUCTURED', systemModule }) as const;
  const freeText = { kind: 'FREE_TEXT', systemModule: null } as const;

  it('TEXT vale em qualquer tipo; FREE_TEXT/UPLOADED só aceitam TEXT', () => {
    expect(isRenderAllowed('TEXT', freeText)).toBe(true);
    expect(isRenderAllowed('ITEMS_TABLE', freeText)).toBe(false);
    expect(isRenderAllowed('ESTIMATED_VALUE', { kind: 'UPLOADED', systemModule: null })).toBe(
      false,
    );
  });

  it('tabelas em DFD/ETP/TR, riscos só no mapa de riscos, valores na pesquisa e nos demais', () => {
    expect(isRenderAllowed('ITEMS_TABLE', structured('TERM_OF_REFERENCE'))).toBe(true);
    expect(isRenderAllowed('ALTERNATIVES_TABLE', structured('ETP'))).toBe(true);
    expect(isRenderAllowed('ITEMS_TABLE', structured('RISK_MAP'))).toBe(false);
    expect(isRenderAllowed('RISK_MATRIX', structured('RISK_MAP'))).toBe(true);
    expect(isRenderAllowed('RISK_LIST', structured('ETP'))).toBe(false);
    expect(isRenderAllowed('PRICE_SUMMARY', structured('PRICE_RESEARCH'))).toBe(true);
    expect(isRenderAllowed('ESTIMATED_VALUE', structured('TERM_OF_REFERENCE'))).toBe(true);
    expect(isRenderAllowed('ESTIMATED_VALUE', structured('RISK_MAP'))).toBe(false);
  });
});

describe('importMappings (entities.md §5.8)', () => {
  it('o mapeamento padrão do TR é válido e aponta para seções de referência do ETP e do TR', () => {
    expect(importMappingsSchema.safeParse(DEFAULT_TR_IMPORT_MAPPINGS).success).toBe(true);
    for (const mapping of DEFAULT_TR_IMPORT_MAPPINGS.sections) {
      expect(SYSTEM_MODULE_SECTION_KEYS.TERM_OF_REFERENCE).toContain(mapping.target);
      for (const source of mapping.sources)
        expect(SYSTEM_MODULE_SECTION_KEYS.ETP).toContain(source);
    }
  });

  it('recusa origem diferente de ETP, modo fora do enum e mapeamento sem fontes', () => {
    const base = DEFAULT_TR_IMPORT_MAPPINGS;
    expect(importMappingsSchema.safeParse({ ...base, fromDocumentType: 'DFD' }).success).toBe(
      false,
    );
    expect(
      importMappingsSchema.safeParse({
        ...base,
        sections: [{ target: 'OBJECT', sources: [], mode: 'REPLACE' }],
      }).success,
    ).toBe(false);
    expect(
      importMappingsSchema.safeParse({
        ...base,
        sections: [{ target: 'OBJECT', sources: ['X'], mode: 'MERGE' }],
      }).success,
    ).toBe(false);
  });
});

describe('requisições TPL-01/02/04/08', () => {
  it('TPL-02: nome 3–150, tipo UUIDv7 e descrição até 2.000', () => {
    expect(
      templateCreateSchema.safeParse({ name: 'Despacho padrão', documentTypeId: TYPE_ID }).success,
    ).toBe(true);
    expect(templateCreateSchema.safeParse({ name: 'De', documentTypeId: TYPE_ID }).success).toBe(
      false,
    );
    expect(
      templateCreateSchema.safeParse({ name: 'x'.repeat(151), documentTypeId: TYPE_ID }).success,
    ).toBe(false);
    expect(
      templateCreateSchema.safeParse({ name: 'Despacho', documentTypeId: 'abc' }).success,
    ).toBe(false);
    expect(
      templateCreateSchema.safeParse({
        name: 'Despacho',
        documentTypeId: TYPE_ID,
        description: 'x'.repeat(2001),
      }).success,
    ).toBe(false);
  });

  it('TPL-04: documentTypeId é imutável (campo não aceito)', () => {
    expect(templateUpdateSchema.safeParse({ isActive: false }).success).toBe(true);
    expect(templateUpdateSchema.safeParse({ documentTypeId: TYPE_ID }).success).toBe(false);
  });

  it('TPL-08: corpo parcial com changeNotes até 1.000 e o layout da US-109', () => {
    expect(templateVersionUpdateSchema.safeParse({}).success).toBe(true);
    expect(templateVersionUpdateSchema.safeParse({ changeNotes: 'x'.repeat(1001) }).success).toBe(
      false,
    );
    expect(templateVersionUpdateSchema.safeParse({ layout: {} }).success).toBe(true);
    expect(templateVersionUpdateSchema.safeParse({ layout: { fontSizePt: 20 } }).success).toBe(
      false,
    );
    expect(
      templateVersionUpdateSchema.safeParse({
        fieldConfig: { objectSummary: { label: 'Objeto', required: true } },
      }).success,
    ).toBe(true);
  });

  it('TPL-01: paginação padrão 50 e filtro por tipo', () => {
    expect(templateListQuerySchema.parse({ isActive: 'true' })).toEqual({
      isActive: true,
      page: 1,
      pageSize: 50,
    });
  });
});
