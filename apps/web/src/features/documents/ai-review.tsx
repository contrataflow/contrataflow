'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  toast,
} from '@contrataflow/ui';
import type { DocumentAiReview, DocumentDto, DocumentMeta } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';

import { useShellSession, useTenantId } from '@/lib/session/session-context';

import { aiSectionAnchor, aiSectionsOf, sectionLabelOf } from './ai-review-model';
import type { AiSectionState, ToConfirmMark } from './ai-review-model';
import { describeDocumentError } from './document-errors';
import type { DocumentOutcome } from './document-errors';
import { documentKeys, reviewAiContent } from './documents.api';
import { OutcomeAlert } from './outcome-alert';
import { useReturnFocus } from './use-return-focus';

/*
 * Marcas de IA e revisão humana (US-122 · SCR-007/008/011/012 · SCR-117 · RN-AI-53..57): o
 * conteúdo gerado por IA fica "revisão pendente" até a pessoa marcar a seção como revisada
 * (DOC-27); cada "[a confirmar: …]" aparece em destaque. Estado sempre em texto + ícone (nunca só
 * cor); o resultado da revisão é anunciado numa região `aria-live`. Quem decide mostrar as ações é
 * `meta.allowedActions` (`UPDATE` = permissão de edição do tipo + POL-02 — `AI_GENERATE` não conta).
 */

/** `AiGeneratedBadge`: "Gerado por IA · revisão pendente" ou "· revisada por você em {data}". */
export function AiGeneratedBadge({ section }: { readonly section: AiSectionState }) {
  const t = useTranslations('documents.aiReview');
  const format = useFormatter();
  const session = useShellSession();
  if (section.ai === null) return null;
  if (section.pending) {
    return (
      <span className="inline-flex items-center gap-1 rounded-control border border-warning bg-warning-soft px-2 py-0.5 text-xs font-semibold text-foreground">
        <span aria-hidden="true">✦</span>
        {t('badge.pending')}
        {section.marks.length > 0 ? (
          <span className="font-normal">{t('badge.marks', { count: section.marks.length })}</span>
        ) : null}
      </span>
    );
  }
  const date = format.dateTime(new Date(section.ai.reviewedAt ?? ''), {
    dateStyle: 'short',
    timeStyle: 'short',
  });
  return (
    <span className="inline-flex items-center gap-1 rounded-control border border-border bg-muted px-2 py-0.5 text-xs font-semibold text-foreground">
      <span aria-hidden="true">✓</span>
      {section.ai.reviewedById === session.user.id
        ? t('badge.reviewedByMe', { date })
        : t('badge.reviewed', { date })}
    </span>
  );
}

/**
 * `ToConfirmChip`: a pendência "[a confirmar: {label}]" focável por teclado. No editor de seções
 * (US-063/US-015) o chip abre "Substituir pelo dado"; aqui ele só a destaca e a anuncia.
 */
export function ToConfirmChip({ mark }: { readonly mark: ToConfirmMark }) {
  const t = useTranslations('documents.aiReview');
  return (
    <span
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- pendência focável por teclado (story: aria-label do chip)
      tabIndex={0}
      role="note"
      aria-label={t('chip.ariaLabel', { label: mark.label })}
      className="inline-flex max-w-full items-center rounded-control border border-dashed border-warning bg-warning-soft px-1.5 py-0.5 text-sm font-semibold break-words text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {t('chip.text', { label: mark.label })}
    </span>
  );
}

type ReviewOutcome = DocumentOutcome | null;

