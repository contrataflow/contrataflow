import { cx } from './cx.js';

/*
 * Estilos do botão sem diretiva `'use client'`: Server Components também os usam para dar
 * aparência de botão a links (`<Link className={buttonClassName()}>`).
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'icon';

// O hover troca o fundo por um token validado (`primary-hover`, `muted`) ou eleva o botão; nunca
// esmaece: opacidade ou brilho mudariam o par texto/fundo que os tokens (e o tema do tenant)
// validam em 4,5:1 — com `opacity-90` o primário caía para 4,1:1.
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary-hover',
  secondary: 'border border-border-strong bg-surface text-brand-ink hover:bg-muted',
  ghost: 'text-foreground hover:bg-muted',
  destructive: 'bg-destructive text-destructive-foreground hover:shadow-md',
};

// Desabilitado em cinza neutro, sem depender de opacidade (prévia do sistema de design v2).
const DISABLED: Record<ButtonVariant, string> = {
  primary: 'disabled:bg-muted aria-disabled:bg-muted',
  secondary: 'disabled:border-border aria-disabled:border-border',
  ghost: '',
  destructive: 'disabled:bg-muted aria-disabled:bg-muted',
};

// Alvo de toque de 44 px no tamanho padrão e no ícone (prd-4); `sm` (36 px) só em barras densas,
// ainda acima dos 24 px do WCAG 2.2 — 2.5.8 (RN-FND-96).
const SIZES: Record<ButtonSize, string> = {
  sm: 'min-h-9 px-3 text-sm',
  md: 'min-h-11 px-[1.125rem] text-sm',
  icon: 'size-11 p-0',
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
    'inline-flex items-center justify-center gap-2 rounded-control font-semibold transition-colors',
    'disabled:cursor-not-allowed disabled:text-muted-foreground disabled:shadow-none',
    'aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground aria-disabled:shadow-none',
    VARIANTS[variant],
    DISABLED[variant],
    SIZES[size],
    className,
  );
}
