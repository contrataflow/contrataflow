import { DEFAULT_TEMPLATE_LAYOUT, sectionDefinitionSchema } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { canonicalJson, sha256Hex } from '#shared/integrity/canonical-json.js';

import {
  createDocumentTemplate,
  newTemplateVersionFrom,
  publishTemplateVersion,
  retireTemplateVersion,
  TemplateContentInvalidError,
  templateContentHash,
  TemplateInactiveError,
  TemplateInUseError,
  TemplateVersionNotDraftError,
  TemplateVersionNotPublishedError,
} from './document-template.js';
import type {
  DocumentTemplate,
  DocumentTemplateVersion,
  TemplateDocumentType,
} from './document-template.js';
import { DefaultTemplateRuleError, setDefaultTemplate } from './document-type.js';
import type { DocumentType } from './document-type.js';
import { buildSystemDocumentTypes } from './system-document-types.js';
import type { TemplateValidationContext } from './template-content.validator.js';

/* US-108 · RN-TPL-13..20: publicar, aposentar, nova versão, `contentHash` e padrão do tipo. */

const NOW = new Date('2026-10-15T12:00:00.000Z');
const LATER = new Date('2026-10-15T13:00:00.000Z');
const TENANT = '0192f000-0000-7000-8000-0000000000aa';
const USER = '0192f000-0000-7000-8000-0000000000u1';

const OFICIO: TemplateDocumentType = {
  id: '0192f000-0000-7000-8000-0000000000d1',
  code: 'OFICIO',
  name: 'Ofício',
  kind: 'FREE_TEXT',
  systemModule: null,
  defaultConfidentiality: 'INTERNAL',
};
const CONTEXT: TemplateValidationContext = { documentType: OFICIO, importSources: null };

const section = (key: string, order: number, extra: Record<string, unknown> = {}) =>
  sectionDefinitionSchema.parse({ key, title: key, order, ...extra });

let sequence = 0;
const nextId = () => `0192f000-0000-7000-8000-${String(++sequence).padStart(12, '0')}`;

/** Template "Ofício padrão" com a versão 1 em rascunho com duas seções. */
function oficio(): { template: DocumentTemplate; draft: DocumentTemplateVersion } {
  const { template, draft } = createDocumentTemplate({ name: 'Ofício padrão' }, OFICIO, {
    templateId: nextId(),
    versionId: nextId(),
    tenantId: TENANT,
    now: NOW,
    userId: USER,
  });
  return {
    template,
    draft: { ...draft, sections: [section('OBJETO', 1), section('FUNDAMENTACAO', 2)] },
  };
}

