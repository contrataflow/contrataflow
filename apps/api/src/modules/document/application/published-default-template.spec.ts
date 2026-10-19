import { describe, expect, it } from 'vitest';

import type { TenantTx } from '#shared/database/prisma.js';

import { publishedDefaultTemplate } from './published-default-template.js';
import type { TemplateRepository } from './template.ports.js';
import {
  buildDocumentType,
  buildTemplateVersion,
  FIXTURE_NOW,
  sectionDefinition,
} from '../../../../test/support/document-fixtures.js';
import type { DocumentTemplate, DocumentTemplateVersion } from '../domain/document-template.js';
import { initialDraftContent, processTemplateVariables } from '../domain/structured-draft.js';

/*
 * RN-DOC-22/23 (US-063): o template padrão publicado do tipo — a regra que decide a criação do
 * documento livre (DOC-02) e o menu "Criar documento" (DOC-01) — e o rascunho inicial com as
 * variáveis do processo resolvidas.
 */

const tx = {} as TenantTx;
const type = buildDocumentType({ defaultTemplateId: 'tpl-1' });

function template(overrides: Partial<DocumentTemplate> = {}): DocumentTemplate {
  return {
    id: 'tpl-1',
    tenantId: type.tenantId,
    documentTypeId: type.id,
    name: 'Despacho — Modelo padrão',
    description: null,
    isActive: true,
    isSystem: true,
    currentPublishedVersionId: 'ver-1',
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    createdById: null,
    updatedById: null,
    version: 1,
    ...overrides,
  };
}

function repository(
  found: DocumentTemplate | null,
  version: DocumentTemplateVersion | null,
): TemplateRepository {
  return {
    findById: () => Promise.resolve(found),
    findVersionById: () => Promise.resolve(version),
  } as unknown as TemplateRepository;
}

describe('publishedDefaultTemplate (RN-DOC-22)', () => {
  const published = buildTemplateVersion({ id: 'ver-1', status: 'PUBLISHED' });

  it('devolve a versão PUBLISHED corrente do template padrão ativo do tipo', async () => {
    await expect(
      publishedDefaultTemplate(tx, repository(template(), published), type),
    ).resolves.toBe(published);
  });

  it.each([
    ['tipo sem template padrão', { ...type, defaultTemplateId: null }, template(), published],
    ['template inexistente', type, null, published],
    ['template de outro tipo', type, template({ documentTypeId: 'outro' }), published],
    ['template inativo', type, template({ isActive: false }), published],
    ['template sem versão publicada', type, template({ currentPublishedVersionId: null }), null],
    [
      'versão corrente aposentada',
      type,
      template(),
      buildTemplateVersion({ id: 'ver-1', status: 'RETIRED' }),
    ],
    ['versão inexistente', type, template(), null],
  ] as const)('%s → null', async (_label, target, found, version) => {
    await expect(
      publishedDefaultTemplate(tx, repository(found, version), target),
    ).resolves.toBeNull();
  });
});

describe('rascunho inicial do documento livre (RN-DOC-23)', () => {
  it('resolve as variáveis do processo no defaultContent e deixa as da emissão para o PDF', () => {
    const variables = processTemplateVariables({
      code: '0012/2026',
      title: 'Reforma da escola',
      object: 'Reforma predial',
      organizationName: null,
    });
    expect(variables).toEqual({
      'process.code': '0012/2026',
      'process.title': 'Reforma da escola',
      'process.object': 'Reforma predial',
      'organization.name': '',
    });
    const draft = initialDraftContent(
      [
        sectionDefinition('CONTENT', {
          order: 1,
          defaultContent: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Processo {{process.code}}, {{today}}.' }],
              },
            ],
          },
        }),
        sectionDefinition('NOTES', { order: 2, requirement: 'OPTIONAL' }),
      ],
      { actorId: 'ana', now: FIXTURE_NOW, variables },
    );
    expect(draft.sections.CONTENT).toMatchObject({ state: 'FILLED', revision: 1 });
    expect(JSON.stringify(draft.sections.CONTENT?.content)).toContain(
      'Processo 0012/2026, {{today}}.',
    );
    expect(draft.sections.NOTES).toMatchObject({ state: 'EMPTY', revision: 1, content: null });
  });
});
