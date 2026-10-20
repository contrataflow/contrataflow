import { cx } from './cx.js';

/*
 * Estilos do botão sem diretiva `'use client'`: Server Components também os usam para dar
 * aparência de botão a links (`<Link className={buttonClassName()}>`).
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'icon';

// O hover eleva o botão sem mexer nas cores: opacidade ou brilho mudariam o par texto/fundo que os
// tokens (e o tema do tenant) validam em 4,5:1 — com `opacity-90` o primário caía para 4,1:1.
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:shadow-md',
  secondary: 'border border-border bg-surface text-foreground hover:bg-muted',
  ghost: 'text-foreground hover:bg-muted',
  destructive: 'bg-destructive text-destructive-foreground hover:shadow-md',
};

// Alvo de toque ≥ 24 px em todos os tamanhos (RN-FND-96 · WCAG 2.2 — 2.5.8).
const SIZES: Record<ButtonSize, string> = {
  sm: 'min-h-8 px-3 text-sm',
  md: 'min-h-10 px-4 text-sm',
  icon: 'size-9 p-0',
};

/** Classes do botão, reaproveitáveis por links com aparência de botão. */
export function buttonClassName({
  variant = 'primary',
  size = 'md',
  className,
}: {
  readonly variant?: ButtonVariant | undefined;
  readonly size?: ButtonSize | undefined;
  readonly className?: string | undefined;
} = {}): string {
  return cx(
    'inline-flex items-center justify-center gap-2 rounded-control font-medium transition',
    'disabled:cursor-not-allowed disabled:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60',
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}
