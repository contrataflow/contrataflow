'use client';

import { Alert, Button, Skeleton, cx, toast } from '@contrataflow/ui';
import { processPanelTabOf } from '@contrataflow/validation';
import type {
  ActionEntry,
  ProcessPanelTab,
  ProcessSummaryDto,
  SummaryAction,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useShellSession } from '@/lib/session/session-context';

import { CancelSuggestionCallout } from './cancel-suggestion-callout';
import { ProcessActionBar } from './process-action-bar';
import { ProcessDataCard } from './process-data-card';
import { PROCESS_STATUS_HEADER_ID, ProcessDetailPage } from './process-header';
import {
  isStaleProcessError,
  panelRefetchInterval,
  useInvalidateProcess,
  useProcessStages,
  useProcessSummary,
} from './process-panel.api';
import { SituationalPanel } from './situational-panel';
import { StageStepper } from './stage-stepper';
import { AttachmentsSection } from '../attachments/attachments-section';
import { CommentsPanel } from '../comments/comments-panel';
import { ElaborateDfdButton } from '../dfd/elaborate-dfd';
import { CreateEtpButton } from '../etp/create-etp-dialog';
import { MovementTimeline } from '../movements/movement-timeline';
import { CreatePriceResearchButton } from '../price-research/create-price-research-dialog';
import { useAvailableActions } from '../process-actions/process-actions.api';
import { AssignProcessDialog } from '../process-assign/assign-process-dialog';
import {
  CancelProcessDialog,
  DiscardDraftDialog,
} from '../process-cancellation/cancellation-dialogs';
import { useClaimProcess } from '../process-claim/use-claim-process';
import { CompleteProcessDialog } from '../process-completion/complete-process-dialog';
import { ConfidentialBudgetToggle } from '../process-confidentiality/confidential-budget-toggle';
import { DocumentsPanel } from '../process-documents/documents-panel';
import { DuplicateProcessDialog } from '../process-duplicate/duplicate-process-dialog';
import { EditProcessSheet } from '../process-edit/edit-process-sheet';
import { ForwardPanel } from '../process-forward/forward-panel';
import { ProcessItemsTab } from '../process-items/process-items-tab';
import { FollowToggleButton } from '../process-participants/follow-toggle-button';
import { ParticipantsTab } from '../process-participants/participants-tab';
import { ReturnProcessDialog } from '../process-return/return-process-dialog';
import { SuspendedBanner } from '../process-suspension/suspended-banner';
import {
  ResumeProcessDialog,
  SuspendProcessDialog,
} from '../process-suspension/suspension-dialogs';
import { fetchProcess, processKeys } from '../processes/processes.api';
import { RisksLink } from '../risks/risks-link';
import { ProcessTagsButton, ProcessTagsDialog } from '../tags/process-tags';
import { CreateTermButton } from '../term/create-term-dialog';
import { TimelineFeed } from '../timeline/timeline-feed';

/** Contador da aba (RN-PROC-57): documentos, itens, comentários e participantes vêm do resumo. */
const COUNTED: Partial<Record<ProcessPanelTab, keyof ProcessSummaryDto['counts']>> = {
  documentos: 'documents',
  itens: 'items',
  comentarios: 'comments',
  participantes: 'participants',
};

/** Aba visível: `timeline` é uma das duas visões da aba "Tramitação". */
type VisibleTab = Exclude<ProcessPanelTab, 'timeline'>;

/** Abas na ordem da tela (repaginação — prd-4). */
const VISIBLE_TABS: readonly VisibleTab[] = [
  'resumo',
  'documentos',
  'tramitacao',
  'itens',
  'comentarios',
  'participantes',
  'anexos',
];

const visibleTabOf = (tab: ProcessPanelTab): VisibleTab =>
  tab === 'timeline' ? 'tramitacao' : tab;

const TAB =
  'relative -mb-px inline-flex min-h-11 flex-none items-center gap-2 px-3.5 text-sm whitespace-nowrap transition-colors';
const ACTIVE_TAB =
  'font-bold text-primary-soft-foreground shadow-[inset_0_-2px_0_var(--color-primary)]';
const IDLE_TAB = 'font-medium text-muted-foreground hover:text-foreground';

/**
 * `ProcessTabs` (RN-PROC-57 · V-06): aba ativa na URL (`?aba=`), quebram linha em vez de rolar (prd-5 · regra 8),
 * padrão WAI-ARIA (setas e Home/End movem o foco e ativam a aba). O contador vai num selo; o nome
 * acessível segue "Documentos (2)".
 */
