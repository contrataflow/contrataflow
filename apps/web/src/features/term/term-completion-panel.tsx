'use client';

import {
  Alert,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ChevronDown,
  CircleCheck,
  Skeleton,
} from '@contrataflow/ui';
import type { TermDetailDto, TermTemplateSectionDto, Violation } from '@contrataflow/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';

import { useTenantId } from '@/lib/session/session-context';

import { completionSummaryOf, completionTargetOf } from './term-completion-model';
import type { CompletionTarget, TermPanelKey } from './term-completion-model';
import { termKeys } from './term.api';
import { documentKeys, fetchDocument, fetchDocumentValidation } from '../documents/documents.api';

/*
 * `TermCompletionPanel` (SCR-012 · US-039 · DOC-08): o painel "Completude do TR" — as pendências
 * bloqueantes (com link para a seção ou para o campo no painel que o edita) e os avisos de
 * consistência com o ETP, pelo MESMO serviço da validação da conclusão (RN-TR-34). Recalcula a
 * cada gravação (seção, campo ou item). A conclusão é a ação "Concluir TR"/"Submeter para
 * aprovação" do ciclo de vida do documento (o painel de pendências e o reconhecimento dos avisos
 * são os do `DocumentLifecycle`); concluído, o editor recarrega o TR e fica somente leitura.
 */

export interface TermCompletionPanelProps {
  readonly term: TermDetailDto;
  readonly sections: readonly TermTemplateSectionDto[];
  /** Muda a cada gravação de seção no editor (recalcula as pendências). */
  readonly revision: unknown;
  /** Abre a seção no editor. */
  readonly onSelectSection: (key: string) => void;
}

/** Abre o painel (se recolhido) e leva o foco ao campo — ou ao botão do painel. */
function focusPanelField(panel: TermPanelKey, field: string) {
  const container = document.querySelector<HTMLElement>(`[data-term-panel="${panel}"]`);
  if (container === null) return;
  // O gatilho do painel recolhido (não os seletores, que também têm `aria-expanded`).
  container
    .querySelector<HTMLButtonElement>('button[aria-expanded="false"]:not([role="combobox"])')
    ?.click();
  setTimeout(() => {
    const target =
      document.getElementById(`term-${field}`) ??
      container.querySelector<HTMLElement>(
        'input, textarea, [role="combobox"], [role="checkbox"], [role="radio"], button',
      );
    target?.focus();
  }, 0);
}

