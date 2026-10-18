import {
  DEFAULT_TEMPLATE_LAYOUT,
  DEFAULT_TR_IMPORT_MAPPINGS,
  layoutDefinitionSchema,
  sectionDefinitionSchema,
} from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { publishTemplateVersion, templateContentHash } from './document-template.js';
import {
  createSystemTemplate,
  loadTemplateLibrary,
  TEMPLATE_LIBRARY,
  TEMPLATE_LIBRARY_TYPE_CODES,
  TemplateLibraryInvalidError,
} from './template-library.js';
import type { TemplateLibraryEntry } from './template-library.js';

/*
 * US-110 — biblioteca padrão de templates (RN-TPL-28..34). Este teste é a validação do pipeline de
 * build (V-01 · DoD): com a fixture inválida, `pnpm turbo run test` falha e o release não avança.
 */

const RN_TPL_29: Readonly<Record<string, readonly string[]>> = {
  DFD: ['JUSTIFICATION', 'EXPECTED_RESULTS', 'NOTES'],
  ETP: [
    'NEED_DESCRIPTION',
    'PROBLEM',
    'OBJECTIVE',
    'PCA_ALIGNMENT',
    'REQUIREMENTS',
    'MARKET_SURVEY',
    'ALTERNATIVES',
    'ESTIMATES',
    'RECOMMENDED_SOLUTION',
    'PARCELING',
    'RELATED_CONTRACTS',
    'EXPECTED_RESULTS',
    'ENVIRONMENTAL_IMPACTS',
    'PRIOR_MEASURES',
    'RISKS',
    'CONCLUSION',
  ],
  TR: [
    'OBJECT',
    'JUSTIFICATION',
    'SPECIFICATIONS',
    'ACCEPTANCE_CRITERIA',
    'CONTRACTOR_OBLIGATIONS',
    'CONTRACTING_PARTY_OBLIGATIONS',
    'DEADLINES',
    'DELIVERY',
    'PAYMENT',
    'OVERSIGHT',
    'GUARANTEES',
    'SANCTIONS',
    'SELECTION_CRITERIA',
    'ESTIMATED_VALUE',
  ],
  RISK_MAP: ['INTRODUCTION', 'METHODOLOGY', 'RISK_MATRIX', 'RISK_LIST', 'NOTES'],
  PRICE_RESEARCH: ['METHODOLOGY', 'PRICE_SUMMARY', 'CONCLUSION'],
  DESPACHO: ['CONTENT'],
  OFICIO: ['CONTENT'],
  NOTA_TECNICA: ['CONTENT'],
  AUTORIZACAO: ['CONTENT'],
  DECLARACAO: ['CONTENT'],
};

const NOW = new Date('2026-10-17T12:00:00.000Z');

function entry(code: string): TemplateLibraryEntry {
  const found = TEMPLATE_LIBRARY.find((candidate) => candidate.documentTypeCode === code);
  if (!found) throw new Error(`entrada ${code} ausente`);
  return found;
}

/** A fixture com a entrada `code` trocada. */
function withEntry(code: string, patch: (entry: TemplateLibraryEntry) => unknown): unknown[] {
  return TEMPLATE_LIBRARY.map((candidate) =>
    candidate.documentTypeCode === code ? patch(structuredClone(candidate)) : candidate,
  );
}

function failureOf(raw: unknown): TemplateLibraryInvalidError {
  try {
    loadTemplateLibrary(raw);
  } catch (error) {
    if (error instanceof TemplateLibraryInvalidError) return error;
    throw error;
  }
  throw new Error('a biblioteca deveria ser recusada');
}

