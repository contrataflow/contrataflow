'use client';

import { Button } from '@contrataflow/ui';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import { CorrelationCode } from './correlation-code';
import type { CorrelationCodeLabels } from './correlation-code';

export interface ErrorViewProps {
  readonly title: string;
  readonly description: string;
  readonly correlationId?: string | null | undefined;
  readonly correlationLabels?: CorrelationCodeLabels | undefined;
  readonly retryLabel?: string | undefined;
  readonly onRetry?: (() => void) | undefined;
  /** Ações extras (links para login, troca de instituição, início). */
  readonly actions?: ReactNode;
  /** `h1` em páginas próprias; `h2` dentro do shell. */
  readonly headingLevel?: 1 | 2 | undefined;
}

/**
 * Corpo comum das páginas e boundaries de erro (SCR-111): título focado e anunciado,
 * explicação, ação primária e `correlationId` quando houver (RN-FND-93).
 */
export function ErrorView({
  title,
  description,
  correlationId,
  correlationLabels,
  retryLabel,
  onRetry,
  actions,
  headingLevel = 1,
}: ErrorViewProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  return (
    <section
      role="alert"
      aria-live="assertive"
      className="mx-auto flex max-w-xl flex-col gap-4 py-12"
    >
      <Heading
        ref={headingRef}
        tabIndex={-1}
        className="text-2xl font-semibold tracking-tight outline-none"
      >
        {title}
      </Heading>
      <p className="text-muted-foreground">{description}</p>
      {correlationId && correlationLabels ? (
        <CorrelationCode correlationId={correlationId} labels={correlationLabels} />
      ) : null}
      <div className="flex flex-wrap gap-2">
        {onRetry && retryLabel ? <Button onClick={onRetry}>{retryLabel}</Button> : null}
        {actions}
      </div>
    </section>
  );
}
