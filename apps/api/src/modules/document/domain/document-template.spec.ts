import {
  DEFAULT_TEMPLATE_LAYOUT,
  DEFAULT_TR_IMPORT_MAPPINGS,
  sectionDefinitionSchema,
  SYSTEM_MODULE_SECTION_KEYS,
  TYPED_HEADER_FIELDS,
} from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  changedSectionKeys,
  createDocumentTemplate,
  TemplateContentInvalidError,
  templateNameKey,
  TemplateVersionNotDraftError,
  updateTemplateMetadata,
  updateTemplateVersionContent,
} from './document-template.js';
import type { TemplateDocumentType } from './document-template.js';
import type { TemplateValidationContext } from './template-content.validator.js';

/* US-107 · RN-TPL-01..03, 07, 08, 11, 12: fábrica e edição do template e do rascunho. */

const NOW = new Date('2026-10-15T12:00:00.000Z');
const LATER = new Date('2026-10-15T13:00:00.000Z');
const IDS = {
  templateId: '0192f000-0000-7000-8000-000000000001',
  versionId: '0192f000-0000-7000-8000-000000000002',
  tenantId: '0192f000-0000-7000-8000-0000000000aa',
  now: NOW,
  userId: '0192f000-0000-7000-8000-0000000000u1',
};

const DESPACHO: TemplateDocumentType = {
  id: '0192f000-0000-7000-8000-0000000000d1',
  code: 'DESPACHO',
  name: 'Despacho',
  kind: 'FREE_TEXT',
  systemModule: null,
  defaultConfidentiality: 'INTERNAL',
};
const TR_TYPE: TemplateDocumentType = {
  ...DESPACHO,
  id: '0192f000-0000-7000-8000-0000000000d2',
  code: 'TR',
  kind: 'STRUCTURED',
  systemModule: 'TERM_OF_REFERENCE',
};

const FREE_TEXT_CONTEXT: TemplateValidationContext = {
  documentType: DESPACHO,
  importSources: null,
};

const section = (key: string, order: number, extra: Record<string, unknown> = {}) =>
  sectionDefinitionSchema.parse({ key, title: key, order, ...extra });

describe('createDocumentTemplate (RN-TPL-01/02)', () => {
  it('template ativo e versão 1 em DRAFT com layout padrão, sem seções nem mapeamento fora do TR', () => {
    const { template, draft } = createDocumentTemplate(
      { name: '  Despacho padrão  ', description: '   ' },
      DESPACHO,
      IDS,
    );
    expect(template).toMatchObject({
      id: IDS.templateId,
      documentTypeId: DESPACHO.id,
      name: 'Despacho padrão',
      description: null,
      isActive: true,
      isSystem: false,
      currentPublishedVersionId: null,
      version: 1,
    });
    expect(draft).toMatchObject({
      id: IDS.versionId,
      templateId: IDS.templateId,
      versionNumber: 1,
      status: 'DRAFT',
      sections: [],
      fieldConfig: {},
      importMappings: null,
      layout: DEFAULT_TEMPLATE_LAYOUT,
      version: 1,
    });
    // Cópia: alterar o layout do rascunho não altera a constante.
    expect(draft.layout).not.toBe(DEFAULT_TEMPLATE_LAYOUT);
  });

  it('TR nasce com o mapeamento padrão semeado', () => {
    const { draft } = createDocumentTemplate({ name: 'TR padrão' }, TR_TYPE, IDS);
    expect(draft.importMappings).toEqual(DEFAULT_TR_IMPORT_MAPPINGS);
    expect(draft.importMappings).not.toBe(DEFAULT_TR_IMPORT_MAPPINGS);
  });

  it('nome comparável sem maiúsculas nem espaços nas pontas', () => {
    expect(templateNameKey('  Despacho PADRÃO ')).toBe(templateNameKey('despacho padrão'));
  });
});

