'use client';

import { AI_GENERATION_ERROR_CODES } from '@contrataflow/types';
import type { AiTargetModule } from '@contrataflow/types';
import { Alert, Button, Skeleton } from '@contrataflow/ui';
import {
  AI_INSTRUCTION_MAX,
  AI_NEED_SUMMARY_MAX,
  AI_NEED_SUMMARY_MIN,
} from '@contrataflow/validation';
import type {
  AiGenerationDto,
  AiGenerationOutput,
  DocumentDto,
  RiskLevelThreshold,
} from '@contrataflow/validation';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode, SyntheticEvent } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';
import { formatDateTime } from '@/lib/i18n/format';
import { useShellSession, useTenantId } from '@/lib/session/session-context';

import { AiDisclaimer } from './ai-disclaimer';
import { AiGenerationProgress } from './ai-generation-progress';
import { AiHistoryTab } from './ai-history-tab';
import { useAiGeneration } from './ai-polling';
import { AiProposalSectionList, previewText } from './ai-proposal-section-list';
import { AiRiskProposalList } from './ai-risk-proposal-list';
import { aiKeys, discardAiGeneration, isGenerating, requestAiGeneration } from './ai.api';

type Tab = 'generate' | 'proposal' | 'history';

/** Mapa de riscos (US-119): faixas vigentes e riscos já registrados, para a proposta de riscos. */
export interface AiRiskContext {
  readonly levelThresholds: readonly RiskLevelThreshold[];
  readonly existing: readonly { readonly id: string; readonly code: string }[];
  /** RSK-11 aplicado: a lista de riscos recarrega. */
  readonly onRisksApplied?: (() => void) | undefined;
}
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
  /** DOC-26 aplicado (US-117): o editor recarrega as seções com o conteúdo gerado. */
  readonly onApplied?: ((document: DocumentDto) => void) | undefined;
  /** Mapa de riscos (US-119): a proposta traz riscos, aplicados pelo RSK-11. */
  readonly riskContext?: AiRiskContext | undefined;
  /**
   * `AiRequestForm` do documento montado pelo editor com os dados já carregados (US-120: as
   * entradas e as condições do TR preenchidas e ausentes).
   */
  readonly requestGuide?: ReactNode;
}

export { previewText };

/**
 * `AiAssistantPanel` (SCR-117 · US-115): painel lateral com "Gerar", "Proposta" e "Histórico de
 * IA". O pedido é assíncrono (AI-01 → 202) e o acompanhamento, por AI-02 com recuo; o editor nunca
 * fica bloqueado. US-117: na proposta pronta do próprio solicitante, a aplicação seletiva por seção
 * com comparação (`AiProposalSectionList` → DOC-26); para os demais, a prévia somente leitura
 * (FA-06). Abaixo de 768 px ocupa a tela inteira.
 */
