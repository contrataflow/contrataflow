'use client';

import { AI_GENERATION_ERROR_CODES } from '@contrataflow/types';
import type { AiTargetModule } from '@contrataflow/types';
import { Alert, Button, Skeleton } from '@contrataflow/ui';
import {
  AI_INSTRUCTION_MAX,
  AI_NEED_SUMMARY_MAX,
  AI_NEED_SUMMARY_MIN,
} from '@contrataflow/validation';
import type { AiGenerationDto } from '@contrataflow/validation';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import type { SyntheticEvent } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';
import { formatDateTime } from '@/lib/i18n/format';
import { useShellSession, useTenantId } from '@/lib/session/session-context';

import { AiDisclaimer } from './ai-disclaimer';
import { AiGenerationProgress } from './ai-generation-progress';
import { AiHistoryTab } from './ai-history-tab';
import { useAiGeneration } from './ai-polling';
import { aiKeys, discardAiGeneration, isGenerating, requestAiGeneration } from './ai.api';

type Tab = 'generate' | 'proposal' | 'history';
const TABS: readonly Tab[] = ['generate', 'proposal', 'history'];

export interface AiAssistantPanelProps {
  readonly processId: string;
  readonly documentId: string | null;
  readonly targetModule: AiTargetModule;
  /** O pedido pode ser feito (AI_GENERATE e documento editável); senão só proposta e histórico. */
  readonly canGenerate: boolean;
  /** Rascunho do DFD: o resumo é obrigatório (US-117). */
  readonly needSummaryRequired: boolean;
  /** `?ia=<generationId>`: abre o painel já na geração (notificação `AI_GENERATION_READY`). */
  readonly initialGenerationId: string | null;
  readonly onClose: () => void;
}

interface TipTapNode {
  readonly type?: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly content?: readonly TipTapNode[];
}

/** Texto corrido da seção proposta (prévia; o editor rico mostra o conteúdo completo — US-117). */
export function previewText(node: TipTapNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'toConfirm') {
    const label = node.attrs?.label;
    return `[a confirmar: ${typeof label === 'string' ? label : ''}]`;
  }
  const inner = (node.content ?? []).map(previewText).join(node.type === 'doc' ? '\n' : '');
  return inner;
}

/**
 * `AiAssistantPanel` (SCR-117 · US-115): painel lateral com "Gerar", "Proposta" e "Histórico de
 * IA". O pedido é assíncrono (AI-01 → 202) e o acompanhamento, por AI-02 com recuo; o editor nunca
 * fica bloqueado. O conteúdo específico de cada documento (formulário, aplicação seletiva,
 * comparação) chega com as US-117 a US-121 — aqui ficam a base, o resumo genérico, a prévia, o
 * descarte e o histórico. Abaixo de 768 px ocupa a tela inteira.
 */