/** DOC-27 com recarga do documento e da completude; 412 recarrega a seção (V-04). */
function useAiReview(document: DocumentDto, onDone: (reviewed: number) => void) {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const pathname = usePathname();
  const router = useRouter();
  const [outcome, setOutcome] = useState<ReviewOutcome>(null);
  const [last, setLast] = useState<DocumentAiReview | null>(null);
  const mutation = useMutation({
    mutationFn: (body: DocumentAiReview) => reviewAiContent(document.id, body),
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: documentKeys.all(tenantId, document.id) });

  const send = async (body: DocumentAiReview) => {
    setLast(body);
    setOutcome(null);
    try {
      const result = await mutation.mutateAsync(body);
      void refresh();
      onDone(result.reviewedSectionKeys.length);
    } catch (failure) {
      const described = describeDocumentError(failure, pathname);
      if (described.kind === 'redirect') {
        router.push(described.href);
        return;
      }
      // Conflito (a seção mudou), 409/403/404: recarrega e mostra o motivo.
      if (described.kind !== 'unavailable' && described.kind !== 'unexpected') void refresh();
      setOutcome(described);
    }
  };
  return { send, retry: () => (last ? send(last) : Promise.resolve()), outcome, mutation };
}

function OutcomeMessage({
  outcome,
  onRetry,
}: {
  readonly outcome: ReviewOutcome;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('documents.aiReview');
  if (outcome === null) return null;
  const inline = (text: string) => <p className="text-sm break-words text-destructive">{text}</p>;
  switch (outcome.kind) {
    case 'conflict':
      return inline(t('errors.conflict'));
    case 'field':
      return inline(outcome.message);
    case 'forbidden':
    case 'invalidState':
      return inline(outcome.detail ?? t('errors.notAllowed'));
    case 'notFound':
      return inline(t('errors.notFound'));
    case 'rateLimited':
      return inline(t('errors.rateLimited'));
    case 'unavailable':
      return (
        <Alert tone="error" title={t('errors.unavailable')}>
          <Button size="sm" variant="secondary" className="mt-3" onClick={onRetry}>
            {t('errors.retry')}
          </Button>
        </Alert>
      );
    case 'unexpected':
      return <OutcomeAlert outcome={outcome} onRetry={onRetry} />;
    default:
      return null;
  }
}

/** `MarkReviewedButton` — DOC-27 de uma seção, com a revisão lida pelo editor. */
export function MarkReviewedButton({
  document,
  section,
  onReviewed,
}: {
  readonly document: DocumentDto;
  readonly section: AiSectionState;
  readonly onReviewed: (message: string) => void;
}) {
  const t = useTranslations('documents.aiReview');
  const review = useAiReview(document, () => {
    toast({ title: t('toast.one'), tone: 'success' });
    onReviewed(t('announce.one', { section: sectionLabelOf(section.key) }));
  });
  const pending = review.mutation.isPending;
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="secondary"
        disabled={pending}
        aria-busy={pending}
        onClick={() => {
          void review.send({
            sectionKeys: [section.key],
            expectedRevisions: { [section.key]: section.revision },
          });
        }}
      >
        {pending ? t('working') : t('markReviewed')}
      </Button>
      <OutcomeMessage outcome={review.outcome} onRetry={() => void review.retry()} />
    </div>
  );
}

