import { DEFAULT_TEMPLATE_LAYOUT, layoutUpdateSchema } from '@contrataflow/validation';
import type { LayoutDefinition } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  applyLayoutPatch,
  assertLayout,
  LayoutInvalidError,
  layoutChangedFields,
  layoutErrors,
} from './layout-definition.js';
import { validateTemplateContent } from './template-content.validator.js';

/* US-109 · RN-TPL-21..24: o layout de impressão como valor (PATCH parcial, regras e auditoria). */

const LOGO = '0192d109-0000-7000-8000-0000000000a1';
const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const patchOf = (input: unknown) => layoutUpdateSchema.parse(input);

describe('LayoutDefinition (US-109)', () => {
  it('aplica só as partes enviadas: margens campo a campo e os padrões do logo', () => {
    const next = applyLayoutPatch(
      DEFAULT_TEMPLATE_LAYOUT,
      patchOf({ marginsMm: { top: 30 }, fontFamily: 'Arial', logo: { attachmentId: LOGO } }),
    );
    expect(next).toEqual({
      ...DEFAULT_TEMPLATE_LAYOUT,
      marginsMm: { top: 30, right: 20, bottom: 20, left: 20 },
      fontFamily: 'Arial',
      logo: { attachmentId: LOGO, position: 'left', maxHeightMm: 15 },
    });
  });

  it('FA-02: `null` remove cabeçalho, rodapé e logo; omitido mantém', () => {
    const withAll: LayoutDefinition = {
      ...DEFAULT_TEMPLATE_LAYOUT,
      header: doc('Cabeçalho'),
      footer: doc('Rodapé'),
      logo: { attachmentId: LOGO, position: 'center', maxHeightMm: 10 },
    };
    expect(applyLayoutPatch(withAll, patchOf({ fontSizePt: 12 }))).toMatchObject({
      header: doc('Cabeçalho'),
      footer: doc('Rodapé'),
      logo: { attachmentId: LOGO },
    });
    const cleared = applyLayoutPatch(withAll, patchOf({ header: null, footer: null, logo: null }));
    expect(cleared).not.toHaveProperty('header');
    expect(cleared).not.toHaveProperty('footer');
    expect(cleared).not.toHaveProperty('logo');
    expect(cleared.pageSize).toBe('A4');
  });

  it('RN-TPL-23: a altura do logo cabe na margem superior', () => {
    const tall = applyLayoutPatch(
      DEFAULT_TEMPLATE_LAYOUT,
      patchOf({ logo: { attachmentId: LOGO, maxHeightMm: 21 } }),
    );
    expect(layoutErrors(tall)).toEqual([
      expect.objectContaining({ field: 'layout.logo.maxHeightMm', code: 'OUT_OF_RANGE' }),
    ]);
    expect(() => {
      assertLayout(tall);
    }).toThrow(LayoutInvalidError);
    expect(layoutErrors({ ...tall, marginsMm: { ...tall.marginsMm, top: 21 } })).toEqual([]);
    expect(() => {
      assertLayout(DEFAULT_TEMPLATE_LAYOUT);
    }).not.toThrow();
  });

  it('lista os campos alterados em caminho com ponto (auditoria `layoutChangedFields`)', () => {
    const next = applyLayoutPatch(
      DEFAULT_TEMPLATE_LAYOUT,
      patchOf({
        orientation: 'landscape',
        marginsMm: { left: 25 },
        footer: doc('{{page}}'),
        logo: { attachmentId: LOGO },
        draftWatermark: false,
      }),
    );
    expect(layoutChangedFields(DEFAULT_TEMPLATE_LAYOUT, next)).toEqual([
      'orientation',
      'draftWatermark',
      'marginsMm.left',
      'footer',
      'logo.attachmentId',
      'logo.position',
      'logo.maxHeightMm',
    ]);
    expect(layoutChangedFields(next, next)).toEqual([]);
  });

  it('RN-TPL-22: cabeçalho/rodapé aceitam o catálogo completo e recusam o resto', () => {
    const layout: LayoutDefinition = {
      ...DEFAULT_TEMPLATE_LAYOUT,
      header: doc('{{organization.name}} · {{document.version}}'),
      footer: doc('{{page}}/{{pages}} {{document.hash}} {{document.assinante}}'),
    };
    const violations = validateTemplateContent(
      { sections: [], fieldConfig: {}, importMappings: null, layout },
      { documentType: { kind: 'FREE_TEXT', systemModule: null }, importSources: null },
      { sections: false, fieldConfig: false, importMappings: false, layout: true },
    );
    expect(violations).toEqual([
      expect.objectContaining({
        code: 'TEMPLATE_VARIABLE_UNKNOWN',
        field: 'layout.footer',
        params: { variable: 'document.assinante' },
      }),
    ]);
    // Fora do escopo (o rascunho não enviou `layout`): não confere.
    expect(
      validateTemplateContent(
        { sections: [], fieldConfig: {}, importMappings: null, layout },
        { documentType: { kind: 'FREE_TEXT', systemModule: null }, importSources: null },
        { sections: false, fieldConfig: false, importMappings: false },
      ),
    ).toEqual([]);
  });
});
