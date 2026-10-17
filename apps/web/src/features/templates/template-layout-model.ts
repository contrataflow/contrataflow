import {
  LAYOUT_LIMITS,
  LAYOUT_MESSAGES,
  LAYOUT_TEMPLATE_VARIABLES,
  richTextFromPlainText,
  richTextPlainText,
  templateVariablesIn,
  unknownVariableMessage,
} from '@contrataflow/validation';
import type {
  LayoutDefinition,
  LayoutUpdateInput,
  TemplateLogoPosition,
} from '@contrataflow/validation';

/*
 * Modelo da aba "Layout" de SCR-114 (US-109 · RN-TPL-21..24): o formulário do `LayoutDefinition`
 * (margens, fonte, orientação, cabeçalho/rodapé em texto com variáveis, logo e interruptores), a
 * validação local (V-01..V-04, V-06 — a API repete tudo) e o corpo do PATCH só com o que mudou.
 * Cabeçalho e rodapé seguem o editor das seções: texto por linha, convertido em `TipTapDoc`.
 */

export const LAYOUT_SIDES = ['top', 'right', 'bottom', 'left'] as const;
export type LayoutSide = (typeof LAYOUT_SIDES)[number];

export interface LayoutForm {
  readonly orientation: LayoutDefinition['orientation'];
  /** Texto dos campos numéricos (o usuário pode apagar enquanto digita). */
  readonly margins: Readonly<Record<LayoutSide, string>>;
  readonly fontFamily: LayoutDefinition['fontFamily'];
  readonly fontSizePt: string;
  readonly lineHeight: string;
  readonly header: string;
  readonly footer: string;
  readonly logoAttachmentId: string | null;
  readonly logoPosition: TemplateLogoPosition;
  readonly logoMaxHeightMm: string;
  readonly showPageNumbers: boolean;
  readonly showDocumentHashInFooter: boolean;
  readonly draftWatermark: boolean;
}

export type LayoutField =
  `margins.${LayoutSide}` | 'fontSizePt' | 'lineHeight' | 'header' | 'footer' | 'logoMaxHeightMm';

export interface LayoutProblem {
  readonly field: LayoutField;
  readonly message: string;
}