export function TermCompletionPanel({
  term,
  sections,
  revision,
  onSelectSection,
}: TermCompletionPanelProps) {
  const t = useTranslations('term.completion');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const id = useId();
  const [open, setOpen] = useState(true);
  const editable = term.status === 'DRAFT' || term.status === 'RETURNED';

  const validation = useQuery({
    queryKey: documentKeys.validation(tenantId, term.documentId),
    queryFn: ({ signal }) => fetchDocumentValidation(term.documentId, signal),
    enabled: editable,
    staleTime: 0,
    retry: false,
    throwOnError: false,
  });

  // Seção, campo ou item gravados → pendências de novo (o TR recarregado é outro objeto).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: documentKeys.validation(tenantId, term.documentId),
    });
  }, [term, revision, tenantId, queryClient]);

  // O ciclo de vida (DOC-10/09) muda o documento: o TR recarregado traz o status e as ações novas.
  const documentQuery = useQuery({
    queryKey: documentKeys.detail(tenantId, term.documentId),
    queryFn: ({ signal }) => fetchDocument(term.documentId, signal),
    throwOnError: false,
  });
  const documentStatus = documentQuery.data?.document.status;
  useEffect(() => {
    if (documentStatus === undefined || documentStatus === term.status) return;
    void queryClient.invalidateQueries({ queryKey: termKeys.detail(tenantId, term.id) });
  }, [documentStatus, term.status, term.id, tenantId, queryClient]);

  if (!editable) {
    if (term.status !== 'FINALIZED' && term.status !== 'IN_REVIEW') return null;
    return (
      <p aria-live="polite" className="text-sm font-medium text-success">
        {t(term.status === 'FINALIZED' ? 'finalized' : 'inReview')}
      </p>
    );
  }

  const violations: readonly Violation[] = validation.data?.violations ?? [];
  const { blocking, warnings } = completionSummaryOf(violations);
  const navigate = (target: Exclude<CompletionTarget, { kind: 'none' }>) => {
    if (target.kind === 'section') {
      onSelectSection(target.key);
      setTimeout(() => {
        document.getElementById(`term-section-${target.key}`)?.focus();
      }, 0);
      return;
    }
    focusPanelField(target.panel, target.field);
  };
  const render = (item: Violation, index: number) => {
    const target = completionTargetOf(item, sections);
    return (
      <li
        key={`${item.code}-${item.sectionKey ?? item.field ?? ''}-${item.itemId ?? ''}-${String(index)}`}
      >
        {target.kind === 'none' ? (
          <span>{item.message}</span>
        ) : (
          <button
            type="button"
            className="text-left text-primary underline underline-offset-2 hover:no-underline"
            onClick={() => {
              navigate(target);
            }}
          >
            {item.message}
            {target.kind === 'panel' ? (
              <span className="text-muted-foreground"> ({t(`panel.${target.panel}`)})</span>
            ) : null}
          </button>
        )}
      </li>
    );
  };

  const loaded = validation.data !== undefined;
  const clean = loaded && violations.length === 0;
  return (
    <section
      aria-labelledby={`${id}-title`}
      aria-busy={validation.isPending}
      data-testid="term-completion"
      className={
        clean
          ? 'flex min-w-0 flex-col gap-2 rounded-card bg-success/10 p-4'
          : 'flex min-w-0 flex-col gap-2 rounded-card bg-surface p-4 shadow-card'
      }
    >
      <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2">
        <h3 id={`${id}-title`} className="text-base font-semibold">
          {violations.length > 0 ? (
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="group flex min-h-9 w-full items-center justify-between gap-2 text-left"
              >
                <span>{t('title')}</span>
                <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
              </button>
            </CollapsibleTrigger>
          ) : (
            <span className="flex items-center gap-2">
              {clean ? <CircleCheck className="size-4 text-success" /> : null}
              {t('title')}
            </span>
          )}
        </h3>
        <p
          aria-live="polite"
          className={clean ? 'text-sm text-success' : 'text-sm text-muted-foreground'}
        >
          {!loaded
            ? validation.isError
              ? t('loadFailed')
              : t('loading')
            : blocking.length === 0
              ? t(warnings.length === 0 ? 'none' : 'onlyWarnings')
              : t('blocking', { count: blocking.length })}
        </p>
        {validation.isPending ? <Skeleton className="h-10 w-full" /> : null}
        {validation.isError && !loaded ? (
          <Alert tone="error" live={false} title={t('loadFailed')}>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() => {
                void validation.refetch();
              }}
            >
              {t('retry')}
            </Button>
          </Alert>
        ) : null}
        {violations.length > 0 ? (
          <CollapsibleContent className="flex flex-col gap-2">
            {blocking.length > 0 ? (
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium text-destructive">{t('blockingTitle')}</span>
                <ul className="list-disc pl-5 text-sm">{blocking.map(render)}</ul>
              </div>
            ) : null}
            {warnings.length > 0 ? (
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium text-warning">
                  {t('warningsTitle', { count: warnings.length })}
                </span>
                <ul className="list-disc pl-5 text-sm">{warnings.map(render)}</ul>
                <p className="text-xs text-muted-foreground">{t('warningsHint')}</p>
              </div>
            ) : null}
          </CollapsibleContent>
        ) : null}
      </Collapsible>
    </section>
  );
}
