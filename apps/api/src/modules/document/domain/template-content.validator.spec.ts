import {
  DEFAULT_TR_IMPORT_MAPPINGS,
  sectionDefinitionSchema,
  SECTION_RENDERS,
  SYSTEM_DOCUMENT_MODULES,
  SYSTEM_MODULE_SECTION_KEYS,
  TYPED_HEADER_FIELDS,
} from '@contrataflow/validation';
import type {
  SectionDefinition,
  SectionDefinitionInput,
  SystemDocumentModule,
} from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  FULL_VALIDATION,
  TemplateContentValidator,
  validateTemplateContent,
} from './template-content.validator.js';
import type { TemplateValidationContext } from './template-content.validator.js';

/* US-107 · RN-TPL-04..09: o validador único do editor e da publicação (US-108). */

const section = (
  input: Partial<SectionDefinitionInput> & { key: string; order: number },
): SectionDefinition => sectionDefinitionSchema.parse({ title: input.key, ...input });

const FREE_TEXT: TemplateValidationContext = {
  documentType: { kind: 'FREE_TEXT', systemModule: null },
  importSources: null,
};

const structured = (systemModule: SystemDocumentModule): TemplateValidationContext => ({
  documentType: { kind: 'STRUCTURED', systemModule },
  importSources:
    systemModule === 'TERM_OF_REFERENCE'
      ? { sectionKeys: SYSTEM_MODULE_SECTION_KEYS.ETP, fieldKeys: TYPED_HEADER_FIELDS.ETP }
      : null,
});

const TR = structured('TERM_OF_REFERENCE');

const content = (
  sections: SectionDefinition[],
  extra: Partial<{
    fieldConfig: Record<string, object>;
    importMappings: typeof DEFAULT_TR_IMPORT_MAPPINGS | null;
  }> = {},
) => ({
  sections,
  fieldConfig: extra.fieldConfig ?? {},
  importMappings: extra.importMappings ?? null,
});

const codes = (violations: { code: string }[]) => violations.map((violation) => violation.code);

describe('TemplateContentValidator — seções (RN-TPL-04)', () => {
  it('conteúdo válido não tem achados', () => {
    expect(
      validateTemplateContent(
        content([
          section({ key: 'OBJETO', order: 1 }),
          section({ key: 'FUNDAMENTACAO', order: 2 }),
        ]),
        FREE_TEXT,
      ),
    ).toEqual([]);
    expect(validateTemplateContent(content([]), FREE_TEXT)).toEqual([]);
  });

  it('chave fora do padrão e duplicada (uma vez por chave)', () => {
    const violations = validateTemplateContent(
      content([
        section({ key: 'objeto', order: 1 }),
        section({ key: 'OBJETO', order: 2 }),
        section({ key: 'OBJETO', order: 3 }),
        section({ key: 'OBJETO', order: 4 }),
      ]),
      FREE_TEXT,
    );
    expect(violations.map((v) => [v.code, v.sectionKey, v.field])).toEqual([
      ['TEMPLATE_SECTION_KEY_INVALID', 'objeto', 'key'],
      ['TEMPLATE_SECTION_KEY_DUPLICATE', 'OBJETO', 'key'],
    ]);
    expect(violations[0]).toMatchObject({ severity: 'BLOCKING', ruleId: null, itemId: null });
  });

  it('ordem: buraco, repetição e início diferente de 1', () => {
    for (const orders of [
      [1, 3],
      [1, 1],
      [2, 3],
    ]) {
      const violations = validateTemplateContent(
        content(orders.map((order, index) => section({ key: `S${index}`, order }))),
        FREE_TEXT,
      );
      expect(codes(violations)).toEqual(['TEMPLATE_SECTION_ORDER_INVALID']);
    }
  });
});

