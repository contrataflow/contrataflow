import { LAYOUT_MESSAGES } from '@contrataflow/validation';
import type { FieldError, LayoutDefinition, LayoutUpdate } from '@contrataflow/validation';

/*
 * `LayoutDefinition` (US-109 · entities.md §5.2 · RN-TPL-21..24): o layout de impressão do rascunho
 * como valor. O PATCH muda só as partes enviadas — `marginsMm` campo a campo; `header`, `footer` e
 * `logo` com `null` são removidos (FA-02) — e o resultado é conferido por inteiro (a altura do logo
 * cabe na margem superior — RN-TPL-23). As faixas de cada campo já vêm do schema; as variáveis de
 * cabeçalho/rodapé, do `TemplateContentValidator` (RN-TPL-22). Funções puras.
 */

/** Regra do layout resultante violada (V-01..V-06): vira `VALIDATION_ERROR` no caso de uso. */
export class LayoutInvalidError extends Error {
  constructor(readonly errors: readonly FieldError[]) {
    super('Layout de impressão inválido.');
    this.name = 'LayoutInvalidError';
  }
}

/** Layout resultante do PATCH (sem conferir — `assertLayout`). */
export function applyLayoutPatch(current: LayoutDefinition, patch: LayoutUpdate): LayoutDefinition {
  const { marginsMm } = patch;
  const next: LayoutDefinition = {
    pageSize: 'A4',
    orientation: patch.orientation ?? current.orientation,
    marginsMm: {
      top: marginsMm?.top ?? current.marginsMm.top,
      right: marginsMm?.right ?? current.marginsMm.right,
      bottom: marginsMm?.bottom ?? current.marginsMm.bottom,
      left: marginsMm?.left ?? current.marginsMm.left,
    },
    fontFamily: patch.fontFamily ?? current.fontFamily,
    fontSizePt: patch.fontSizePt ?? current.fontSizePt,
    lineHeight: patch.lineHeight ?? current.lineHeight,
    showPageNumbers: patch.showPageNumbers ?? current.showPageNumbers,
    showDocumentHashInFooter: patch.showDocumentHashInFooter ?? current.showDocumentHashInFooter,
    draftWatermark: patch.draftWatermark ?? current.draftWatermark,
  };
  const header = patch.header === undefined ? current.header : patch.header;
  const footer = patch.footer === undefined ? current.footer : patch.footer;
  const logo = patch.logo === undefined ? current.logo : patch.logo;
  return {
    ...next,
    ...(header ? { header } : {}),
    ...(footer ? { footer } : {}),
    ...(logo ? { logo } : {}),
  };
}

/** RN-TPL-23: `0 < logo.maxHeightMm ≤ marginsMm.top`. */
export function layoutErrors(layout: LayoutDefinition): FieldError[] {
  if (layout.logo === undefined || layout.logo.maxHeightMm <= layout.marginsMm.top) return [];
  return [
    {
      field: 'layout.logo.maxHeightMm',
      code: 'OUT_OF_RANGE',
      message: LAYOUT_MESSAGES.logoHeight,
    },
  ];
}

export function assertLayout(layout: LayoutDefinition): void {
  const errors = layoutErrors(layout);
  if (errors.length > 0) throw new LayoutInvalidError(errors);
}

const SCALAR_FIELDS = [
  'pageSize',
  'orientation',
  'fontFamily',
  'fontSizePt',
  'lineHeight',
  'showPageNumbers',
  'showDocumentHashInFooter',
  'draftWatermark',
] as const;
const MARGINS = ['top', 'right', 'bottom', 'left'] as const;
const LOGO_FIELDS = ['attachmentId', 'position', 'maxHeightMm'] as const;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Campos alterados (auditoria `template.update` — `layoutChangedFields[]`), em caminho com ponto:
 * `fontFamily`, `marginsMm.top`, `logo.attachmentId`… Nunca o conteúdo de cabeçalho/rodapé.
 */
export function layoutChangedFields(before: LayoutDefinition, after: LayoutDefinition): string[] {
  const changed: string[] = [];
  for (const field of SCALAR_FIELDS) {
    if (before[field] !== after[field]) changed.push(field);
  }
  for (const side of MARGINS) {
    if (before.marginsMm[side] !== after.marginsMm[side]) changed.push(`marginsMm.${side}`);
  }
  for (const field of ['header', 'footer'] as const) {
    if (!same(before[field], after[field])) changed.push(field);
  }
  for (const field of LOGO_FIELDS) {
    if (before.logo?.[field] !== after.logo?.[field]) changed.push(`logo.${field}`);
  }
  return changed;
}