/** Número com vírgula ou ponto (pt-BR). */
function numberOf(text: string): number | null {
  const normalized = text.trim().replace(',', '.');
  if (normalized === '') return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

const decimal = (value: number) => String(value).replace('.', ',');

export function toLayoutForm(layout: LayoutDefinition): LayoutForm {
  return {
    orientation: layout.orientation,
    margins: {
      top: String(layout.marginsMm.top),
      right: String(layout.marginsMm.right),
      bottom: String(layout.marginsMm.bottom),
      left: String(layout.marginsMm.left),
    },
    fontFamily: layout.fontFamily,
    fontSizePt: String(layout.fontSizePt),
    lineHeight: decimal(layout.lineHeight),
    header: richTextPlainText(layout.header),
    footer: richTextPlainText(layout.footer),
    logoAttachmentId: layout.logo?.attachmentId ?? null,
    logoPosition: layout.logo?.position ?? 'left',
    logoMaxHeightMm: String(layout.logo?.maxHeightMm ?? LAYOUT_LIMITS.logoMaxHeightMm),
    showPageNumbers: layout.showPageNumbers,
    showDocumentHashInFooter: layout.showDocumentHashInFooter,
    draftWatermark: layout.draftWatermark,
  };
}

function inRange(text: string, min: number, max: number): boolean {
  const value = numberOf(text);
  return value !== null && value >= min && value <= max;
}

/** Validação local (a API confere de novo): faixas, variáveis e a altura do logo. */
export function layoutProblems(form: LayoutForm): LayoutProblem[] {
  const problems: LayoutProblem[] = [];
  for (const side of LAYOUT_SIDES) {
    if (!inRange(form.margins[side], LAYOUT_LIMITS.marginMm.min, LAYOUT_LIMITS.marginMm.max)) {
      problems.push({ field: `margins.${side}`, message: LAYOUT_MESSAGES.margin });
    }
  }
  if (!inRange(form.fontSizePt, LAYOUT_LIMITS.fontSizePt.min, LAYOUT_LIMITS.fontSizePt.max)) {
    problems.push({ field: 'fontSizePt', message: LAYOUT_MESSAGES.fontSize });
  }
  if (!inRange(form.lineHeight, LAYOUT_LIMITS.lineHeight.min, LAYOUT_LIMITS.lineHeight.max)) {
    problems.push({ field: 'lineHeight', message: LAYOUT_MESSAGES.lineHeight });
  }
  const known = new Set<string>(LAYOUT_TEMPLATE_VARIABLES);
  for (const field of ['header', 'footer'] as const) {
    const unknown = templateVariablesIn(form[field]).find((variable) => !known.has(variable));
    if (unknown !== undefined) problems.push({ field, message: unknownVariableMessage(unknown) });
  }
  if (form.logoAttachmentId !== null) {
    const height = numberOf(form.logoMaxHeightMm);
    const top = numberOf(form.margins.top) ?? 0;
    if (height === null || height <= 0 || height > top) {
      problems.push({ field: 'logoMaxHeightMm', message: LAYOUT_MESSAGES.logoHeight });
    }
  }
  return problems;
}

function docOf(text: string) {
  return text.trim() === '' ? null : richTextFromPlainText(text);
}

/** Corpo do `layout` do PATCH com o que difere do layout salvo (vazio = nada a enviar). */
export function layoutPatch(saved: LayoutDefinition, form: LayoutForm): LayoutUpdateInput {
  const current = toLayoutForm(saved);
  const patch: Record<string, unknown> = {};
  if (form.orientation !== current.orientation) patch.orientation = form.orientation;
  const margins: Partial<Record<LayoutSide, number>> = {};
  for (const side of LAYOUT_SIDES) {
    const value = numberOf(form.margins[side]);
    if (value !== null && value !== saved.marginsMm[side]) margins[side] = value;
  }
  if (Object.keys(margins).length > 0) patch.marginsMm = margins;
  if (form.fontFamily !== current.fontFamily) patch.fontFamily = form.fontFamily;
  const fontSize = numberOf(form.fontSizePt);
  if (fontSize !== null && fontSize !== saved.fontSizePt) patch.fontSizePt = fontSize;
  const lineHeight = numberOf(form.lineHeight);
  if (lineHeight !== null && lineHeight !== saved.lineHeight) patch.lineHeight = lineHeight;
  if (form.header !== current.header) patch.header = docOf(form.header);
  if (form.footer !== current.footer) patch.footer = docOf(form.footer);
  if (form.logoAttachmentId === null) {
    if (saved.logo) patch.logo = null;
  } else {
    const height = numberOf(form.logoMaxHeightMm) ?? LAYOUT_LIMITS.logoMaxHeightMm;
    if (
      saved.logo?.attachmentId !== form.logoAttachmentId ||
      saved.logo.position !== form.logoPosition ||
      saved.logo.maxHeightMm !== height
    ) {
      patch.logo = {
        attachmentId: form.logoAttachmentId,
        position: form.logoPosition,
        maxHeightMm: height,
      };
    }
  }
  for (const flag of ['showPageNumbers', 'showDocumentHashInFooter', 'draftWatermark'] as const) {
    if (form[flag] !== saved[flag]) patch[flag] = form[flag];
  }
  return patch;
}

/** Erros de campo do 422 `VALIDATION_ERROR` (`layout.marginsMm.top`) no formulário. */
export function layoutFieldErrors(
  errors: readonly { readonly field: string; readonly message: string }[],
): LayoutProblem[] {
  const map: Readonly<Record<string, LayoutField>> = {
    'layout.marginsMm.top': 'margins.top',
    'layout.marginsMm.right': 'margins.right',
    'layout.marginsMm.bottom': 'margins.bottom',
    'layout.marginsMm.left': 'margins.left',
    'layout.fontSizePt': 'fontSizePt',
    'layout.lineHeight': 'lineHeight',
    'layout.logo.maxHeightMm': 'logoMaxHeightMm',
    'layout.header': 'header',
    'layout.footer': 'footer',
  };
  return errors.flatMap((error) => {
    const field = map[error.field];
    return field ? [{ field, message: error.message }] : [];
  });
}
