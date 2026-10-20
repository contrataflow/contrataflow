import { DEFAULT_TEMPLATE_LAYOUT } from '@contrataflow/validation';
import type { DocumentSnapshot, SectionDefinition } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { maskConfidentialSnapshot } from './confidential-snapshot.js';
import {
  AI_REVIEW_PENDING_NOTE,
  buildRenditionHtml,
  DRAFT_WATERMARK,
  InvalidLayoutError,
  MASKED_VALUE_LABEL,
  renditionLayout,
  renditionVariables,
} from './rendition-html.js';
import type { RenditionHtmlInput } from './rendition-html.js';

const HASH = 'f'.repeat(64);
const NOW = new Date('2026-10-17T13:00:00.000Z');

const paragraph = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function snapshot(overrides: Partial<DocumentSnapshot> = {}): DocumentSnapshot {
  return {
    schemaVersion: 1,
    document: {
      id: '0192f067-0000-7000-8000-000000000001',
      code: 'ETP 0003/2026',
      title: 'Estudo técnico <preliminar>',
      typeCode: 'ETP',
      kind: 'STRUCTURED',
      confidentiality: 'PUBLIC',
      versionNumber: 2,
    },
    template: null,
    process: {
      id: '0192f067-0000-7000-8000-000000000002',
      code: '0012/2026',
      title: 'Pavimentação',
      object: 'Pavimentar ruas',
      organizationName: 'Prefeitura A',
      organizationCnpj: '11222333000181',
      requestingSecretariatName: 'Obras',
      requestingDepartmentName: 'Manutenção',
      isBudgetConfidential: false,
    },
    header: { objective: 'Pavimentar', estimatedTotalValue: '1000.00' },
    sections: {
      PROBLEM: {
        state: 'FILLED',
        content: paragraph('Processo {{process.code}}'),
        justification: null,
      },
      NEED_DESCRIPTION: { state: 'NOT_APPLICABLE', content: null, justification: 'Sem demanda' },
      EXTRA: { state: 'EMPTY', content: null, justification: null },
    },
    collections: {
      items: [{ id: 'i1', processItemId: 'p1', description: 'Cimento', unitPrice: '10.00' }],
    },
    generatedAt: NOW.toISOString(),
    ...overrides,
  } as DocumentSnapshot;
}

const sections: SectionDefinition[] = [
  { key: 'NEED_DESCRIPTION', title: 'Descrição da necessidade', order: 1 } as SectionDefinition,
  { key: 'PROBLEM', title: 'Problema', order: 2 } as SectionDefinition,
];

function input(overrides: Partial<RenditionHtmlInput> = {}): RenditionHtmlInput {
  return {
    kind: 'CONTENT',
    snapshot: snapshot(),
    template: { sections, layout: DEFAULT_TEMPLATE_LAYOUT },
    contentHash: HASH,
    tenantName: 'Prefeitura A',
    requesterName: 'Lúcia',
    now: NOW,
    timeZone: 'America/Sao_Paulo',
    ...overrides,
  };
}

describe('buildRenditionHtml (RN-DOC-65 · ADR-007)', () => {
  it('versão: título escapado, seções na ordem do template, variáveis resolvidas, hash no rodapé', () => {
    const html = buildRenditionHtml(input());
    expect(html.indexHtml).toContain('<h1>ETP 0003/2026 — Estudo técnico &lt;preliminar&gt;</h1>');
    expect(html.indexHtml.indexOf('Descrição da necessidade')).toBeLessThan(
      html.indexHtml.indexOf('2. Problema'),
    );
    expect(html.indexHtml).toContain('<p>Processo 0012/2026</p>');
    expect(html.indexHtml).toContain('Não se aplica.');
    expect(html.indexHtml).toContain('Sem demanda');
    // Seção do snapshot fora do template continua no PDF (depois das definidas).
    expect(html.indexHtml).toContain('3. Extra');
    expect(html.indexHtml).toContain('Seção não preenchida.');
    expect(html.indexHtml).toContain('Cimento');
    expect(html.indexHtml).not.toContain(DRAFT_WATERMARK);
    expect(html.footerHtml).toContain(`Hash SHA-256 da versão: ${HASH}`);
    expect(html.footerHtml).toContain('<span class="pageNumber"></span>');
    expect(html.headerHtml).toBeNull();
    expect(html.layout).toEqual(DEFAULT_TEMPLATE_LAYOUT);
  });

  it('prévia: marca d’água "RASCUNHO" em cada página e rodapé sem hash', () => {
    const html = buildRenditionHtml(input({ kind: 'PREVIEW', contentHash: null }));
    expect(html.indexHtml).toContain(
      `<div class="cf-watermark" aria-hidden="true">${DRAFT_WATERMARK}</div>`,
    );
    expect(html.indexHtml).toContain('position:fixed');
    expect(html.footerHtml).toContain(DRAFT_WATERMARK);
    expect(html.footerHtml).not.toContain('Hash SHA-256');
  });

  it('showDocumentHashInFooter = false omite o hash; sem paginação quando desligada', () => {
    const html = buildRenditionHtml(
      input({
        template: {
          sections,
          layout: {
            ...DEFAULT_TEMPLATE_LAYOUT,
            showDocumentHashInFooter: false,
            showPageNumbers: false,
          },
        },
      }),
    );
    expect(html.footerHtml).not.toContain(HASH);
    expect(html.footerHtml).not.toContain('pageNumber');
  });

  it('cabeçalho/rodapé do layout com {{page}}/{{pages}} e {{document.hash}}', () => {
    const html = buildRenditionHtml(
      input({
        template: {
          sections,
          layout: {
            ...DEFAULT_TEMPLATE_LAYOUT,
            header: paragraph('{{organization.name}} — {{process.code}}') as never,
            footer: paragraph('Pág. {{page}}/{{pages}} · {{document.hash}}') as never,
          },
        },
      }),
    );
    expect(html.headerHtml).toContain('Prefeitura A — 0012/2026');
    expect(html.footerHtml).toContain(
      `Pág. <span class="pageNumber"></span>/<span class="totalPages"></span> · ${HASH}`,
    );
  });

  it('FA-05: snapshot mascarado mostra "Valor sigiloso" — o valor real nunca vai ao HTML', () => {
    const confidential = snapshot({
      process: { ...snapshot().process, isBudgetConfidential: true },
    });
    const html = buildRenditionHtml(input({ snapshot: maskConfidentialSnapshot(confidential) }));
    expect(html.indexHtml).toContain(MASKED_VALUE_LABEL);
    expect(html.indexHtml).not.toContain('1000.00');
    expect(html.indexHtml).not.toContain('10.00');
  });

  it('sem template: layout padrão e seções pela chave', () => {
    const html = buildRenditionHtml(input({ template: null }));
    expect(html.layout).toEqual(DEFAULT_TEMPLATE_LAYOUT);
    expect(html.indexHtml).toContain('1. Extra');
  });
});

