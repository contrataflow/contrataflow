import { describe, expect, it } from 'vitest';

import {
  LAYOUT_TEMPLATE_VARIABLES,
  layoutUpdateSchema,
  SECTION_TEMPLATE_VARIABLES,
  templatePreviewSchema,
  templateVersionUpdateSchema,
} from './template.js';

/* US-109 · RN-TPL-21..24: o `layout` do TPL-08 e a prévia efêmera (TPL-12). */

const LOGO = '0192d109-0000-7000-8000-0000000000c1';

function issuesOf(input: unknown) {
  const parsed = layoutUpdateSchema.safeParse(input);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

describe('layoutUpdateSchema (US-109)', () => {
  it('aceita o PATCH parcial e aplica os padrões do logo', () => {
    expect(layoutUpdateSchema.parse({ fontSizePt: 12, logo: { attachmentId: LOGO } })).toEqual({
      fontSizePt: 12,
      logo: { attachmentId: LOGO, position: 'left', maxHeightMm: 15 },
    });
    expect(layoutUpdateSchema.parse({ header: null, logo: null })).toEqual({
      header: null,
      logo: null,
    });
    expect(templateVersionUpdateSchema.parse({ layout: { lineHeight: 1.5 } })).toEqual({
      layout: { lineHeight: 1.5 },
    });
  });

  it.each([
    [{ marginsMm: { top: 9 } }, 'marginsMm.top', 'A margem deve estar entre 10 e 40 mm.'],
    [{ marginsMm: { bottom: 41 } }, 'marginsMm.bottom', 'A margem deve estar entre 10 e 40 mm.'],
    [{ fontSizePt: 8 }, 'fontSizePt', 'O tamanho da fonte deve estar entre 9 e 14.'],
    [{ fontSizePt: 20 }, 'fontSizePt', 'O tamanho da fonte deve estar entre 9 e 14.'],
    [{ lineHeight: 0.9 }, 'lineHeight', 'A entrelinha deve estar entre 1,0 e 2,0.'],
    [{ fontFamily: 'Comic Sans' }, 'fontFamily', 'Selecione uma fonte válida.'],
    [{ orientation: 'square' }, 'orientation', 'Selecione uma orientação válida.'],
    [
      { logo: { attachmentId: LOGO, position: 'top' } },
      'logo.position',
      'Selecione uma posição válida para o logo.',
    ],
    [
      { logo: { attachmentId: LOGO, maxHeightMm: 0 } },
      'logo.maxHeightMm',
      'A altura do logo deve ser maior que zero e caber na margem superior.',
    ],
  ])('%j → erro em %s', (input, path, message) => {
    expect(issuesOf(input)).toContainEqual({ path, message });
  });

  it('pageSize é fixo em A4 e campos desconhecidos são recusados', () => {
    expect(issuesOf({ pageSize: 'A3' })).toHaveLength(1);
    expect(issuesOf({ pageSize: 'A4' })).toEqual([]);
    expect(issuesOf({ watermarkText: 'x' })).toHaveLength(1);
  });

  it('RN-TPL-22: o catálogo do cabeçalho/rodapé inclui as variáveis de renderização', () => {
    for (const variable of ['page', 'pages', 'document.hash', 'document.version']) {
      expect(LAYOUT_TEMPLATE_VARIABLES).toContain(variable);
      expect(SECTION_TEMPLATE_VARIABLES).not.toContain(variable);
    }
  });

  it('templatePreviewSchema descreve o estado efêmero sem chave de storage', () => {
    const parsed = templatePreviewSchema.parse({
      renditionId: LOGO,
      templateVersionId: LOGO,
      status: 'FAILED',
      pageCount: null,
      sizeBytes: null,
      sha256: null,
      errorCode: 'DEPENDENCY_UNAVAILABLE',
      errorMessage: 'Não foi possível gerar a prévia agora. Tente novamente.',
      requestedAt: '2026-10-17T12:00:00.000Z',
      readyAt: null,
      expiresAt: '2026-10-18T12:00:00.000Z',
      storageKey: 'tenants/x',
    });
    expect(parsed).not.toHaveProperty('storageKey');
  });
});
