/**
 * Contraste de cores (WCAG 2.1 — 1.4.3) e tema por tenant restrito a `branding.primaryColor`
 * (architecture.md §8.9 · entities.md §6 · RN-FND-91). Uma cor que não atinge 4,5:1 com texto
 * branco nem com texto escuro é descartada e o tema padrão permanece.
 */

/** Contraste mínimo de texto normal (AA). */
export const MIN_TEXT_CONTRAST = 4.5;

const HEX_COLOR = /^#([0-9a-f]{6})$/i;

/** Texto claro e escuro candidatos sobre a cor primária. */
export const LIGHT_TEXT = '#ffffff';
export const DARK_TEXT = '#0f172a';

/** Converte `#rrggbb` em componentes 0–255; `null` se o formato for inválido. */
export function parseHexColor(value: string): readonly [number, number, number] | null {
  const match = HEX_COLOR.exec(value.trim());
  if (!match?.[1]) return null;
  const hex = match[1];
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function channel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.040_45 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** Luminância relativa (WCAG). */
export function relativeLuminance([red, green, blue]: readonly [number, number, number]): number {
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

/** Razão de contraste entre duas cores `#rrggbb` (1–21); `null` se alguma for inválida. */
export function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseHexColor(foreground);
  const bg = parseHexColor(background);
  if (!fg || !bg) return null;
  const [lighter, darker] = [relativeLuminance(fg), relativeLuminance(bg)].sort(
    (a, b) => b - a,
  ) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

export interface BrandingTheme {
  readonly '--color-primary': string;
  readonly '--color-primary-foreground': string;
  readonly '--color-primary-hover': string;
}

/**
 * Variáveis CSS do tema do tenant a partir de `branding.primaryColor`. Escolhe o texto (claro ou
 * escuro) com maior contraste; devolve `null` quando a cor é inválida ou nenhum texto atinge 4,5:1.
 * O hover fica na própria cor do tenant: o azul profundo da marca não combina com outra primária.
 */
export function brandingTheme(primaryColor: string | null | undefined): BrandingTheme | null {
  if (!primaryColor) return null;
  const color = primaryColor.trim().toLowerCase();
  const light = contrastRatio(LIGHT_TEXT, color);
  const dark = contrastRatio(DARK_TEXT, color);
  if (light === null || dark === null) return null;
  const [text, ratio] = light >= dark ? [LIGHT_TEXT, light] : [DARK_TEXT, dark];
  if (ratio < MIN_TEXT_CONTRAST) return null;
  return {
    '--color-primary': color,
    '--color-primary-foreground': text,
    '--color-primary-hover': color,
  };
}