describe('templateContentHash (RN-TPL-15 · DEC-017)', () => {
  it('SHA-256 do JSON canonicalizado (RFC 8785) de sections, layout, fieldConfig e importMappings', () => {
    const { draft } = oficio();
    const expected = sha256Hex(
      canonicalJson({
        sections: JSON.parse(JSON.stringify(draft.sections)) as unknown,
        layout: draft.layout,
        fieldConfig: draft.fieldConfig,
        importMappings: draft.importMappings,
      }),
    );
    expect(templateContentHash(draft)).toBe(expected);
    expect(templateContentHash(draft)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('determinístico: mesma entrada (chaves em outra ordem) → mesmo hash; conteúdo diferente → outro', () => {
    const { draft } = oficio();
    const reordered = {
      importMappings: draft.importMappings,
      fieldConfig: {},
      layout: Object.fromEntries(Object.entries(DEFAULT_TEMPLATE_LAYOUT).reverse()),
      sections: draft.sections.map((item) => Object.fromEntries(Object.entries(item).reverse())),
    } as unknown as DocumentTemplateVersion;
    expect(templateContentHash(reordered)).toBe(templateContentHash(draft));
    expect(templateContentHash({ ...draft, sections: [section('OBJETO', 1)] })).not.toBe(
      templateContentHash(draft),
    );
    // Metadados (notas, datas, número) não entram no hash.
    const renoted: DocumentTemplateVersion = {
      ...draft,
      changeNotes: 'outra nota',
      versionNumber: 9,
      updatedAt: LATER,
    };
    expect(templateContentHash(renoted)).toBe(templateContentHash(draft));
  });
});

describe('publishTemplateVersion (RN-TPL-14/15/16)', () => {
  it('rascunho válido: PUBLISHED com publishedAt/By e contentHash; vira a corrente do template', () => {
    const { template, draft } = oficio();
    const { version, template: next } = publishTemplateVersion(template, draft, CONTEXT, {
      now: LATER,
      userId: USER,
    });
    expect(version).toMatchObject({
      status: 'PUBLISHED',
      publishedAt: LATER,
      publishedById: USER,
      contentHash: templateContentHash(draft),
      updatedAt: LATER,
      sections: draft.sections,
    });
    expect(next).toMatchObject({ currentPublishedVersionId: draft.id, updatedAt: LATER });
    // Registros imutáveis: as entradas não mudam.
    expect(draft.status).toBe('DRAFT');
    expect(template.currentPublishedVersionId).toBeNull();
  });

  it('versão fora de DRAFT → TemplateVersionNotDraftError', () => {
    const { template, draft } = oficio();
    expect(() =>
      publishTemplateVersion(template, { ...draft, status: 'PUBLISHED' }, CONTEXT, {
        now: LATER,
        userId: USER,
      }),
    ).toThrow(TemplateVersionNotDraftError);
  });

  it('template inativo → TemplateInactiveError', () => {
    const { template, draft } = oficio();
    expect(() =>
      publishTemplateVersion({ ...template, isActive: false }, draft, CONTEXT, {
        now: LATER,
        userId: USER,
      }),
    ).toThrow(TemplateInactiveError);
  });

  it('validação completa: variável desconhecida e bloco incompatível → TEMPLATE_INVALID consolidado', () => {
    const { template, draft } = oficio();
    const invalid = {
      ...draft,
      sections: [
        section('OBJETO', 1, { helpText: 'Use {{processo.inexistente}}' }),
        section('ITENS', 2, { render: 'ITEMS_TABLE' }),
      ],
    };
    try {
      publishTemplateVersion(template, invalid, CONTEXT, { now: LATER, userId: USER });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateContentInvalidError);
      expect((error as TemplateContentInvalidError).violations.map((v) => v.code)).toEqual([
        'TEMPLATE_VARIABLE_UNKNOWN',
        'TEMPLATE_RENDER_NOT_ALLOWED',
      ]);
    }
  });
});

describe('retireTemplateVersion (RN-TPL-17/18)', () => {
  const published = () => {
    const { template, draft } = oficio();
    const v1 = publishTemplateVersion(template, draft, CONTEXT, { now: NOW, userId: USER });
    const v2Draft = newTemplateVersionFrom(v1.version, {
      versionId: nextId(),
      now: NOW,
      userId: USER,
    });
    const v2 = publishTemplateVersion(v1.template, v2Draft, CONTEXT, { now: NOW, userId: USER });
    return { template: v2.template, v1: v1.version, v2: v2.version };
  };

  it('versão não corrente: RETIRED com retiredAt/By; o template não muda', () => {
    const { template, v1, v2 } = published();
    const result = retireTemplateVersion(template, v1, [v1, v2], null, {
      now: LATER,
      userId: USER,
    });
    expect(result.version).toMatchObject({
      status: 'RETIRED',
      retiredAt: LATER,
      retiredById: USER,
      contentHash: v1.contentHash,
    });
    expect(result.template).toBeNull();
  });

  it('versão corrente com outra publicada: a de maior número assume, mesmo sendo padrão de tipo', () => {
    const { template, v1, v2 } = published();
    const result = retireTemplateVersion(
      template,
      v2,
      [v1, v2],
      { name: 'Ofício' },
      {
        now: LATER,
        userId: USER,
      },
    );
    expect(result.template?.currentPublishedVersionId).toBe(v1.id);
  });

  it('versão corrente sem substituta e padrão de tipo ativo → TemplateInUseError com o nome do tipo', () => {
    const { template, v1, v2 } = published();
    const retiredV1 = { ...v1, status: 'RETIRED' as const };
    try {
      retireTemplateVersion(
        template,
        v2,
        [retiredV1, v2],
        { name: 'Ofício' },
        {
          now: LATER,
          userId: USER,
        },
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateInUseError);
      expect((error as TemplateInUseError).documentTypeName).toBe('Ofício');
    }
  });

  it('versão corrente sem substituta e sem ser padrão: a corrente fica nula', () => {
    const { template, v1, v2 } = published();
    const result = retireTemplateVersion(template, v2, [{ ...v1, status: 'RETIRED' }, v2], null, {
      now: LATER,
      userId: USER,
    });
    expect(result.template?.currentPublishedVersionId).toBeNull();
  });

  it.each(['DRAFT', 'RETIRED'] as const)(
    'versão em %s → TemplateVersionNotPublishedError',
    (status) => {
      const { template, v2 } = published();
      expect(() =>
        retireTemplateVersion(template, { ...v2, status }, [], null, { now: LATER, userId: USER }),
      ).toThrow(TemplateVersionNotPublishedError);
    },
  );
});

describe('newTemplateVersionFrom (RN-TPL-13)', () => {
  it('clona o conteúdo da versão mais recente num rascunho com o número seguinte, sem hash nem datas', () => {
    const { template, draft } = oficio();
    const { version: v1 } = publishTemplateVersion(template, draft, CONTEXT, {
      now: NOW,
      userId: USER,
    });
    const retired = { ...v1, status: 'RETIRED' as const, retiredAt: NOW, changeNotes: 'antiga' };
    const next = newTemplateVersionFrom(retired, { versionId: 'v2', now: LATER, userId: USER });
    expect(next).toMatchObject({
      id: 'v2',
      templateId: v1.templateId,
      versionNumber: 2,
      status: 'DRAFT',
      sections: v1.sections,
      layout: v1.layout,
      fieldConfig: v1.fieldConfig,
      importMappings: v1.importMappings,
      changeNotes: null,
      publishedAt: null,
      retiredAt: null,
      contentHash: null,
      createdAt: LATER,
      version: 1,
    });
    // Cópia profunda: editar o rascunho não altera a versão publicada (imutável).
    expect(next.sections).not.toBe(v1.sections);
    expect(templateContentHash(next)).toBe(v1.contentHash);
  });
});

describe('setDefaultTemplate (RN-TPL-19/20)', () => {
  const oficioType = (): DocumentType => {
    const type = buildSystemDocumentTypes(TENANT, NOW, nextId).find((t) => t.code === 'OFICIO');
    if (!type) throw new Error('OFICIO ausente');
    return type;
  };
  const candidate = (type: DocumentType, patch: Record<string, unknown> = {}) => ({
    id: nextId(),
    documentTypeId: type.id,
    isActive: true,
    currentPublishedVersionId: nextId(),
    ...patch,
  });

  it('template do tipo com versão publicada: define o padrão, versão + 1 e a mudança para a auditoria', () => {
    const type = oficioType();
    const template = candidate(type);
    const result = setDefaultTemplate(type, template, { now: LATER, userId: USER });
    expect(result.changed).toBe(true);
    expect(result.next).toMatchObject({
      defaultTemplateId: template.id,
      updatedAt: LATER,
      updatedById: USER,
      version: type.version + 1,
    });
    expect(result.changes).toEqual([{ path: 'defaultTemplateId', old: null, new: template.id }]);
  });

  it('FA-04: trocar o padrão registra o anterior; o mesmo template já padrão não muda nada', () => {
    const type = oficioType();
    const first = candidate(type);
    const second = candidate(type);
    const withFirst = setDefaultTemplate(type, first, { now: LATER, userId: USER }).next;
    const swap = setDefaultTemplate(withFirst, second, { now: LATER, userId: USER });
    expect(swap.changes).toEqual([{ path: 'defaultTemplateId', old: first.id, new: second.id }]);
    const again = setDefaultTemplate(withFirst, first, { now: LATER, userId: USER });
    expect(again).toMatchObject({ changed: false, next: withFirst, changes: [] });
  });

  it('template de outro tipo → OTHER_TYPE; sem versão publicada ou inativo → NOT_PUBLISHED', () => {
    const type = oficioType();
    const reason = (patch: Record<string, unknown>) => {
      try {
        setDefaultTemplate(type, candidate(type, patch), { now: LATER, userId: USER });
        return null;
      } catch (error) {
        return error instanceof DefaultTemplateRuleError ? error.reason : 'other';
      }
    };
    expect(reason({ documentTypeId: nextId() })).toBe('OTHER_TYPE');
    expect(reason({ currentPublishedVersionId: null })).toBe('NOT_PUBLISHED');
    expect(reason({ isActive: false })).toBe('NOT_PUBLISHED');
  });
});