export function AiAssistantPanel({
  processId,
  documentId,
  targetModule,
  canGenerate,
  needSummaryRequired,
  initialGenerationId,
  onClose,
}: AiAssistantPanelProps) {
  const t = useTranslations('ai');
  const tenantId = useTenantId();
  const timeZone = useShellSession().activeTenant.timezone;
  const queryClient = useQueryClient();
  const titleId = useId();
  const tabsId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [tab, setTab] = useState<Tab>(
    initialGenerationId !== null || !canGenerate ? 'proposal' : 'generate',
  );
  const [generationId, setGenerationId] = useState<string | null>(initialGenerationId);
  const [needSummary, setNeedSummary] = useState('');
  const [instruction, setInstruction] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const { generation, stalled } = useAiGeneration(generationId);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  const request = useIdempotentMutation({
    mutationFn: (_: undefined, context) =>
      requestAiGeneration(
        processId,
        {
          targetModule,
          kind: 'DRAFT',
          ...(documentId === null ? {} : { documentId }),
          ...(needSummary.trim() === '' ? {} : { needSummary: needSummary.trim() }),
          ...(instruction.trim() === '' ? {} : { instruction: instruction.trim() }),
        },
        context,
      ),
  });

  const summaryLength = needSummary.trim().length;
  const summaryInvalid =
    (needSummaryRequired || summaryLength > 0) &&
    (summaryLength < AI_NEED_SUMMARY_MIN || summaryLength > AI_NEED_SUMMARY_MAX);
  const instructionInvalid = instruction.trim().length > AI_INSTRUCTION_MAX;

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    if (summaryInvalid || instructionInvalid) {
      setFormError(summaryInvalid ? t('form.needSummaryInvalid') : t('form.instructionInvalid'));
      return;
    }
    setFormError(null);
    try {
      const created = await request.submit(undefined);
      queryClient.setQueryData(aiKeys.generation(tenantId, created.id), created);
      setGenerationId(created.id);
      setTab('proposal');
      void queryClient.invalidateQueries({ queryKey: aiKeys.history(tenantId, processId) });
      // AI-05 muda com o pedido (uso diário e reserva do mês — US-116).
      void queryClient.invalidateQueries({ queryKey: aiKeys.availabilityAll(tenantId) });
    } catch (error) {
      const apiError = isApiError(error) ? error : null;
      const activeId = activeGenerationOf(apiError?.problem);
      if (apiError?.code === 'AI_GENERATION_IN_PROGRESS' && activeId !== null) {
        setGenerationId(activeId);
        setNotice(t('states.inProgress'));
        setTab('proposal');
        return;
      }
      setFormError(
        apiError?.code === 'AI_PROVIDER_UNAVAILABLE'
          ? t('states.unavailable')
          : (apiError?.message ?? t('states.requestFailed')),
      );
    }
  }

  async function discard(current: AiGenerationDto) {
    setDiscarding(true);
    try {
      const updated = await discardAiGeneration(current.id);
      queryClient.setQueryData(aiKeys.generation(tenantId, updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: aiKeys.history(tenantId, processId) });
      if (updated.status === 'DISCARDED') setNotice(t('proposal.discarded'));
    } catch (error) {
      setNotice(isApiError(error) ? error.message : t('states.requestFailed'));
    } finally {
      setDiscarding(false);
    }
  }

  function retry() {
    setGenerationId(null);
    setTab('generate');
  }

  const status = generation?.status;
  const announcement = status === undefined ? '' : t(`history.status.${status}`);

  return (
    <aside
      aria-labelledby={titleId}
      className="fixed inset-0 z-40 flex flex-col gap-4 overflow-y-auto bg-background p-4 shadow-lg md:inset-y-0 md:right-0 md:left-auto md:w-[28rem] md:border-l md:border-border"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 id={titleId} ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">
          {t('panel.title')}
        </h2>
        <Button variant="secondary" onClick={onClose}>
          {t('panel.close')}
        </Button>
      </div>
      <AiDisclaimer />
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <div
        role="tablist"
        aria-label={t('panel.tabs.label')}
        className="flex gap-2 border-b border-border"
      >
        {TABS.filter((item) => item !== 'generate' || canGenerate).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            id={`${tabsId}-${item}`}
            aria-selected={tab === item}
            aria-controls={`${tabsId}-${item}-panel`}
            className={`px-3 py-2 text-sm ${tab === item ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'}`}
            onClick={() => {
              setTab(item);
            }}
          >
            {t(`panel.tabs.${item}`)}
          </button>
        ))}
      </div>

      {notice ? (
        <Alert tone="info" title={notice}>
          {null}
        </Alert>
      ) : null}

      <div role="tabpanel" id={`${tabsId}-${tab}-panel`} aria-labelledby={`${tabsId}-${tab}`}>
        {tab === 'generate' ? (
          <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t('form.needSummary')}</span>
              <textarea
                className="min-h-28 rounded-md border border-border p-2"
                value={needSummary}
                required={needSummaryRequired}
                aria-invalid={formError !== null && summaryInvalid}
                maxLength={AI_NEED_SUMMARY_MAX + 200}
                onChange={(event) => {
                  setNeedSummary(event.target.value);
                }}
              />
              <span className="text-xs text-muted-foreground">{t('form.needSummaryHint')}</span>
              <span className="text-xs text-muted-foreground" aria-live="polite">
                {t('form.needSummaryCount', { count: summaryLength })}
              </span>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t('form.instruction')}</span>
              <textarea
                className="min-h-16 rounded-md border border-border p-2"
                value={instruction}
                aria-invalid={formError !== null && instructionInvalid}
                onChange={(event) => {
                  setInstruction(event.target.value);
                }}
              />
            </label>
            {formError ? (
              <Alert tone="error" title={formError}>
                {null}
              </Alert>
            ) : null}
            <div>
              <Button type="submit" disabled={request.isPending}>
                {request.isPending ? t('form.submitting') : t('form.submit')}
              </Button>
            </div>
          </form>
        ) : null}

        {tab === 'proposal' ? (
          <ProposalView
            generation={generation}
            generationId={generationId}
            stalled={stalled}
            discarding={discarding}
            timeZone={timeZone}
            onDiscard={(current) => void discard(current)}
            onRetry={canGenerate ? retry : null}
          />
        ) : null}

        {tab === 'history' ? (
          <AiHistoryTab
            processId={processId}
            onOpen={(id) => {
              setGenerationId(id);
              setTab('proposal');
            }}
          />
        ) : null}
      </div>
    </aside>
  );
}

function activeGenerationOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const meta = (body as { meta?: { generationId?: unknown } }).meta;
  return typeof meta?.generationId === 'string' ? meta.generationId : null;
}

interface ProposalViewProps {
  readonly generation: AiGenerationDto | undefined;
  readonly generationId: string | null;
  readonly stalled: boolean;
  readonly discarding: boolean;
  readonly timeZone: string;
  readonly onDiscard: (generation: AiGenerationDto) => void;
  readonly onRetry: (() => void) | null;
}

function ProposalView({
  generation,
  generationId,
  stalled,
  discarding,
  timeZone,
  onDiscard,
  onRetry,
}: ProposalViewProps) {
  const t = useTranslations('ai');
  if (generationId === null)
    return <p className="text-sm text-muted-foreground">{t('proposal.empty')}</p>;
  if (generation === undefined) {
    return (
      <div role="status" className="flex flex-col gap-2">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  const retryButton = onRetry ? (
    <Button variant="secondary" onClick={onRetry}>
      {t('states.retry')}
    </Button>
  ) : null;

  if (isGenerating(generation.status)) {
    return (
      <AiGenerationProgress
        status={generation.status}
        stalled={stalled}
        canceling={discarding}
        onCancel={() => {
          onDiscard(generation);
        }}
      />
    );
  }
  if (generation.status === 'FAILED') {
    const reason = (AI_GENERATION_ERROR_CODES as readonly string[]).includes(
      generation.errorCode ?? '',
    )
      ? (generation.errorCode ?? 'default')
      : 'default';
    return (
      <Alert tone="error" title={t('states.failedTitle')}>
        <p>{t(`states.failedReason.${reason}`)}</p>
        {retryButton}
      </Alert>
    );
  }
  if (generation.status === 'SUCCEEDED' && generation.output) {
    return (
      <div className="flex flex-col gap-4">
        <h3 className="font-medium">{t('proposal.title')}</h3>
        {generation.expiresAt ? (
          <p className="text-xs text-muted-foreground">
            {t('proposal.expiresAt', { date: formatDateTime(generation.expiresAt, timeZone) })}
          </p>
        ) : null}
        {generation.output.warnings.map((warning) => (
          <Alert
            key={warning.code}
            tone="warning"
            live={false}
            title={t(`warnings.${warning.code}`)}
          >
            {null}
          </Alert>
        ))}
        <ul className="flex flex-col gap-3">
          {generation.output.sections.map((section) => (
            <li key={section.sectionKey} className="rounded-md border border-border p-3">
              <p className="font-medium">{section.title}</p>
              <p className="text-xs text-muted-foreground">
                {t('proposal.placeholders', { count: section.placeholdersCount })}
              </p>
              <p className="mt-2 text-sm break-words whitespace-pre-line">
                {previewText(section.content as TipTapNode)}
              </p>
            </li>
          ))}
        </ul>
        <div>
          <Button
            variant="secondary"
            disabled={discarding}
            onClick={() => {
              onDiscard(generation);
            }}
          >
            {discarding ? t('proposal.discarding') : t('proposal.discard')}
          </Button>
        </div>
      </div>
    );
  }
  const message =
    generation.status === 'EXPIRED'
      ? t('states.expired')
      : generation.status === 'APPLIED'
        ? t('states.applied')
        : generation.status === 'DISCARDED'
          ? t('proposal.discarded')
          : t('states.canceled');
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">{message}</p>
      {generation.status === 'APPLIED' ? null : retryButton}
    </div>
  );
}