export function AiAssistantPanel({
  processId,
  documentId,
  targetModule,
  canGenerate,
  needSummaryRequired,
  initialGenerationId,
  onClose,
  onApplied,
  riskContext,
  requestGuide,
}: AiAssistantPanelProps) {
  const t = useTranslations('ai');
  const tenantId = useTenantId();
  const session = useShellSession();
  const timeZone = session.activeTenant.timezone;
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
  /**
   * `AI_PREREQUISITE_MISSING` (US-118/US-120 · FA-01): sem o documento de origem (DFD do ETP, ETP
   * do TR), o atalho para os documentos.
   */
  const [missingSource, setMissingSource] = useState(false);
  /** O TR não usa resumo da necessidade: ela vem do ETP (US-120 · passo 2). */
  const asksSummary = targetModule !== 'TERM_OF_REFERENCE';
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
    setMissingSource(false);
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
      if (apiError?.code === 'AI_PREREQUISITE_MISSING') {
        setMissingSource(true);
        setFormError(
          t(targetModule === 'TERM_OF_REFERENCE' ? 'form.prerequisiteEtp' : 'form.prerequisiteDfd'),
        );
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
            {targetModule === 'ETP' ? <EtpRequestGuide /> : null}
            {requestGuide}
            {asksSummary ? (
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
            ) : null}
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
                {missingSource ? (
                  <Link href={`/processos/${processId}`} className="text-primary underline">
                    {t('form.prerequisiteLink')}
                  </Link>
                ) : null}
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
            documentId={documentId}
            processId={processId}
            targetModule={targetModule}
            riskContext={riskContext}
            userId={session.user.id}
            canApply={canGenerate}
            onDiscard={(current) => void discard(current)}
            onRetry={canGenerate ? retry : null}
            onApplied={(document, count) => {
              setNotice(t('apply.done', { count }));
              onApplied?.(document);
            }}
            onRisksApplied={(count) => {
              setNotice(t('riskProposal.done', { count }));
              riskContext?.onRisksApplied?.();
            }}
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

/**
 * `AiRequestForm` do ETP (US-118 · passo 2): as entradas previstas, as decisões que continuam com a
 * pessoa (RN-AI-35) e o consumo estimado (RN-AI-18). A API confere os pré-requisitos no AI-01 e
 * devolve os avisos definitivos na proposta.
 */
function EtpRequestGuide() {
  const t = useTranslations('ai.form.etp');
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3 text-sm">
      <section className="flex flex-col gap-1">
        <h3 className="font-medium">{t('inputsTitle')}</h3>
        <ul className="list-disc pl-5">
          {(['dfd', 'items', 'alternatives', 'priceResearch'] as const).map((key) => (
            <li key={key}>{t(`inputs.${key}`)}</li>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="font-medium">{t('decisionsTitle')}</h3>
        <ul className="list-disc pl-5">
          {(['conclusion', 'solution', 'parceling'] as const).map((key) => (
            <li key={key}>{t(`decisions.${key}`)}</li>
          ))}
        </ul>
      </section>
      <p className="text-xs text-muted-foreground">{t('estimate')}</p>
    </div>
  );
}

const MISSING_INPUTS = [
  'ITEMS',
  'ETP_ITEMS',
  'ALTERNATIVES',
  'RISKS',
  'TERM_ITEMS',
  'EXPECTED_DATE',
  'PCA_LINK',
  'DFD',
  'ETP',
  'RISK_MAP',
  'TERM_OF_REFERENCE',
] as const;
type MissingInput = (typeof MISSING_INPUTS)[number] | 'other';

/** Lacuna avisada pelo gerador (`MISSING_OPTIONAL_INPUT` · FA-07); desconhecida = `other`. */
function missingInputOf(warning: AiGenerationOutput['warnings'][number]): MissingInput | null {
  if (warning.code !== 'MISSING_OPTIONAL_INPUT') return null;
  const input = warning.params?.input ?? '';
  return MISSING_INPUTS.find((known) => known === input) ?? 'other';
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
  readonly documentId: string | null;
  readonly processId: string;
  readonly targetModule: AiTargetModule;
  readonly riskContext: AiRiskContext | undefined;
  /** Usuário da sessão: só o solicitante aplica ou descarta (RN-AI-13 · FA-06). */
  readonly userId: string;
  /** Pode aplicar (AI_GENERATE e documento editável; a API confere DFD_UPDATE + POL-02). */
  readonly canApply: boolean;
  readonly onDiscard: (generation: AiGenerationDto) => void;
  readonly onRetry: (() => void) | null;
  readonly onApplied: (document: DocumentDto, count: number) => void;
  readonly onRisksApplied: (count: number) => void;
}

/**
 * Partes ainda aplicáveis da proposta (US-119 · RN-AI-40/41): no mapa de riscos, riscos (RSK-11) e
 * seções (DOC-26) são aplicados uma vez cada — a geração `APPLIED` ainda aceita a outra parte.
 */
export function pendingParts(
  generation: AiGenerationDto,
  documentId: string | null,
): { readonly risks: boolean; readonly sections: boolean } {
  const applied = generation.appliedTargets;
  const open =
    generation.status === 'SUCCEEDED' ||
    (generation.status === 'APPLIED' && generation.targetModule === 'RISK_MAP');
  if (!open || generation.output === null) return { risks: false, sections: false };
  return {
    risks: (generation.output.risks?.length ?? 0) > 0 && (applied?.riskIds.length ?? 0) === 0,
    sections:
      documentId !== null &&
      generation.output.sections.length > 0 &&
      (applied?.sectionKeys.length ?? 0) === 0,
  };
}

function ProposalView({
  generation,
  generationId,
  stalled,
  discarding,
  timeZone,
  documentId,
  processId,
  targetModule,
  riskContext,
  userId,
  canApply,
  onDiscard,
  onRetry,
  onApplied,
  onRisksApplied,
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
  const parts = pendingParts(generation, documentId);
  const riskMapOpen = targetModule === 'RISK_MAP' && (parts.risks || parts.sections);
  if ((generation.status === 'SUCCEEDED' || riskMapOpen) && generation.output) {
    const owner = generation.requestedBy.id === userId;
    const header = (
      <>
        <h3 className="font-medium">{t('proposal.title')}</h3>
        {generation.expiresAt ? (
          <p className="text-xs text-muted-foreground">
            {t('proposal.expiresAt', { date: formatDateTime(generation.expiresAt, timeZone) })}
          </p>
        ) : null}
        {generation.output.warnings.map((warning, index) => {
          const input = missingInputOf(warning);
          return (
            <Alert
              // O mesmo código pode repetir com parâmetros diferentes (MISSING_OPTIONAL_INPUT).
              key={`${warning.code}-${String(index)}`}
              tone="warning"
              live={false}
              title={t(`warnings.${warning.code}`)}
            >
              {input === null ? null : t(`missingInput.${input}`)}
            </Alert>
          );
        })}
      </>
    );
    if (owner && canApply && targetModule === 'RISK_MAP') {
      return (
        <div className="flex flex-col gap-4">
          {header}
          {parts.risks && riskContext !== undefined ? (
            <AiRiskProposalList
              generation={generation}
              processId={processId}
              levelThresholds={riskContext.levelThresholds}
              existing={riskContext.existing}
              discarding={discarding}
              onDiscard={() => {
                onDiscard(generation);
              }}
              onApplied={onRisksApplied}
            />
          ) : null}
          {parts.sections && documentId !== null ? (
            <AiProposalSectionList
              generation={generation}
              documentId={documentId}
              discarding={discarding}
              onDiscard={() => {
                onDiscard(generation);
              }}
              onApplied={onApplied}
            />
          ) : null}
        </div>
      );
    }
    if (owner && canApply && documentId !== null) {
      return (
        <div className="flex flex-col gap-4">
          {header}
          <AiProposalSectionList
            generation={generation}
            documentId={documentId}
            discarding={discarding}
            onDiscard={() => {
              onDiscard(generation);
            }}
            onApplied={onApplied}
          />
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-4">
        {header}
        {owner ? null : <p className="text-sm text-muted-foreground">{t('proposal.readOnly')}</p>}
        {(generation.output.risks?.length ?? 0) > 0 ? (
          <ul aria-label={t('riskProposal.legend')} className="flex flex-col gap-2">
            {generation.output.risks?.map((risk) => (
              <li key={risk.proposalKey} className="rounded-md border border-border p-3 text-sm">
                <p className="font-medium break-words">{risk.title}</p>
                <p className="text-xs text-muted-foreground">
                  {t('riskProposal.treatmentsCount', { count: risk.treatments.length })}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
        <ul className="flex flex-col gap-3">
          {generation.output.sections.map((section) => (
            <li key={section.sectionKey} className="rounded-md border border-border p-3">
              <p className="font-medium">{section.title}</p>
              <p className="text-xs text-muted-foreground">
                {t('proposal.placeholders', { count: section.placeholdersCount })}
              </p>
              <p className="mt-2 text-sm break-words whitespace-pre-line">
                {previewText(section.content as Parameters<typeof previewText>[0])}
              </p>
            </li>
          ))}
        </ul>
        {owner ? (
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
        ) : null}
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