describe('Feature: Biblioteca de templates padrão (US-110)', () => {
  describe('[Sucesso] a fixture do release passa na validação de publicação (RN-TPL-34)', () => {
    const library = loadTemplateLibrary(TEMPLATE_LIBRARY);

    it('cobre os 10 tipos com template e nunca o DOCUMENTO_EXTERNO (RN-TPL-28)', () => {
      expect(library.map((item) => item.documentTypeCode)).toEqual([
        'DFD',
        'ETP',
        'TR',
        'RISK_MAP',
        'PRICE_RESEARCH',
        'DESPACHO',
        'OFICIO',
        'NOTA_TECNICA',
        'AUTORIZACAO',
        'DECLARACAO',
      ]);
      expect(TEMPLATE_LIBRARY_TYPE_CODES).not.toContain('DOCUMENTO_EXTERNO');
      expect(library.map((item) => item.name)).toContain('Termo de Referência — Modelo padrão');
      for (const item of library) expect(item.name).toMatch(/ — Modelo padrão$/);
    });

    it('usa as chaves canônicas na ordem de RN-TPL-29, com order sequencial', () => {
      for (const item of library) {
        expect(item.sections.map((section) => section.key)).toEqual(
          RN_TPL_29[item.documentTypeCode],
        );
        expect(item.sections.map((section) => section.order)).toEqual(
          item.sections.map((_, index) => index + 1),
        );
      }
    });

    it('cada seção passa no sectionDefinitionSchema e o layout no layoutDefinitionSchema', () => {
      for (const raw of TEMPLATE_LIBRARY) {
        for (const section of raw.sections) {
          expect(sectionDefinitionSchema.safeParse(section).success, section.key).toBe(true);
        }
      }
      expect(layoutDefinitionSchema.safeParse(DEFAULT_TEMPLATE_LAYOUT).success).toBe(true);
    });

    it('blocos computados com o render de RN-TPL-29; o restante é TEXT', () => {
      const renders = Object.fromEntries(
        library.flatMap((item) =>
          item.sections
            .filter((section) => section.render !== 'TEXT')
            .map((section) => [`${item.documentTypeCode}.${section.key}`, section.render]),
        ),
      );
      expect(renders).toEqual({
        'RISK_MAP.RISK_MATRIX': 'RISK_MATRIX',
        'RISK_MAP.RISK_LIST': 'RISK_LIST',
        'PRICE_RESEARCH.PRICE_SUMMARY': 'PRICE_SUMMARY',
      });
    });

    it('todas as seções trazem helpText; legalBasis nos dispositivos diretos (RN-TPL-30)', () => {
      for (const item of library) {
        for (const section of item.sections) expect(section.helpText, section.key).toBeTruthy();
      }
      const legal = (code: string, key: string) =>
        library.find((i) => i.documentTypeCode === code)?.sections.find((s) => s.key === key)
          ?.legalBasis;
      expect(legal('ETP', 'NEED_DESCRIPTION')).toBe('Lei 14.133/2021, art. 18, §1º, I');
      expect(legal('TR', 'OBJECT')).toMatch(/^Lei 14\.133\/2021, art\. 6º, XXIII/);
      // US-014 · RN-DFD-07: a base legal do DFD semeado detalha o dispositivo.
      expect(legal('DFD', 'JUSTIFICATION')).toBe(
        'Lei 14.133/2021, art. 12, VII; Decreto 10.947/2022, art. 8º, I',
      );
      expect(legal('NOTA_TECNICA', 'CONTENT')).toMatch(/art\. 72/);
      expect(legal('PRICE_RESEARCH', 'CONCLUSION')).toMatch(/art\. 23/);
    });

    it('seção única CONTENT obrigatória, TEXT e com texto-base nos tipos livres (RN-TPL-30)', () => {
      for (const code of ['DESPACHO', 'OFICIO', 'NOTA_TECNICA', 'AUTORIZACAO', 'DECLARACAO']) {
        const [content] = library.find((item) => item.documentTypeCode === code)?.sections ?? [];
        expect(content).toMatchObject({ key: 'CONTENT', requirement: 'REQUIRED', render: 'TEXT' });
        expect(content?.defaultContent?.content?.length).toBeGreaterThan(0);
      }
    });

    it('layout fixo, fieldConfig vazio e importMappings só no TR (RN-TPL-31)', () => {
      for (const item of library) {
        expect(item.layout).toEqual(DEFAULT_TEMPLATE_LAYOUT);
        expect(item.fieldConfig).toEqual({});
        expect(item.importMappings).toEqual(
          item.documentTypeCode === 'TR' ? DEFAULT_TR_IMPORT_MAPPINGS : null,
        );
      }
    });

    it('o template semeado é isSystem e a publicação do editor gera contentHash estável', () => {
      const [dfd] = library;
      if (!dfd) throw new Error('biblioteca vazia');
      const context = {
        templateId: '0192c000-0000-7000-8000-000000011001',
        versionId: '0192c000-0000-7000-8000-000000011002',
        tenantId: '0192c000-0000-7000-8000-000000011003',
        documentTypeId: '0192c000-0000-7000-8000-000000011004',
        now: NOW,
      };
      const { template, draft } = createSystemTemplate(dfd, context);
      expect(template).toMatchObject({ isSystem: true, isActive: true, name: dfd.name });
      expect(draft).toMatchObject({ versionNumber: 1, status: 'DRAFT', createdById: null });

      const validation = {
        documentType: { kind: 'STRUCTURED', systemModule: 'DFD' },
        importSources: null,
      } as const;
      const first = publishTemplateVersion(template, draft, validation, { now: NOW, userId: null });
      const again = createSystemTemplate(loadTemplateLibrary(TEMPLATE_LIBRARY)[0] ?? dfd, {
        ...context,
        templateId: '0192c000-0000-7000-8000-000000011005',
        versionId: '0192c000-0000-7000-8000-000000011006',
      });
      const second = publishTemplateVersion(again.template, again.draft, validation, {
        now: NOW,
        userId: null,
      });
      expect(first.version.status).toBe('PUBLISHED');
      expect(first.version.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(first.version.contentHash).toBe(templateContentHash(draft));
      // Mesmo conteúdo → mesmo hash, independente de ids e tenant.
      expect(second.version.contentHash).toBe(first.version.contentHash);
      expect(first.template.currentPublishedVersionId).toBe(draft.id);
    });
  });

  describe('[Validação] biblioteca inválida é recusada antes do release (V-01)', () => {
    it('render incompatível com o tipo → TEMPLATE_INVALID com o tipo que falhou', () => {
      const error = failureOf(
        withEntry('DESPACHO', (despacho) => ({
          ...despacho,
          sections: [{ ...entry('DESPACHO').sections[0], render: 'RISK_MATRIX' }],
        })),
      );
      expect(error.code).toBe('TEMPLATE_INVALID');
      expect(error.documentTypeCode).toBe('DESPACHO');
      expect(error.violations.map((v) => v.code)).toEqual(['TEMPLATE_RENDER_NOT_ALLOWED']);
      expect(error.message).toMatch(/A biblioteca padrão falhou na validação interna/);
    });

    it('variável desconhecida, chave inválida e ordem com buraco são achados de publicação', () => {
      const error = failureOf(
        withEntry('OFICIO', (oficio) => ({
          ...oficio,
          sections: [{ ...entry('OFICIO').sections[0], key: 'conteudo', order: 2 }],
        })),
      );
      expect(error.documentTypeCode).toBe('OFICIO');
      expect(error.violations.map((v) => v.code).sort()).toEqual([
        'TEMPLATE_SECTION_KEY_INVALID',
        'TEMPLATE_SECTION_ORDER_INVALID',
      ]);

      const variable = failureOf(
        withEntry('DFD', (dfd) => ({
          ...dfd,
          sections: entry('DFD').sections.map((section, index) =>
            index === 0 ? { ...section, helpText: 'Use {{processo.codigo}}.' } : section,
          ),
        })),
      );
      expect(variable.violations.map((v) => v.code)).toEqual(['TEMPLATE_VARIABLE_UNKNOWN']);
    });

    it('mapeamento do TR para seção que o ETP da biblioteca não tem → TEMPLATE_INVALID no TR', () => {
      const error = failureOf(
        withEntry('ETP', (etp) => ({
          ...etp,
          sections: entry('ETP')
            .sections.filter((section) => section.key !== 'RECOMMENDED_SOLUTION')
            .map((section, index) => ({ ...section, order: index + 1 })),
        })),
      );
      expect(error.documentTypeCode).toBe('TR');
      expect(error.violations.map((v) => v.code)).toEqual(['TEMPLATE_IMPORT_SOURCE_UNKNOWN']);
    });

    it('cobertura: tipo ausente, repetido, desconhecido ou UPLOADED', () => {
      expect(
        failureOf(TEMPLATE_LIBRARY.filter((item) => item.documentTypeCode !== 'TR'))
          .documentTypeCode,
      ).toBe('TR');
      expect(failureOf([...TEMPLATE_LIBRARY, entry('DFD')]).problems).toEqual(['tipo repetido']);
      expect(
        failureOf([...TEMPLATE_LIBRARY, { ...entry('DFD'), documentTypeCode: 'CONTRATO' }])
          .documentTypeCode,
      ).toBe('CONTRATO');
      expect(
        failureOf([
          ...TEMPLATE_LIBRARY,
          { ...entry('OFICIO'), documentTypeCode: 'DOCUMENTO_EXTERNO' },
        ]).problems,
      ).toEqual(['tipo UPLOADED sem template']);
    });
  });

  describe('[Falha de integração] definição ausente ou corrompida', () => {
    it('a fixture que não é lista não carrega', () => {
      expect(failureOf(undefined).documentTypeCode).toBe('(biblioteca)');
      expect(failureOf({ DFD: {} }).problems).toEqual(['a definição não é uma lista']);
    });

    it('entrada corrompida é reportada com o tipo de documento (ou a posição)', () => {
      const corrupted = failureOf(
        withEntry('NOTA_TECNICA', (nota) => ({
          ...nota,
          sections: [{ key: 'CONTENT' }],
        })),
      );
      expect(corrupted.documentTypeCode).toBe('NOTA_TECNICA');
      expect(corrupted.problems.join(' ')).toMatch(/sections\.0\.title/);
      expect(failureOf([null]).documentTypeCode).toBe('#1');
    });
  });
});