function ProcessTabs({
  active,
  counts,
  onChange,
  idPrefix,
}: {
  readonly active: VisibleTab;
  readonly counts: ProcessSummaryDto['counts'];
  readonly onChange: (tab: VisibleTab) => void;
  readonly idPrefix: string;
}) {
  const t = useTranslations('processes.panel.tabs');
  const refs = useRef<Partial<Record<VisibleTab, HTMLButtonElement | null>>>({});
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = VISIBLE_TABS.indexOf(active);
    const last = VISIBLE_TABS.length - 1;
    const moves: Record<string, number> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const tab = VISIBLE_TABS[next] ?? 'resumo';
    onChange(tab);
    refs.current[tab]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={t('label')}
      className="flex flex-wrap gap-1 border-b border-border"
    >
      {VISIBLE_TABS.map((tab) => {
        const counted = COUNTED[tab];
        const count = counted === undefined ? 0 : counts[counted];
        const selected = active === tab;
        return (
          <button
            key={tab}
            ref={(element) => {
              refs.current[tab] = element;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${tab}`}
            tabIndex={selected ? 0 : -1}
            className={cx(TAB, selected ? ACTIVE_TAB : IDLE_TAB)}
            onKeyDown={onKeyDown}
            onClick={() => {
              onChange(tab);
            }}
          >
            {t(tab)}
            {count === 0 ? null : (
              <>
                {' '}
                <span className="sr-only">{`(${String(count)})`}</span>
                <span
                  aria-hidden="true"
                  className={cx(
                    'rounded-full px-2 py-px text-xs font-bold',
                    selected
                      ? 'bg-primary-soft text-primary-soft-foreground'
                      : 'bg-neutral-soft text-neutral-soft-foreground',
                  )}
                >
                  {count}
                </span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Aba "Tramitação": o histórico de tramitações (US-054 · `?aba=tramitacao`) e a linha do tempo de
 * todos os eventos (US-060 · `?aba=timeline`), alternados por um seletor de visão.
 */
function MovementsTab({
  processId,
  view,
  onChange,
}: {
  readonly processId: string;
  readonly view: 'tramitacao' | 'timeline';
  readonly onChange: (view: 'tramitacao' | 'timeline') => void;
}) {
  const t = useTranslations('processes.panel.tabs.views');
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div
        role="group"
        aria-label={t('label')}
        className="inline-flex max-w-full flex-wrap self-start rounded-control border border-border bg-surface p-1"
      >
        {(['tramitacao', 'timeline'] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={view === option}
            className={cx(
              'min-h-9 rounded-[0.5rem] px-3 text-sm whitespace-nowrap transition-colors',
              view === option
                ? 'bg-primary-soft font-bold text-primary-soft-foreground'
                : 'font-medium text-muted-foreground hover:text-foreground',
            )}
            onClick={() => {
              onChange(option);
            }}
          >
            {t(option)}
          </button>
        ))}
      </div>
      {view === 'timeline' ? (
        // US-060: linha do tempo de todos os eventos (PRC-12).
        <TimelineFeed processId={processId} />
      ) : (
        // US-054: histórico de tramitações (PRC-11).
        <MovementTimeline processId={processId} />
      )}
    </div>
  );
}

/** Primeira carga: skeleton por bloco (o painel aparece progressivamente — DEC-181). */
function PanelSkeleton() {
  const t = useTranslations('processes.panel');
  return (
    <div role="status" className="mx-auto flex w-full max-w-7xl flex-col gap-4">
      <span className="sr-only">{t('loading')}</span>
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-9 w-[32rem] max-w-full" />
      <Skeleton className="h-6 w-64 max-w-full" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-11 w-full" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col gap-6">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-36" />
          ))}
        </div>
        <div className="flex flex-col gap-4">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-28" />
          ))}
        </div>
      </div>
    </div>
  );
}

/** FA-01 (404 → "não encontrado ou sem acesso") e banco fora sem cache (503 · "Falha de banco"). */
function PanelFailure({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('processes.panel.errors');
  if (isApiError(error) && error.status === 404) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
        <Alert tone="error" title={t('notFound')}>
          <Link href="/processos" className="text-sm text-primary underline">
            {t('backToList')}
          </Link>
        </Alert>
      </div>
    );
  }
  const correlationId = isApiError(error) ? (error.correlationId ?? '—') : '—';
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      <Alert
        tone="error"
        title={isApiError(error) && error.status === 429 ? t('rateLimited') : t('unavailable')}
      >
        <p className="text-sm">{t('code', { correlationId })}</p>
        <Button size="sm" variant="secondary" className="mt-3" onClick={onRetry}>
          {t('retry')}
        </Button>
      </Alert>
    </div>
  );
}

/**
 * FA-11: comando das stories donas recusado por dado desatualizado (409 `STAGE_CHANGED`, 412
 * `VERSION_CONFLICT`, 403 `NOT_PROCESS_CUSTODIAN`) — avisa e recarrega o painel. `recover` devolve
 * se tratou o erro (o diálogo da story dona decide o resto).
 */
export function useStaleProcessRecovery(processId: string) {
  const invalidate = useInvalidateProcess(processId);
  const [conflict, setConflict] = useState(false);
  const recover = useCallback(
    (error: unknown): boolean => {
      if (!isStaleProcessError(error)) return false;
      setConflict(true);
      void invalidate();
      return true;
    },
    [invalidate],
  );
  return {
    conflict,
    recover,
    dismiss: () => {
      setConflict(false);
    },
  };
}

/**
 * SCR-006 — Detalhe do processo (US-004) no modelo `DetailPage` (prd-5): faixa de cabeçalho com
 * "Seguir" e a barra de ações (ação primária + "Mais"), cartão com a barra de etapas e os fatos, painel situacional com as 7 perguntas (PRC-07) e as abas Resumo, Documentos,
 * Itens, Tramitação, Timeline, Comentários e Participantes (`?aba=`). PRC-04/07/08/10 em paralelo;
 * cada bloco falha sozinho; banco fora com dados em cache mostra o aviso e desabilita as ações.
 */
export function ProcessPanel({ processId }: { readonly processId: string }) {
  const t = useTranslations('processes.panel');
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const timeZone = session.activeTenant.timezone;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tabsId = useId();
  const tab = processPanelTabOf(searchParams.get('aba'));
  const summary = useProcessSummary(processId);
  const stages = useProcessStages(processId);
  const actions = useAvailableActions(processId);
  const detail = useQuery({
    queryKey: processKeys.detail(tenantId, processId),
    queryFn: ({ signal }) => fetchProcess(processId, signal),
    refetchOnWindowFocus: true,
    refetchInterval: panelRefetchInterval,
    throwOnError: false,
  });
  const stale = useStaleProcessRecovery(processId);
  const [editing, setEditing] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [tagging, setTagging] = useState(false);
  // US-047: "Encaminhar" abre o painel SCR-103 já na transição da ação (`transitionKey`).
  const [forwarding, setForwarding] = useState(false);
  const [forwardKey, setForwardKey] = useState<string | null>(null);
  // US-048: "Devolver" abre o diálogo SCR-104 já com a etapa da ação escolhida.
  const [returning, setReturning] = useState(false);
  const [returnStageId, setReturnStageId] = useState<string | null>(null);
  // US-049: "Assumir" é ação direta (PRC-21), sem diálogo.
  const claiming = useClaimProcess(processId);
  // US-050: "Atribuir"/"Reatribuir" abre o diálogo SCR-115 (PRC-22).
  const [assigning, setAssigning] = useState(false);
  // US-008: "Suspender" (menu "Mais") e "Retomar" (ação primária do suspenso) abrem o SCR-116.
  const [suspending, setSuspending] = useState(false);
  const [resuming, setResuming] = useState(false);
  // US-009: "Cancelar processo" e "Descartar rascunho" (menu "Mais") abrem o SCR-116.
  const [canceling, setCanceling] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  // US-010: "Concluir processo" (ação primária com a transição COMPLETE ou na etapa END) abre o SCR-116.
  const [completing, setCompleting] = useState(false);

  const changeTab = (next: ProcessPanelTab) => {
    router.replace(next === 'resumo' ? pathname : `${pathname}?aba=${next}`, { scroll: false });
  };

  if (summary.data === undefined) {
    if (summary.isPending) return <PanelSkeleton />;
    return (
      <PanelFailure
        error={summary.error}
        onRetry={() => {
          void summary.refetch();
        }}
      />
    );
  }

  const data = summary.data;
  const frozen = summary.isError;
  const updatedAt = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short', timeZone }).format(
    new Date(summary.dataUpdatedAt),
  );

  const onAction = (action: SummaryAction | ActionEntry) => {
    // US-005: "Editar dados" abre o painel lateral; as demais ações, os diálogos das stories donas.
    if (action.action === 'EDIT') setEditing(true);
    // US-006: "Gerenciar itens" leva à aba Itens.
    else if (action.action === 'MANAGE_ITEMS') changeTab('itens');
    // US-007: "Etiquetas" abre o seletor.
    else if (action.action === 'MANAGE_TAGS') setTagging(true);
    // US-011: "Duplicar processo" abre o diálogo SCR-113.
    else if (action.action === 'DUPLICATE') setDuplicating(true);
    // US-047: "Encaminhar" abre o painel lateral SCR-103.
    else if (action.action === 'FORWARD') {
      setForwardKey(action.transitionKey ?? null);
      setForwarding(true);
    }
    // US-049: "Assumir" chama o PRC-21 direto, com a versão do PRC-04 no `If-Match`.
    else if (action.action === 'CLAIM') void claiming.claim(detail.data?.version);
    // US-050: "Atribuir responsável" abre o diálogo SCR-115.
    else if (action.action === 'ASSIGN') setAssigning(true);
    // US-048: "Devolver" abre o diálogo SCR-104.
    else if (action.action === 'RETURN') {
      setReturnStageId('toStageId' in action ? (action.toStageId ?? null) : null);
      setReturning(true);
    }
    // US-008: "Suspender"/"Retomar" abrem os diálogos SCR-116.
    else if (action.action === 'SUSPEND') setSuspending(true);
    else if (action.action === 'RESUME') setResuming(true);
    // US-009: "Cancelar processo"/"Descartar rascunho" abrem os diálogos SCR-116.
    else if (action.action === 'CANCEL') setCanceling(true);
    else if (action.action === 'DISCARD') setDiscarding(true);
    // US-010: "Concluir processo" abre o diálogo SCR-116 com o checklist da etapa.
    else if (action.action === 'COMPLETE') setCompleting(true);
    else toast({ title: t('actions.notYet') });
  };

  let content: ReactNode;
  if (tab === 'resumo') {
    content = (
      <SituationalPanel
        summary={data}
        processId={processId}
        timeZone={timeZone}
        onOpenDocuments={() => {
          changeTab('documentos');
        }}
        nextStepActions={
          <>
            {/* US-014: "Elaborar DFD" quando o DOC-01 libera o tipo DFD (fluxo principal 1). */}
            <ElaborateDfdButton processId={processId} />
            {/* US-019: "Criar ETP" / "Abrir ETP {código}" (DOC-01 + ETP-01). */}
            <CreateEtpButton processId={processId} />
            {/* US-024: "Criar pesquisa de preços" / "Abrir pesquisa {código}" (DOC-01 + PRS-01). */}
            <CreatePriceResearchButton processId={processId} />
            {/* US-036: "Criar Termo de Referência" / "Abrir TR {código}" (DOC-01 + TRM-01). */}
            <CreateTermButton processId={processId} />
            {/* US-033: acesso à tela de riscos (SCR-011). */}
            <RisksLink processId={processId} />
          </>
        }
        aside={
          <ProcessDataCard query={detail} timeZone={timeZone}>
            {/* US-013: "Orçamento sigiloso" (PRC-33) com o estado e a versão do PRC-04. */}
            <ConfidentialBudgetToggle processId={processId} process={detail.data} frozen={frozen} />
          </ProcessDataCard>
        }
      />
    );
  } else if (tab === 'timeline' || tab === 'tramitacao') {
    content = <MovementsTab processId={processId} view={tab} onChange={changeTab} />;
  } else if (tab === 'documentos') {
    // US-062: documentos agrupados por tipo e o menu "Criar documento" (DOC-01 + DTY-01).
    content = <DocumentsPanel processId={processId} />;
  } else if (tab === 'itens') {
    // US-006: lista canônica de itens (PRC-13..17).
    content = <ProcessItemsTab processId={processId} />;
  } else if (tab === 'comentarios') {
    // US-071: comentários do processo e dos documentos (CMT-01..04).
    content = (
      <CommentsPanel processId={processId} highlightedId={searchParams.get('comentario')} />
    );
  } else if (tab === 'participantes') {
    // US-012: participantes (PRC-28..30 — SCR-112).
    content = <ParticipantsTab processId={processId} />;
  } else {
    // US-068/US-069: anexos do processo (alvo `PROCESS`) — envio, lista, prévia e download.
    content = (
      <AttachmentsSection targetType="PROCESS" targetId={processId} processId={processId} />
    );
  }
  const visibleTab = visibleTabOf(tab);

  return (
    <div className="mx-auto flex w-full max-w-7xl min-w-0 flex-col pb-24 md:pb-0">
      <ProcessDetailPage
        summary={data}
        actions={
          <>
            {/* US-012 · DEC-180: "Seguir"/"Seguindo" ao lado das ações. */}
            <FollowToggleButton processId={processId} />
            <ProcessActionBar
              summary={data}
              actions={actions.data}
              frozen={frozen || claiming.isPending}
              onAction={onAction}
            />
          </>
        }
        tagsAction={
          // US-007: "Etiquetas" (PRC-08 `MANAGE_TAGS`) abre o seletor; PRC-18 grava o conjunto.
          <ProcessTagsButton
            entry={actions.data?.find((entry) => entry.action === 'MANAGE_TAGS')}
            count={data.header.tags.length}
            frozen={frozen}
            onClick={() => {
              setTagging(true);
            }}
          />
        }
        progress={
          <StageStepper
            stages={stages.data}
            isPending={stages.isPending}
            error={stages.error}
            onRetry={() => {
              void stages.refetch();
            }}
            timeZone={timeZone}
          />
        }
        notices={
          <>
            {frozen ? (
              <Alert tone="warning" title={t('actions.stale', { time: updatedAt })}>
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-2"
                  onClick={() => {
                    void summary.refetch();
                  }}
                >
                  {t('errors.retry')}
                </Button>
              </Alert>
            ) : null}
            {stale.conflict ? <Alert tone="info" title={t('actions.conflict')} /> : null}
            <SuspendedBanner where={data.where} timeZone={timeZone} />
            {/* US-017 · RN-DFD-68: DFD indeferido — sugestão de cancelamento (PEND-02). */}
            <CancelSuggestionCallout summary={data} />
          </>
        }
        tabs={
          <ProcessTabs
            active={visibleTab}
            counts={data.counts}
            onChange={changeTab}
            idPrefix={tabsId}
          />
        }
      >
        <div
          role="tabpanel"
          id={`${tabsId}-panel-${visibleTab}`}
          aria-labelledby={`${tabsId}-tab-${visibleTab}`}
          className="min-w-0"
        >
          {content}
        </div>
      </ProcessDetailPage>
      <EditProcessSheet processId={processId} open={editing} onOpenChange={setEditing} />
      <ForwardPanel
        processId={processId}
        open={forwarding}
        onOpenChange={setForwarding}
        initialTransitionKey={forwardKey}
        onForwarded={() => {
          // Foco ao cabeçalho de status (já sem as ações de custódia), não ao botão que abriu o painel.
          document.getElementById(PROCESS_STATUS_HEADER_ID)?.focus();
        }}
      />
      <ReturnProcessDialog
        processId={processId}
        open={returning}
        onOpenChange={setReturning}
        initialStageId={returnStageId}
        onReturned={() => {
          // Quem devolveu perde a custódia: foco ao cabeçalho de status, como no encaminhamento.
          document.getElementById(PROCESS_STATUS_HEADER_ID)?.focus();
        }}
      />
      <AssignProcessDialog
        processId={processId}
        open={assigning}
        onOpenChange={setAssigning}
        onDone={() => {
          document.getElementById(PROCESS_STATUS_HEADER_ID)?.focus();
        }}
      />
      <SuspendProcessDialog
        processId={processId}
        open={suspending}
        onOpenChange={setSuspending}
        onDone={() => {
          document.getElementById(PROCESS_STATUS_HEADER_ID)?.focus();
        }}
      />
      <ResumeProcessDialog
        processId={processId}
        open={resuming}
        onOpenChange={setResuming}
        summary={data}
        onReviewTargetDate={() => {
          setEditing(true);
        }}
        onDone={() => {
          document.getElementById(PROCESS_STATUS_HEADER_ID)?.focus();
        }}
      />
      <CancelProcessDialog
        processId={processId}
        open={canceling}
        onOpenChange={setCanceling}
        summary={data}
      />
      <DiscardDraftDialog
        processId={processId}
        open={discarding}
        onOpenChange={setDiscarding}
        onCancelInstead={() => {
          setCanceling(true);
        }}
      />
      <CompleteProcessDialog
        processId={processId}
        open={completing}
        onOpenChange={setCompleting}
        onDone={() => {
          // Concluído: as ações de custódia somem; foco ao cabeçalho de status (selo "Concluído").
          document.getElementById(PROCESS_STATUS_HEADER_ID)?.focus();
        }}
      />
      <ProcessTagsDialog
        processId={processId}
        open={tagging}
        onOpenChange={setTagging}
        applied={data.header.tags}
        version={detail.data?.version}
      />
      <DuplicateProcessDialog
        processId={processId}
        open={duplicating}
        onOpenChange={setDuplicating}
      />
    </div>
  );
}
