'use client';

import type { DocumentDto } from '@contrataflow/validation';
import { useState } from 'react';

import { AiGeneratedBadge, MarkReviewedButton } from '../documents/ai-review';
import type { AiReviewHost } from '../documents/ai-review';
import { aiSectionsOf } from '../documents/ai-review-model';
import type { AiSectionState } from '../documents/ai-review-model';

/*
 * Revisão humana do conteúdo de IA dentro do assistente do DFD (US-122 · RN-AI-55/57 · DOC-27): a
 * única forma de registrar a revisão é a ação DOC-27, então o assistente reaproveita a do painel
 * da SCR-105 — o selo e "Marcar seção como revisada" ao lado do campo, e "Marcar como revisada" /
 * "Revisar todas" no passo Revisão. Quem decide mostrar a ação é `canReview` (edição do DFD).
 */

export interface DfdAiReview {
  readonly document: DocumentDto;
  readonly canReview: boolean;
  readonly host: AiReviewHost;
}

/** Seções com conteúdo de IA (revisadas ou pendentes) do rascunho. */
export function aiGeneratedSectionsOf(document: DocumentDto): AiSectionState[] {
  return aiSectionsOf(document).filter((section) => section.ai !== null);
}

/** Selo "Gerado por IA · …" e "Marcar seção como revisada" de uma seção, junto ao campo. */
export function SectionAiReview({
  review,
  sectionKey,
}: {
  readonly review: DfdAiReview;
  readonly sectionKey: string;
}) {
  const [announcement, setAnnouncement] = useState('');
  const section = aiGeneratedSectionsOf(review.document).find((item) => item.key === sectionKey);
  if (section === undefined) return null;
  return (
    <div className="flex flex-wrap items-start gap-3" data-testid={`dfd-ai-review-${sectionKey}`}>
      <AiGeneratedBadge section={section} />
      {review.canReview && section.pending ? (
        <MarkReviewedButton
          document={review.document}
          section={section}
          onReviewed={setAnnouncement}
          host={review.host}
        />
      ) : null}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