/** `ReviewAllDialog` — "Li e revisei as N seções" → DOC-27 com `confirmAll: true` (V-03). */
export function ReviewAllDialog({
  document,
  sections,
  onClose,
  onReviewed,
}: {
  readonly document: DocumentDto;
  readonly sections: readonly AiSectionState[];
  readonly onClose: () => void;
  readonly onReviewed: (message: string) => void;
}) {
  const t = useTranslations('documents.aiReview');
  const returnFocus = useReturnFocus();
  const [confirmed, setConfirmed] = useState(false);
  const review = useAiReview(document, (reviewed) => {
    toast({ title: t('toast.many', { count: reviewed }), tone: 'success' });
    onReviewed(t('announce.many', { count: reviewed }));
    onClose();
  });
  const pending = review.mutation.isPending;
  const count = sections.length;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent
        className="max-md:inset-0 max-md:h-full max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:overflow-y-auto max-md:rounded-none"
        onOpenAutoFocus={returnFocus.remember}
        onCloseAutoFocus={returnFocus.restore}
      >
        <DialogTitle>{t('reviewAll.title')}</DialogTitle>
        <DialogDescription>{t('reviewAll.description', { count })}</DialogDescription>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {sections.map((section) => (
            <li key={section.key}>{sectionLabelOf(section.key)}</li>
          ))}
        </ul>
        <label className="flex items-start gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className="mt-1 size-4"
            checked={confirmed}
            onChange={(event) => {
              setConfirmed(event.target.checked);
            }}
          />
          {t('reviewAll.confirmLabel', { count })}
        </label>
        <div aria-live="assertive">
          <OutcomeMessage outcome={review.outcome} onRetry={() => void review.retry()} />
        </div>
        <DialogFooter>
          <Button variant="secondary" disabled={pending} onClick={onClose}>
            {t('reviewAll.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={pending || !confirmed}
            aria-busy={pending}
            onClick={() => {
              void review.send({
                sectionKeys: sections.map((section) => section.key),
                expectedRevisions: Object.fromEntries(
                  sections.map((section) => [section.key, section.revision]),
                ),
                confirmAll: true,
              });
            }}
          >
            {pending ? t('working') : t('reviewAll.confirm', { count })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Painel "Conteúdo gerado por IA" do documento: uma linha por seção com IA ou marcações, o badge,
 * os chips e "Marcar seção como revisada"; "Revisar todas" com 2+ seções pendentes. Some quando não
 * há nada de IA nem "[a confirmar]" no rascunho.
 */
export function AiReviewPanel({
  document,
  meta,
}: {
  readonly document: DocumentDto;
  readonly meta: DocumentMeta;
}) {
  const t = useTranslations('documents.aiReview');
  const [announcement, setAnnouncement] = useState('');
  const [reviewAllOpen, setReviewAllOpen] = useState(false);
  const sections = aiSectionsOf(document);
  if (sections.length === 0) return null;
  const canReview = meta.allowedActions.includes('UPDATE');
  const pending = sections.filter((section) => section.pending);
  const marks = sections.reduce((sum, section) => sum + section.marks.length, 0);

  return (
    <section aria-labelledby="ai-review-title" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ai-review-title" className="text-lg font-semibold">
          {t('title')}
        </h2>
        {canReview && pending.length >= 2 ? (
          <Button
            variant="secondary"
            onClick={() => {
              setReviewAllOpen(true);
            }}
          >
            {t('reviewAll.open', { count: pending.length })}
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        {pending.length > 0 || marks > 0
          ? t('summary', { pending: pending.length, marks })
          : t('summaryDone')}
      </p>
      <ul className="flex flex-col gap-3">
        {sections.map((section) => (
          <li
            key={section.key}
            id={aiSectionAnchor(section.key)}
            tabIndex={-1}
            className="flex min-w-0 flex-col gap-2 rounded-control border border-border p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold break-words">{sectionLabelOf(section.key)}</h3>
              <AiGeneratedBadge section={section} />
            </div>
            {section.marks.length > 0 ? (
              <div className="flex flex-col gap-1">
                <p className="text-xs text-muted-foreground">
                  {t('marksHint', { count: section.marks.length })}
                </p>
                <div className="flex flex-wrap gap-1">
                  {section.marks.map((mark, index) => (
                    <ToConfirmChip key={`${mark.label}:${String(index)}`} mark={mark} />
                  ))}
                </div>
              </div>
            ) : null}
            {canReview && section.pending ? (
              <MarkReviewedButton
                document={document}
                section={section}
                onReviewed={setAnnouncement}
              />
            ) : null}
          </li>
        ))}
      </ul>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {reviewAllOpen ? (
        <ReviewAllDialog
          document={document}
          sections={pending}
          onClose={() => {
            setReviewAllOpen(false);
          }}
          onReviewed={setAnnouncement}
        />
      ) : null}
    </section>
  );
}