describe('updateTemplateMetadata (FA-03 · RN-TPL-11)', () => {
  const { template } = createDocumentTemplate(
    { name: 'Ofício', description: 'Base' },
    DESPACHO,
    IDS,
  );

  it('aplica só o que mudou, com as alterações para a auditoria', () => {
    const result = updateTemplateMetadata(
      template,
      { name: 'Ofício geral', description: null, isActive: false },
      { now: LATER, userId: 'u2' },
    );
    expect(result.changedFields).toEqual(['name', 'description', 'isActive']);
    expect(result.changes).toEqual([
      { path: 'name', old: 'Ofício', new: 'Ofício geral' },
      { path: 'description', old: 'Base', new: null },
      { path: 'isActive', old: true, new: false },
    ]);
    expect(result.next).toMatchObject({
      updatedAt: LATER,
      updatedById: 'u2',
      documentTypeId: DESPACHO.id,
    });
  });

  it('nada alterado devolve o mesmo registro', () => {
    const result = updateTemplateMetadata(
      template,
      { name: ' Ofício ' },
      { now: LATER, userId: 'u2' },
    );
    expect(result.changedFields).toEqual([]);
    expect(result.next).toBe(template);
  });
});

describe('updateTemplateVersionContent (TPL-08 · RN-TPL-03..09, 12)', () => {
  const { draft } = createDocumentTemplate({ name: 'Despacho' }, DESPACHO, IDS);
  const context = { now: LATER, userId: 'u2' };

  it('ordena as seções, normaliza textos e resume o que mudou', () => {
    const result = updateTemplateVersionContent(
      draft,
      {
        sections: [
          section('FUNDAMENTACAO', 2, { helpText: '  ', legalBasis: ' Lei 14.133 ' }),
          section('OBJETO', 1, { minChars: 10 }),
        ],
        changeNotes: '  Ajuste inicial ',
      },
      FREE_TEXT_CONTEXT,
      context,
    );
    expect(result.next.sections.map((item) => item.key)).toEqual(['OBJETO', 'FUNDAMENTACAO']);
    expect(result.next.sections[1]).not.toHaveProperty('helpText');
    expect(result.next.sections[1]?.legalBasis).toBe('Lei 14.133');
    expect(result.next.sections[0]?.minChars).toBe(10);
    expect(result.next.changeNotes).toBe('Ajuste inicial');
    expect(result.sectionsChanged).toEqual(['FUNDAMENTACAO', 'OBJETO']);
    expect(result.fieldsChanged).toEqual(['sections', 'changeNotes']);
    expect(result.next.updatedAt).toBe(LATER);
  });

  it('RN-TPL-03: versão publicada ou aposentada não é editável', () => {
    for (const status of ['PUBLISHED', 'RETIRED'] as const) {
      expect(() =>
        updateTemplateVersionContent(
          { ...draft, status },
          { sections: [] },
          FREE_TEXT_CONTEXT,
          context,
        ),
      ).toThrow(TemplateVersionNotDraftError);
    }
  });

  it('conteúdo inválido lança TemplateContentInvalidError com as violações', () => {
    try {
      updateTemplateVersionContent(
        draft,
        { sections: [section('A', 1), section('A', 2)] },
        FREE_TEXT_CONTEXT,
        context,
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateContentInvalidError);
      expect((error as TemplateContentInvalidError).violations[0]?.code).toBe(
        'TEMPLATE_SECTION_KEY_DUPLICATE',
      );
    }
  });

  it('nada enviado ou igual ao atual: sem mudança e mesmo registro', () => {
    const result = updateTemplateVersionContent(draft, {}, FREE_TEXT_CONTEXT, context);
    expect(result.fieldsChanged).toEqual([]);
    expect(result.next).toBe(draft);
  });

  it('TR: fieldConfig e importMappings alterados entram no resumo; null remove o mapeamento', () => {
    const { draft: tr } = createDocumentTemplate({ name: 'TR' }, TR_TYPE, IDS);
    const trContext: TemplateValidationContext = {
      documentType: TR_TYPE,
      importSources: {
        sectionKeys: SYSTEM_MODULE_SECTION_KEYS.ETP,
        fieldKeys: TYPED_HEADER_FIELDS.ETP,
      },
    };
    const result = updateTemplateVersionContent(
      tr,
      { fieldConfig: { objectDefinition: { label: 'Objeto' } }, importMappings: null },
      trContext,
      context,
    );
    expect(result.fieldConfigChanged).toBe(true);
    expect(result.importMappingsChanged).toBe(true);
    expect(result.next.importMappings).toBeNull();
    expect(result.fieldsChanged).toEqual(['fieldConfig', 'importMappings']);
  });

  it('changedSectionKeys acusa inclusões, remoções e alterações', () => {
    const before = [section('A', 1), section('B', 2)];
    const after = [section('A', 1, { title: 'Novo' }), section('C', 2)];
    expect(changedSectionKeys(before, after)).toEqual(['A', 'B', 'C']);
    expect(changedSectionKeys(before, before)).toEqual([]);
  });
});
