import type { ComponentType, ReactNode } from 'react';

/*
 * Tons semânticos do design system v2 (prd-4 · DEC-186). Cada tom tem um par texto/fundo suave
 * (chips, ícones de KPI, avatares) e uma cor de marca gráfica (barras, fatias), todos validados por
 * `tokens-contrast.test.ts`. As classes são literais para o Tailwind detectá-las.
 */

export type StatusTone = 'info' | 'success' | 'warning' | 'danger' | 'approval' | 'neutral';

/** Tons de marca gráfica: os semânticos mais o navy da marca (`brand-ink`, claro no tema escuro). */
export type ChartTone = StatusTone | 'navy';

export const STATUS_TONES: readonly StatusTone[] = [
  'info',
  'success',
  'warning',
  'danger',
  'approval',
  'neutral',
];

/** Fundo suave + texto legível sobre ele. */
export const SOFT_TONE: Record<StatusTone, string> = {
  info: 'bg-primary-soft text-primary-soft-foreground',
  success: 'bg-success-soft text-success-soft-foreground',
  warning: 'bg-warning-soft text-warning-soft-foreground',
  danger: 'bg-destructive-soft text-destructive-soft-foreground',
  approval: 'bg-approval-soft text-approval-soft-foreground',
  neutral: 'bg-neutral-soft text-neutral-soft-foreground',
};

/** Texto no tom sobre a superfície (número de KPI em destaque, prazo colorido). */
export const TEXT_TONE: Record<StatusTone, string> = {
  info: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
  approval: 'text-approval',
  neutral: 'text-muted-foreground',
};

/** Preenchimento de barras (`div`). */
export const BAR_TONE: Record<ChartTone, string> = {
  info: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  approval: 'bg-approval',
  neutral: 'bg-neutral',
  navy: 'bg-brand-ink',
};

/** Traço de fatias em SVG. */
export const STROKE_TONE: Record<ChartTone, string> = {
  info: 'stroke-primary',
  success: 'stroke-success',
  warning: 'stroke-warning',
  danger: 'stroke-destructive',
  approval: 'stroke-approval',
  neutral: 'stroke-neutral',
  navy: 'stroke-brand-ink',
};

/**
 * Componente de link do app (ex.: `next/link`); `a` por padrão. Os componentes do design system
 * não dependem do roteador.
 */
export type LinkComponent = ComponentType<{
  readonly href: string;
  readonly className?: string | undefined;
  readonly children?: ReactNode;
  readonly 'aria-current'?: 'page' | undefined;
}>;

/** Link HTML simples, usado quando o app não passa o seu. */
export function PlainLink({
  href,
  className,
  children,
  'aria-current': ariaCurrent,
}: {
  readonly href: string;
  readonly className?: string | undefined;
  readonly children?: ReactNode;
  readonly 'aria-current'?: 'page' | undefined;
}) {
  return (
    <a href={href} className={className} aria-current={ariaCurrent}>
      {children}
    </a>
  );
}