describe('TemplateContentValidator — bloco × tipo (RN-TPL-05)', () => {
  const allowed: Record<SystemDocumentModule | 'FREE_TEXT', readonly string[]> = {
    DFD: ['TEXT', 'ITEMS_TABLE', 'ALTERNATIVES_TABLE', 'PRICE_SUMMARY', 'ESTIMATED_VALUE'],
    ETP: ['TEXT', 'ITEMS_TABLE', 'ALTERNATIVES_TABLE', 'PRICE_SUMMARY', 'ESTIMATED_VALUE'],
    TERM_OF_REFERENCE: [
      'TEXT',
      'ITEMS_TABLE',
      'ALTERNATIVES_TABLE',
      'PRICE_SUMMARY',
      'ESTIMATED_VALUE',
    ],
    RISK_MAP: ['TEXT', 'RISK_MATRIX', 'RISK_LIST'],
    PRICE_RESEARCH: ['TEXT', 'PRICE_SUMMARY', 'ESTIMATED_VALUE'],
    FREE_TEXT: ['TEXT'],
  };

  it.each([...SYSTEM_DOCUMENT_MODULES, 'FREE_TEXT' as const])(
    'combinações render × %s',
    (module) => {
      const context = module === 'FREE_TEXT' ? FREE_TEXT : structured(module);
      for (const render of SECTION_RENDERS) {
        const violations = validateTemplateContent(
          content([section({ key: 'BLOCO', order: 1, render })]),
          context,
        );
        const expected = allowed[module].includes(render) ? [] : ['TEMPLATE_RENDER_NOT_ALLOWED'];
        expect(codes(violations), `${render} em ${module}`).toEqual(expected);
      }
    },
  );

  it('UPLOADED só aceita TEXT', () => {
    const uploaded: TemplateValidationContext = {
      documentType: { kind: 'UPLOADED', systemModule: null },
      importSources: null,
    };
    expect(
      codes(
        validateTemplateContent(
          content([section({ key: 'A', order: 1, render: 'ESTIMATED_VALUE' })]),
          uploaded,
        ),
      ),
    ).toEqual(['TEMPLATE_RENDER_NOT_ALLOWED']);
  });
});

describe('TemplateContentValidator — variáveis (RN-TPL-06)', () => {
  it('aceita o catálogo de seções em helpText e defaultContent', () => {
    const violations = validateTemplateContent(
      content([
        section({
          key: 'OBJETO',
          order: 1,
          helpText: '{{tenant.name}} {{organization.cnpj}} {{ user.name }}',
          defaultContent: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: '{{process.code}} em {{today}}' }],
              },
            ],
          },
        }),
      ]),
      FREE_TEXT,
    );
    expect(violations).toEqual([]);
  });

  it('recusa variável desconhecida e as de renderização, apontando o campo', () => {
    const violations = validateTemplateContent(
      content([
        section({
          key: 'OBJETO',
          order: 1,
          helpText: '{{pages}}',
          defaultContent: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: '{{document.assinante}} {{document.version}}' }],
              },
            ],
          },
        }),
      ]),
      FREE_TEXT,
    );
    expect(violations.map((v) => [v.field, v.params.variable, v.message])).toEqual([
      ['helpText', 'pages', 'A variável {{pages}} não é reconhecida.'],
      [
        'defaultContent',
        'document.assinante',
        'A variável {{document.assinante}} não é reconhecida.',
      ],
      ['defaultContent', 'document.version', 'A variável {{document.version}} não é reconhecida.'],
    ]);
  });
});

describe('TemplateContentValidator — fieldConfig (RN-TPL-07)', () => {
  it('só em tipos estruturados e com as chaves do cabeçalho do módulo', () => {
    expect(
      codes(
        validateTemplateContent(content([], { fieldConfig: { objectSummary: {} } }), FREE_TEXT),
      ),
    ).toEqual(['TEMPLATE_FIELD_CONFIG_NOT_ALLOWED']);
    expect(
      validateTemplateContent(
        content([], { fieldConfig: { objectSummary: { required: true } } }),
        structured('DFD'),
      ),
    ).toEqual([]);
    const unknown = validateTemplateContent(
      content([], { fieldConfig: { inventado: {} } }),
      structured('DFD'),
    );
    expect(unknown).toEqual([
      expect.objectContaining({ code: 'TEMPLATE_FIELD_UNKNOWN', field: 'fieldConfig.inventado' }),
    ]);
    // Mapa de riscos não tem cabeçalho tipado.
    expect(
      codes(
        validateTemplateContent(
          content([], { fieldConfig: { probability: {} } }),
          structured('RISK_MAP'),
        ),
      ),
    ).toEqual(['TEMPLATE_FIELD_UNKNOWN']);
  });
});

