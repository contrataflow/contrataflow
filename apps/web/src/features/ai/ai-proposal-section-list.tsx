'use client';

import { Alert, Button, Checkbox, SectionDiffView, Skeleton } from '@contrataflow/ui';
import type { AiGenerationDto, DocumentDto, DraftSection } from '@contrataflow/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { documentKeys, fetchDocument } from '@/features/documents/documents.api';
import { isApiError } from '@/lib/api/api-error';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';
import { useTenantId } from '@/lib/session/session-context';

import { aiKeys, applyAiContent } from './ai.api';

interface TipTapNode {
  readonly type?: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly content?: readonly TipTapNode[];
}

/** Texto corrido de um conteúdo TipTap (prévia e comparação), com "[a confirmar: …]" legível. */
export function previewText(node: TipTapNode | null | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'toConfirm') {
    const label = node.attrs?.label;
    return `[a confirmar: ${typeof label === 'string' ? label : ''}]`;
  }
  return (node.content ?? []).map(previewText).join(node.type === 'doc' ? '\n' : '');
}

/** Seção com texto do usuário (`FILLED`/`NOT_APPLICABLE`): substituir exige confirmação. */
export function replacesText(section: DraftSection | undefined): boolean {
  return section?.state === 'FILLED' || section?.state === 'NOT_APPLICABLE';
}

/** Marcação padrão (fluxo principal 7): só as seções vazias vêm marcadas. */
export function defaultSelection(
  generation: AiGenerationDto,
  document: DocumentDto,
): ReadonlySet<string> {
  return new Set(
    (generation.output?.sections ?? [])
      .map((section) => section.sectionKey)
      .filter((key) => !replacesText(document.draftContent.sections[key])),
  );
}

function currentText(section: DraftSection | undefined): string {
  if (section === undefined) return '';
  if (section.state === 'NOT_APPLICABLE') return section.justification ?? '';
  return previewText(section.content);
}

export interface AiProposalSectionListProps {
  readonly generation: AiGenerationDto;
  readonly documentId: string;
  readonly discarding: boolean;
  readonly onDiscard: () => void;
  /** Depois do DOC-26: o editor recarrega as seções (badge "Gerado por IA" e [a confirmar]). */
  readonly onApplied?: ((document: DocumentDto, appliedCount: number) => void) | undefined;
}

/**
 * `AiProposalSectionList` + `AiSectionDiffView` (SCR-117 · US-117): cada seção da proposta com
 * prévia, contagem de [a confirmar] e checkbox — vazias marcadas; preenchidas ou "não se aplica"
 * desmarcadas com o aviso "substituirá o texto atual". "Comparar" mostra Atual × Sugerido (rótulos,
 * não só cor). "Aplicar seleção" (DOC-26, `If-Match` da versão lida) pede confirmação quando
 * substitui texto: uma versão é criada antes e as seções não marcadas não poderão ser aplicadas
 * depois. 412 recarrega o documento e a comparação, mantendo a seleção (FA-05).
 */
