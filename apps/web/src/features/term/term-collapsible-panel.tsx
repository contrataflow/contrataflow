'use client';

import { ChevronDown, Collapsible, CollapsibleContent, CollapsibleTrigger } from '@contrataflow/ui';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import type { TermPanelKey } from './term-completion-model';

/**
 * Painel recolhível do editor do TR ("Itens", "Condições contratuais"): cartão sem borda com o
 * título como gatilho. Recolhido por padrão; o conteúdo só monta aberto (as consultas só rodam
 * sob demanda). `data-term-panel` é o âncora do link "O que falta" (`focusPanelField`).
 */
export function TermCollapsiblePanel({
  panel,
  title,
  children,
}: {
  readonly panel: TermPanelKey;
  readonly title: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      data-term-panel={panel}
      className="flex min-w-0 flex-col rounded-card bg-surface p-6 shadow-card"
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <h3 id={titleId} className="text-section-title text-brand-ink">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="group flex min-h-9 w-full items-center justify-between gap-2 text-left"
            >
              <span>{title}</span>
              <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </button>
          </CollapsibleTrigger>
        </h3>
        <CollapsibleContent className="mt-4 flex min-w-0 flex-col gap-4">
          {children}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
