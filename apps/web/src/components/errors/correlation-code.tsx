'use client';

import { Button } from '@contrataflow/ui';
import { useState } from 'react';

export interface CorrelationCodeLabels {
  /** Texto com o código já interpolado (ex.: "Código: 3f2a…"). */
  readonly code: string;
  readonly copy: string;
  readonly copied: string;
}

/**
 * `correlationId` copiável (RN-FND-93/95): único código técnico exibido ao usuário, para o
 * suporte localizar a ocorrência nos logs.
 */
export function CorrelationCode({
  correlationId,
  labels,
}: {
  readonly correlationId: string;
  readonly labels: CorrelationCodeLabels;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <code className="rounded-control bg-muted px-2 py-1 font-mono text-foreground">
        {labels.code}
      </code>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          void navigator.clipboard
            .writeText(correlationId)
            .then(() => {
              setCopied(true);
            })
            .catch(() => {
              setCopied(false);
            });
        }}
      >
        {labels.copy}
      </Button>
      <span role="status" aria-live="polite">
        {copied ? labels.copied : ''}
      </span>
    </div>
  );
}
