'use client';

import { Button } from '@contrataflow/ui';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import { CorrelationCode } from './correlation-code';
import type { CorrelationCodeLabels } from './correlation-code';
import { ErrorIllustration } from './error-illustration';
import type { ErrorIllustrationKind } from './error-illustration';

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
  /** Desenho do motivo acima do título (páginas próprias de erro). */
  readonly illustration?: ErrorIllustrationKind | undefined;
}

/**
 * Corpo comum das páginas e boundaries de erro (SCR-111): ilustração (quando houver), título
 * focado e anunciado, uma frase de explicação, a ação da variante e `correlationId` quando houver
 * (RN-FND-93). Com ilustração, tudo centrado (página própria); sem ela, alinhado à esquerda
 * (boundaries dentro do shell).
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
  illustration,
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
      className={
        illustration
          ? 'mx-auto flex max-w-md flex-col items-center gap-4 py-12 text-center'
          : 'mx-auto flex max-w-xl flex-col gap-4 py-12'
      }
    >
      {illustration ? <ErrorIllustration kind={illustration} /> : null}
      <Heading
        ref={headingRef}
        tabIndex={-1}
        className="text-2xl font-bold tracking-tight text-brand-ink outline-none"
      >
        {title}
      </Heading>
      <p className="text-muted-foreground">{description}</p>
      {correlationId && correlationLabels ? (
        <CorrelationCode correlationId={correlationId} labels={correlationLabels} />
      ) : null}
      <div
        className={illustration ? 'flex flex-wrap justify-center gap-2' : 'flex flex-wrap gap-2'}
      >
        {onRetry && retryLabel ? <Button onClick={onRetry}>{retryLabel}</Button> : null}
        {actions}
      </div>
    </section>
  );
}
