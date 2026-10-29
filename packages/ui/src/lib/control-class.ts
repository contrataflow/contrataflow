import { cx } from './cx.js';

/*
 * Aparência comum dos controles de formulário (Input, Textarea, gatilhos de Select, Combobox e
 * DatePicker): 44 px de altura, borda `border-strong`, foco pelo anel global e erro em vermelho.
 * Sem `'use client'`: só classes.
 */
export function controlClassName(className?: string): string {
  return cx(
    'flex w-full min-w-0 rounded-control border border-border-strong bg-surface px-3 text-sm text-foreground',
    'transition-colors placeholder:text-muted-foreground hover:border-muted-foreground',
    'focus-visible:border-ring aria-invalid:border-destructive',
    'disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:hover:border-border-strong',
    className,
  );
}