export function AiProposalSectionList({
  generation,
  documentId,
  discarding,
  onDiscard,
  onApplied,
}: AiProposalSectionListProps) {
  const t = useTranslations('ai.apply');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const confirmId = useId();
  const document = useQuery({
    queryKey: documentKeys.detail(tenantId, documentId),
    queryFn: ({ signal }) => fetchDocument(documentId, signal),
    throwOnError: false,
  });
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null);
  const [comparing, setComparing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const apply = useIdempotentMutation({
    mutationFn: (
      variables: { keys: readonly string[]; version: number; replace: boolean },
      context,
    ) =>
      applyAiContent(
        documentId,
        {
          generationId: generation.id,
          sectionKeys: [...variables.keys],
          confirmReplaceFilled: variables.replace,
        },
        variables.version,
        context,
      ),
  });

  if (document.data === undefined) {
    return document.isError ? (
      <Alert tone="error" title={t('loadFailed')}>
        <Button variant="secondary" onClick={() => void document.refetch()}>
          {t('retry')}
        </Button>
      </Alert>
    ) : (
      <div role="status" aria-label={t('loading')} className="flex flex-col gap-2">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  const current = document.data.document;
  const sections = generation.output?.sections ?? [];
  const chosen = selected ?? defaultSelection(generation, current);
  const keys = sections.map((section) => section.sectionKey).filter((key) => chosen.has(key));
  const replacing = keys.filter((key) => replacesText(current.draftContent.sections[key]));

  const toggle = (key: string) => {
    const next = new Set(chosen);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
    setConfirming(false);
  };

  async function submit() {
    setError(null);
    setNotice(null);
    try {
      const result = await apply.submit({
        keys,
        version: current.version,
        replace: replacing.length > 0,
      });
      queryClient.setQueryData(documentKeys.detail(tenantId, documentId), {
        document: result.document,
        meta: document.data?.meta ?? { allowedActions: [] },
      });
      void queryClient.invalidateQueries({ queryKey: documentKeys.all(tenantId, documentId) });
      void queryClient.invalidateQueries({ queryKey: aiKeys.generation(tenantId, generation.id) });
      void queryClient.invalidateQueries({
        queryKey: aiKeys.history(tenantId, generation.processId),
      });
      setConfirming(false);
      onApplied?.(result.document, result.appliedSectionKeys.length);
    } catch (failure) {
      const apiError = isApiError(failure) ? failure : null;
      if (apiError?.status === 412) {
        // FA-05: o documento mudou — recarrega e mantém a seleção.
        setNotice(t('conflict'));
        setConfirming(false);
        void document.refetch();
        return;
      }
      setError(apiError?.message ?? t('failed'));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {notice ? (
        <Alert tone="info" title={notice}>
          {null}
        </Alert>
      ) : null}
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-medium">{t('legend')}</legend>
        {sections.map((section) => {
          const draft = current.draftContent.sections[section.sectionKey];
          const checkboxId = `${confirmId}-${section.sectionKey}`;
          const warningId = `${checkboxId}-warning`;
          const replaces = replacesText(draft);
          return (
            <div key={section.sectionKey} className="rounded-card border border-border p-4">
              <div className="flex items-start gap-2">
                <Checkbox
                  id={checkboxId}
                  className="mt-0.5"
                  checked={chosen.has(section.sectionKey)}
                  aria-describedby={replaces ? warningId : undefined}
                  onCheckedChange={() => {
                    toggle(section.sectionKey);
                  }}
                />
                <label htmlFor={checkboxId} className="flex min-w-0 flex-col gap-1">
                  <span className="font-medium">{section.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {t('placeholders', { count: section.placeholdersCount })}
                  </span>
                </label>
              </div>
              {replaces ? (
                <p id={warningId} className="mt-1 text-xs text-warning">
                  {t('replaces')}
                </p>
              ) : null}
              <p className="mt-2 text-sm break-words whitespace-pre-line">
                {previewText(section.content as TipTapNode)}
              </p>
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={comparing === section.sectionKey}
                onClick={() => {
                  setComparing(comparing === section.sectionKey ? null : section.sectionKey);
                }}
              >
                {comparing === section.sectionKey ? t('hideCompare') : t('compare')}
              </Button>
              {comparing === section.sectionKey ? (
                <SectionDiffView
                  serverText={currentText(draft)}
                  localText={previewText(section.content as TipTapNode)}
                  labels={{
                    serverColumn: t('diff.current'),
                    mineColumn: t('diff.suggested'),
                    inserted: t('diff.inserted'),
                    removed: t('diff.removed'),
                    empty: t('diff.empty'),
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </fieldset>

      {error ? (
        <Alert tone="error" title={error}>
          {null}
        </Alert>
      ) : null}

      {confirming ? (
        <div
          role="alertdialog"
          aria-labelledby={`${confirmId}-title`}
          aria-describedby={`${confirmId}-body`}
          className="flex flex-col gap-2 rounded-md border border-warning p-3"
        >
          <p id={`${confirmId}-title`} className="font-medium">
            {t('confirm.title', { count: replacing.length })}
          </p>
          <p id={`${confirmId}-body`} className="text-sm">
            {t('confirm.body')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={apply.isPending} onClick={() => void submit()}>
              {apply.isPending ? t('applying') : t('confirm.action')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t('confirm.back')}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={keys.length === 0 || apply.isPending || confirming}
            aria-describedby={keys.length === 0 ? `${confirmId}-none` : undefined}
            onClick={() => {
              if (replacing.length > 0) {
                setConfirming(true);
                return;
              }
              void submit();
            }}
          >
            {apply.isPending ? t('applying') : t('action', { count: keys.length })}
          </Button>
          <Button variant="secondary" disabled={discarding} onClick={onDiscard}>
            {discarding ? t('discarding') : t('discard')}
          </Button>
        </div>
        {keys.length === 0 ? (
          <span id={`${confirmId}-none`} className="text-xs text-muted-foreground">
            {t('none')}
          </span>
        ) : null}
      </div>
    </div>
  );
}