describe('TemplateContentValidator — importMappings (RN-TPL-08)', () => {
  const trSections = SYSTEM_MODULE_SECTION_KEYS.TERM_OF_REFERENCE.map((key, index) =>
    section({ key, order: index + 1 }),
  );

  it('mapeamento padrão com as seções do TR e as do ETP é válido', () => {
    expect(
      validateTemplateContent(
        content(trSections, { importMappings: DEFAULT_TR_IMPORT_MAPPINGS }),
        TR,
      ),
    ).toEqual([]);
  });

  it('só no TR', () => {
    expect(
      codes(
        validateTemplateContent(
          content([], { importMappings: DEFAULT_TR_IMPORT_MAPPINGS }),
          structured('ETP'),
        ),
      ),
    ).toEqual(['TEMPLATE_IMPORT_MAPPINGS_NOT_ALLOWED']);
  });

  it('alvo inexistente, alvo repetido, fonte fora do ETP e campo inexistente', () => {
    const violations = validateTemplateContent(
      content([section({ key: 'OBJECT', order: 1 })], {
        importMappings: {
          ...DEFAULT_TR_IMPORT_MAPPINGS,
          sections: [
            { target: 'OBJECT', sources: ['RECOMMENDED_SOLUTION', 'NAO_EXISTE'], mode: 'REPLACE' },
            { target: 'OBJECT', sources: ['PROBLEM'], mode: 'APPEND' },
            { target: 'FALTANTE', sources: ['PROBLEM'], mode: 'APPEND' },
          ],
          fields: [
            { target: 'estimatedTotalValue', source: 'estimatedTotalValue' },
            { target: 'naoExiste', source: 'priceResearchId' },
          ],
        },
      }),
      TR,
    );
    expect(violations.map((v) => [v.code, v.sectionKey])).toEqual([
      ['TEMPLATE_IMPORT_SOURCE_UNKNOWN', 'OBJECT'],
      ['TEMPLATE_IMPORT_TARGET_DUPLICATE', 'OBJECT'],
      ['TEMPLATE_IMPORT_TARGET_UNKNOWN', 'FALTANTE'],
      ['TEMPLATE_IMPORT_FIELD_UNKNOWN', null],
    ]);
  });

  it('fontes vêm da versão publicada do ETP padrão quando o contexto as informa', () => {
    const context: TemplateValidationContext = {
      ...TR,
      importSources: { sectionKeys: ['SOLUCAO'], fieldKeys: [] },
    };
    const violations = validateTemplateContent(
      content([section({ key: 'OBJECT', order: 1 })], {
        importMappings: {
          ...DEFAULT_TR_IMPORT_MAPPINGS,
          sections: [{ target: 'OBJECT', sources: ['SOLUCAO'], mode: 'REPLACE' }],
          fields: [],
        },
      }),
      context,
    );
    expect(violations).toEqual([]);
  });
});

describe('escopo da validação (rascunho × publicação)', () => {
  it('o rascunho confere só as partes enviadas; a publicação confere tudo', () => {
    const value = content([section({ key: 'OBJECT', order: 1 })], {
      importMappings: DEFAULT_TR_IMPORT_MAPPINGS,
    });
    const draftScope = { sections: true, fieldConfig: false, importMappings: false };
    expect(validateTemplateContent(value, TR, draftScope)).toEqual([]);
    expect(
      new TemplateContentValidator().validate(value, TR, FULL_VALIDATION).length,
    ).toBeGreaterThan(0);
    expect(new TemplateContentValidator().validate(value, TR)).toEqual(
      validateTemplateContent(value, TR, FULL_VALIDATION),
    );
  });
});