describe('renditionLayout (V-04)', () => {
  it('layout inválido ou fora dos limites é falha permanente', () => {
    expect(() => renditionLayout({ pageSize: 'A3' })).toThrow(InvalidLayoutError);
    expect(() =>
      renditionLayout({
        ...DEFAULT_TEMPLATE_LAYOUT,
        marginsMm: { top: -1, right: 0, bottom: 0, left: 0 },
      }),
    ).toThrow(InvalidLayoutError);
    expect(() => renditionLayout({ ...DEFAULT_TEMPLATE_LAYOUT, fontSizePt: 200 })).toThrow(
      InvalidLayoutError,
    );
    expect(renditionLayout(undefined)).toEqual(DEFAULT_TEMPLATE_LAYOUT);
  });
});

describe('renditionVariables (entities.md §5.2)', () => {
  it('resolve o catálogo no servidor; a prévia não tem hash e mostra RASCUNHO na versão', () => {
    const values = renditionVariables(input({ kind: 'PREVIEW', contentHash: null }));
    expect(values).toMatchObject({
      'tenant.name': 'Prefeitura A',
      'organization.cnpj': '11222333000181',
      'process.requestingSecretariat': 'Obras',
      'document.code': 'ETP 0003/2026',
      'document.version': DRAFT_WATERMARK,
      'document.hash': '',
      'document.date': '17/10/2026',
      today: '17/10/2026',
      'user.name': 'Lúcia',
    });
    expect(renditionVariables(input())['document.version']).toBe('2');
  });
});

describe('marcas de IA na prévia (US-122 · RN-AI-58)', () => {
  const ai = {
    generationId: '0192f067-0000-7000-8000-0000000000e1',
    appliedAt: NOW.toISOString(),
    appliedById: '0192f067-0000-7000-8000-0000000000a1',
    reviewedAt: null,
    reviewedById: null,
  };
  const withMarker = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Entrega em ' },
          { type: 'toConfirm', attrs: { label: 'prazo', category: 'DEADLINE', origin: 'AI' } },
        ],
      },
    ],
  };
  const aiSnapshot = (reviewedAt: string | null) =>
    snapshot({
      sections: {
        PROBLEM: {
          state: 'FILLED',
          content: withMarker,
          justification: null,
          ai: { ...ai, reviewedAt },
        },
      },
    } as Partial<DocumentSnapshot>);

  it('prévia: nota no topo da seção pendente e "[a confirmar: prazo]" destacado', () => {
    const html = buildRenditionHtml(
      input({ kind: 'PREVIEW', contentHash: null, snapshot: aiSnapshot(null) }),
    ).indexHtml;
    expect(html).toContain(`<p class="cf-ai-note">${AI_REVIEW_PENDING_NOTE}</p><p>Entrega em `);
    expect(html).toContain(
      '<mark class="cf-to-confirm" data-category="DEADLINE">[a confirmar: prazo]</mark>',
    );
    expect(html).toContain('.cf-to-confirm{');
  });

  it('seção revisada e versões não levam a nota (a proveniência não é impressa)', () => {
    const reviewed = buildRenditionHtml(
      input({ kind: 'PREVIEW', contentHash: null, snapshot: aiSnapshot(NOW.toISOString()) }),
    ).indexHtml;
    expect(reviewed).not.toContain(AI_REVIEW_PENDING_NOTE);
    const version = buildRenditionHtml(input({ snapshot: aiSnapshot(null) })).indexHtml;
    expect(version).not.toContain(AI_REVIEW_PENDING_NOTE);
    expect(version).not.toContain(ai.generationId);
  });
});
