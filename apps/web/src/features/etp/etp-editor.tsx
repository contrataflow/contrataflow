'use client';

import {
  Alert,
  ArrowLeft,
  ArrowRight,
  AutosaveIndicator,
  Button,
  Circle,
  CircleAlert,
  CircleCheck,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ConflictDialog,
  cx,
  Field,
  FormActionBar,
  Minus,
  RecoveredDraftBanner,
  Skeleton,
  Textarea,
} from '@contrataflow/ui';
import type { IconComponent } from '@contrataflow/ui';
import {
  etpCompletionSummary,
  etpSectionHasNarrative,
  etpSectionNav,
  etpStructuredKind,
  notApplicableJustificationMessage,
  notApplicableJustificationProblem,
  richTextPlainText,
} from '@contrataflow/validation';
import type {
  EtpDetailDto,
  EtpDetailMeta,
  EtpSectionNavItem,
  EtpTemplateSectionDto,
  SectionState,
  Violation,
} from '@contrataflow/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';

import { useShellSession } from '@/lib/session/session-context';

import type { PendingTarget } from './etp-conclusion-model';
import { EtpConclusionFieldset, EtpPendingSummary } from './etp-conclusion-section';
import { canEditEtp, draftState, EMPTY_SECTION_DRAFT, sectionDraftOf } from './etp-editor-model';
import type { EtpSectionDraft } from './etp-editor-model';
import { StructuredSectionContent } from './etp-structured-sections';
import { useEtp } from './etp.api';
import { useEtpAutosave } from './use-etp-autosave';
import { AiAssistant } from '../ai/ai-assistant';
import { AiSectionMenu } from '../ai/ai-section-assistant';
import type { AiSectionChange } from '../ai/ai-section-assistant';
import { documentKeys, fetchDocumentValidation } from '../documents/documents.api';

/*
 * `EtpEditor` (SCR-008 · US-020): o ETP seção por seção. `SectionSidebarNav` com o estado de cada
 * seção (vazia, preenchida, não se aplica) e as pendências não bloqueantes do DOC-08 (RN-ETP-13);
 * a seção ativa com o texto (autosave de 1,5 s e na perda de foco — RN-ETP-10), o controle "Não se
 * aplica" com justificativa (RN-ETP-11) e, nas seções estruturadas, o quadro somente leitura do
 * módulo dono (RN-ETP-12). Somente leitura sem `UPDATE` ou fora de `DRAFT`/`RETURNED` (FA-05).
 * Abaixo de 768 px a navegação recolhe para o menu "Seções". US-023: a conclusão e o parcelamento
 * (ETP-04) e o resumo "Pendências para concluir" (DOC-08) acima das seções — cada pendência leva à
 * seção, ao quadro ou ao campo; o "Concluir ETP" é a ação FINALIZE do ciclo de vida do documento.
 */

/** Id da seção ativa (destino do foco vindo de "Pendências para concluir"). */
const ACTIVE_SECTION_ID = 'etp-active-section';

function timeOf(value: string | number, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone }).format(
    new Date(value),
  );
}

const STATE_ICON: Readonly<Record<SectionState, { Icon: IconComponent; className: string }>> = {
  EMPTY: { Icon: Circle, className: 'text-muted-foreground' },
  FILLED: { Icon: CircleCheck, className: 'text-success' },
  NOT_APPLICABLE: { Icon: Minus, className: 'text-muted-foreground' },
};

export function EtpEditor({
  processId,
  etpId,
  aiGenerationId = null,
}: {
  readonly processId: string;
  readonly etpId: string;
  /** `?ia=<generationId>`: abre o assistente de IA na geração (US-118 · SCR-117). */
  readonly aiGenerationId?: string | null | undefined;
}) {
  const t = useTranslations('etp.editor');
  const query = useEtp(etpId);
  if (query.data === undefined) {
    if (query.isPending) {
      return (
        <div role="status" className="flex flex-col gap-3">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-40 w-full" />
        </div>
      );
    }
    // O cabeçalho do documento (DocumentView) já mostra o 404/erro; aqui só a nova tentativa.
    return (
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            void query.refetch();
          }}
        >
          {t('retry')}
        </Button>
      </div>
    );
  }
  return (
    <EtpEditorLoaded
      key={query.data.etp.documentId}
      processId={processId}
      etp={query.data.etp}
      meta={query.data.meta}
      aiGenerationId={aiGenerationId}
    />
  );
}

export interface EtpEditorLoadedProps {
  readonly processId: string;
  readonly etp: EtpDetailDto;
  readonly meta: EtpDetailMeta;
  readonly aiGenerationId?: string | null | undefined;
}

export function EtpEditorLoaded({
  processId,
  etp,
  meta,
  aiGenerationId = null,
}: EtpEditorLoadedProps) {
  const t = useTranslations('etp.editor');
  const session = useShellSession();
  const timeZone = session.activeTenant.timezone;
  const sections = meta.template?.sections ?? [];
  const allowed = canEditEtp(etp.status, meta.allowedActions);

  const [drafts, setDrafts] = useState<Record<string, EtpSectionDraft>>(() =>
    Object.fromEntries(
      Object.entries(etp.draftContent.sections).map(([key, section]) => [
        key,
        sectionDraftOf(section),
      ]),
    ),
  );
  const [states, setStates] = useState<Record<string, SectionState>>(() =>
    Object.fromEntries(
      Object.entries(etp.draftContent.sections).map(([key, section]) => [key, section.state]),
    ),
  );
  const [activeKey, setActiveKey] = useState<string>(() => sections[0]?.key ?? '');
  const autosave = useEtpAutosave({
    etp,
    tenantId: session.activeTenant.id,
    userId: session.user.id,
    enabled: allowed,
    onSection: (key, draft) => {
      setDrafts((previous) => ({ ...previous, [key]: draft }));
    },
    onSaved: (saved) => {
      setStates((previous) => ({ ...previous, [saved.sectionKey]: saved.state }));
    },
  });
  const editable = allowed && autosave.blocked === null;

  // RN-ETP-13: as pendências do DOC-08 informam a navegação, sem bloquear nada.
  const validation = useQuery({
    queryKey: documentKeys.validation(session.activeTenant.id, etp.documentId),
    queryFn: ({ signal }) => fetchDocumentValidation(etp.documentId, signal),
    throwOnError: false,
  });
  const violations: readonly Violation[] = validation.data?.violations ?? [];
  // US-023: o cabeçalho mudou (conclusão, alternativa recomendada, valor) → pendências de novo.
  const queryClient = useQueryClient();
  const tenantId = session.activeTenant.id;
  const etpVersion = useRef(etp.version);
  useEffect(() => {
    if (etpVersion.current === etp.version) return;
    etpVersion.current = etp.version;
    void queryClient.invalidateQueries({
      queryKey: documentKeys.validation(tenantId, etp.documentId),
    });
  }, [etp.version, etp.documentId, tenantId, queryClient]);
  const conclusionRef = useRef<HTMLFieldSetElement>(null);
  const goToSection = (key: string) => {
    void autosave.flush();
    setActiveKey(key);
    setTimeout(() => {
      document.getElementById(ACTIVE_SECTION_ID)?.focus();
    }, 0);
  };
  const navigate = (target: Exclude<PendingTarget, { kind: 'none' }>) => {
    if (target.kind === 'conclusion') {
      conclusionRef.current?.querySelector<HTMLElement>(`[data-field="${target.field}"]`)?.focus();
      return;
    }
    goToSection(target.key);
  };
  const nav = etpSectionNav(sections, { sections: {} }, violations).map((item) => ({
    ...item,
    state: states[item.key] ?? 'EMPTY',
  }));
  const summary = etpCompletionSummary(nav);
  const active = sections.find((section) => section.key === activeKey) ?? sections[0];
  const activeItem = nav.find((item) => item.key === active?.key);
  const activeIndex = sections.findIndex((section) => section.key === active?.key);
  const previousSection = activeIndex > 0 ? sections[activeIndex - 1] : undefined;
  const nextSection = activeIndex >= 0 ? sections[activeIndex + 1] : undefined;

  const change = (key: string, draft: EtpSectionDraft) => {
    setDrafts((previous) => ({ ...previous, [key]: draft }));
    autosave.change(key, draft);
  };
  const commit = async (key: string, draft: EtpSectionDraft) => {
    setDrafts((previous) => ({ ...previous, [key]: draft }));
    await autosave.commit(key, draft);
  };

  const [busy, setBusy] = useState(false);
  const run = (work: () => Promise<void>) => {
    setBusy(true);
    void work().finally(() => {
      setBusy(false);
    });
  };
  const { conflict, recovered, blocked } = autosave;
  const conflictSection = sections.find((section) => section.key === conflict?.key);

  return (
    <section aria-labelledby="etp-editor-title" className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id="etp-editor-title" className="text-section-title text-brand-ink">
          {t('sectionsNav')}
        </h2>
        <span className="text-sm text-muted-foreground">
          {t('summary', {
            done: summary.filled + summary.notApplicable,
            total: summary.total,
          })}
          {summary.pending > 0 ? ` · ${t('pendingCount', { count: summary.pending })}` : ''}
        </span>
        {/* US-118: rascunho do ETP com IA (SCR-117) — aplicado pelo DOC-26, adotado pelo autosave. */}
        <div className="ml-auto">
          <AiAssistant
            processId={processId}
            documentId={etp.documentId}
            targetModule="ETP"
            editable={etp.status === 'DRAFT' || etp.status === 'RETURNED'}
            initialGenerationId={aiGenerationId}
            onApplied={(document) => {
              setStates((previous) => ({
                ...previous,
                ...Object.fromEntries(
                  Object.entries(document.draftContent.sections).map(([key, section]) => [
                    key,
                    section.state,
                  ]),
                ),
              }));
              void autosave.adoptSections(document);
            }}
          />
        </div>
      </div>

      {allowed ? null : (
        <Alert tone="info" live={false} title={t('readOnly.title')}>
          <p>
            {etp.status === 'DRAFT' || etp.status === 'RETURNED'
              ? t('readOnly.forbidden')
              : t('readOnly.notEditable')}
          </p>
        </Alert>
      )}
      {blocked === null ? null : (
        <Alert tone="warning" title={t(blockedKey(blocked.code))}>
          <p>{t('autosave.blocked.kept')}</p>
        </Alert>
      )}
      {recovered === null || blocked !== null ? null : (
        <RecoveredDraftBanner
          time={timeOf(recovered.savedAt, timeZone)}
          busy={busy}
          labels={{
            title: (time) => t('autosave.recovered.title', { time }),
            restore: t('autosave.recovered.restore'),
            discard: t('autosave.recovered.discard'),
          }}
          onRestore={() => {
            run(() => autosave.restore());
          }}
          onDiscard={() => {
            run(() => autosave.discardRecovered());
          }}
        />
      )}

      <EtpPendingSummary
        violations={violations}
        loaded={validation.data !== undefined}
        sections={sections}
        onNavigate={navigate}
      />

      <div className="flex min-w-0 flex-col gap-5 md:flex-row md:items-start">
        <SectionSidebarNav
          items={nav}
          activeKey={active?.key ?? ''}
          onSelect={(key) => {
            void autosave.flush();
            setActiveKey(key);
          }}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-5">
          {active === undefined ? null : (
            <EtpSectionPanel
              key={active.key}
              processId={processId}
              documentId={etp.documentId}
              section={active}
              item={activeItem}
              draft={drafts[active.key] ?? EMPTY_SECTION_DRAFT}
              editable={editable}
              onChange={(draft) => {
                change(active.key, draft);
              }}
              onCommit={(draft) => commit(active.key, draft)}
              onBlur={() => {
                if (editable) void autosave.flush();
              }}
              onAiChange={(aiChange) => {
                setStates((previous) => ({ ...previous, [aiChange.key]: aiChange.state }));
                void autosave.adopt(aiChange.key, aiChange);
              }}
            />
          )}
          <EtpConclusionFieldset ref={conclusionRef} etp={etp} editable={allowed} />
        </div>
      </div>

      <FormActionBar
        label={t('actions.label')}
        status={
          allowed ? (
            <AutosaveIndicator
              status={autosave.snapshot.status}
              savedAt={autosave.snapshot.savedAt}
              message={autosave.snapshot.message}
              labels={{
                dirty: t('autosave.indicator.dirty'),
                saving: t('autosave.indicator.saving'),
                saved: (time) => t('autosave.indicator.saved', { time }),
                savedShort: t('autosave.indicator.savedShort'),
                error: t('autosave.indicator.error'),
                offline: t('autosave.indicator.offline'),
                offlineShort: t('autosave.indicator.offlineShort'),
                conflict: t('autosave.indicator.conflict'),
                blocked: t('autosave.indicator.blocked'),
              }}
            />
          ) : undefined
        }
      >
        <Button
          variant="secondary"
          disabled={previousSection === undefined}
          onClick={() => {
            if (previousSection !== undefined) goToSection(previousSection.key);
          }}
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t('actions.previous')}
        </Button>
        <Button
          disabled={nextSection === undefined}
          onClick={() => {
            if (nextSection !== undefined) goToSection(nextSection.key);
          }}
        >
          {t('actions.next')}
          <ArrowRight aria-hidden="true" className="size-4" />
        </Button>
      </FormActionBar>

      {conflict === null ? null : (
        <ConflictDialog
          open
          busy={busy}
          authorName={conflict.current.updatedBy?.name ?? t('autosave.conflict.someone')}
          isSelf={conflict.current.updatedBy?.id === session.user.id}
          time={timeOf(conflict.current.updatedAt, timeZone)}
          sectionTitle={conflictSection?.title ?? conflict.key}
          serverText={
            conflict.current.state === 'NOT_APPLICABLE'
              ? (conflict.current.justification ?? '')
              : conflict.current.content
                ? richTextPlainText(conflict.current.content)
                : ''
          }
          localText={localTextOf(drafts[conflict.key])}
          labels={{
            title: t('autosave.conflict.title'),
            changedBy: (name: string, time: string) =>
              t('autosave.conflict.changedBy', { name, time }),
            changedBySelf: (time: string) => t('autosave.conflict.changedBySelf', { time }),
            description: t('autosave.conflict.description'),
            showDiff: t('autosave.conflict.showDiff'),
            hideDiff: t('autosave.conflict.hideDiff'),
            keepMine: t('autosave.conflict.keepMine'),
            discardMine: t('autosave.conflict.discardMine'),
            serverColumn: t('autosave.conflict.serverColumn'),
            mineColumn: t('autosave.conflict.mineColumn'),
            inserted: t('autosave.conflict.inserted'),
            removed: t('autosave.conflict.removed'),
            empty: t('autosave.conflict.empty'),
          }}
          onKeepMine={() => {
            run(() => autosave.keepMine(drafts[conflict.key] ?? EMPTY_SECTION_DRAFT));
          }}
          onDiscardMine={() => {
            run(() => autosave.discardMine());
          }}
        />
      )}
    </section>
  );
}

const localTextOf = (draft: EtpSectionDraft | undefined) =>
  draft === undefined ? '' : draft.notApplicable ? draft.justification : draft.text;

function blockedKey(code: string) {
  switch (code) {
    case 'DOCUMENT_NOT_EDITABLE':
      return 'autosave.blocked.notEditable' as const;
    case 'NOT_PROCESS_CUSTODIAN':
    case 'PERMISSION_DENIED':
    case 'NOT_FOUND':
      return 'autosave.blocked.forbidden' as const;
    case 'SESSION_EXPIRED':
      return 'autosave.blocked.sessionExpired' as const;
    default:
      return 'autosave.blocked.generic' as const;
  }
}

// --- Navegação lateral ---------------------------------------------------------------------------

export function SectionSidebarNav({
  items,
  activeKey,
  onSelect,
}: {
  readonly items: readonly EtpSectionNavItem[];
  readonly activeKey: string;
  readonly onSelect: (key: string) => void;
}) {
  const t = useTranslations('etp.editor');
  const [open, setOpen] = useState(false);
  const list = (
    <ol className="flex flex-col gap-1">
      {items.map((item, index) => {
        const current = item.key === activeKey;
        const { Icon, className } = STATE_ICON[item.state];
        return (
          <li key={item.key}>
            <button
              type="button"
              aria-current={current ? 'true' : undefined}
              data-state={item.state}
              className={cx(
                'flex w-full items-start gap-2 rounded-control px-2 py-1.5 text-left text-sm',
                current ? 'bg-primary-soft font-medium text-primary' : 'hover:bg-muted',
              )}
              onClick={() => {
                setOpen(false);
                onSelect(item.key);
              }}
            >
              <Icon aria-hidden="true" className={cx('mt-0.5 size-4 shrink-0', className)} />
              <span className="min-w-0 flex-1 break-words">
                {index + 1}. {item.title}
                <span className="sr-only">
                  {`, ${t(`state.${item.state}`)}`}
                  {item.issues.length > 0 ? `, ${t('pending')}` : ''}
                </span>
              </span>
              {item.issues.length > 0 ? (
                <CircleAlert
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-warning"
                  data-pending="true"
                />
              ) : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
  return (
    <>
      <div className="md:hidden">
        <Button
          size="sm"
          variant="secondary"
          aria-expanded={open}
          aria-controls="etp-sections-menu"
          onClick={() => {
            setOpen((value) => !value);
          }}
        >
          {t('sectionsMenu')}
        </Button>
        {open ? (
          <nav id="etp-sections-menu" aria-label={t('sectionsNav')} className="mt-2">
            {list}
          </nav>
        ) : null}
      </div>
      <nav
        aria-label={t('sectionsNav')}
        className="hidden w-64 shrink-0 md:sticky md:top-4 md:block md:self-start"
      >
        {list}
      </nav>
    </>
  );
}

// --- Seção ativa ---------------------------------------------------------------------------------

interface EtpSectionPanelProps {
  readonly processId: string;
  readonly documentId: string;
  readonly section: EtpTemplateSectionDto;
  readonly item: EtpSectionNavItem | undefined;
  readonly draft: EtpSectionDraft;
  readonly editable: boolean;
  readonly onChange: (draft: EtpSectionDraft) => void;
  readonly onCommit: (draft: EtpSectionDraft) => Promise<void>;
  readonly onBlur: () => void;
  /** US-121: seção ajustada com IA (aplicação ou "Desfazer") — o editor adota a do servidor. */
  readonly onAiChange: (change: AiSectionChange) => void;
}

function EtpSectionPanel({
  processId,
  documentId,
  section,
  item,
  draft,
  editable,
  onChange,
  onCommit,
  onBlur,
  onAiChange,
}: EtpSectionPanelProps) {
  const t = useTranslations('etp.editor');
  const id = useId();
  const textId = `etp-section-${section.key}`;
  const kind = etpStructuredKind(section);
  const narrative = etpSectionHasNarrative(section);
  const issues = item?.issues ?? [];
  return (
    <article
      id={ACTIVE_SECTION_ID}
      tabIndex={-1}
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 flex-col gap-4 rounded-card bg-surface p-6 shadow-card"
    >
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 id={`${id}-title`} className="text-section-title break-words text-brand-ink">
            {section.title}
          </h3>
          <AiSectionMenu
            processId={processId}
            documentId={documentId}
            targetModule="ETP"
            section={section}
            state={draftState(draft)}
            text={draft.text}
            editable={editable}
            onSectionChanged={onAiChange}
          />
        </div>
        <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{t(`requirement.${section.requirement}`)}</span>
          <span>· {t(`state.${item?.state ?? 'EMPTY'}`)}</span>
          {section.legalBasis ? (
            <span>· {t('legalBasis', { basis: section.legalBasis })}</span>
          ) : null}
        </div>
      </header>
      {section.helpText ? (
        <Collapsible className="flex flex-col gap-1">
          <CollapsibleTrigger className="self-start">{t('help')}</CollapsibleTrigger>
          <CollapsibleContent>
            <p className="text-sm text-muted-foreground">{section.helpText}</p>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      {issues.length > 0 ? (
        <div role="note" aria-label={t('issuesTitle')} className="text-sm text-warning">
          <ul className="list-disc pl-5">
            {issues.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {draft.notApplicable ? (
        <NotApplicableSummary
          draft={draft}
          editable={editable}
          onRevert={() => onCommit({ text: '', notApplicable: false, justification: '' })}
        />
      ) : (
        <>
          {kind === null ? null : (
            <StructuredSectionContent
              kind={kind}
              processId={processId}
              documentId={documentId}
              editable={editable}
            />
          )}
          {narrative ? (
            <Field
              id={textId}
              label={t(kind === null ? 'textLabel' : 'narrativeLabel', { title: section.title })}
              description={t('maxChars', { max: section.maxChars.toLocaleString('pt-BR') })}
            >
              <Textarea
                rows={8}
                className="min-h-48"
                maxLength={section.maxChars}
                value={draft.text}
                readOnly={!editable}
                onChange={(event) => {
                  onChange({ ...draft, text: event.target.value });
                }}
                onBlur={onBlur}
              />
            </Field>
          ) : null}
          {editable ? (
            <NotApplicableToggle
              sectionKey={section.key}
              required={section.requirement === 'REQUIRED'}
              onConfirm={(justification) =>
                onCommit({ text: draft.text, notApplicable: true, justification })
              }
            />
          ) : null}
        </>
      )}
    </article>
  );
}

export function NotApplicableSummary({
  draft,
  editable,
  onRevert,
}: {
  readonly draft: EtpSectionDraft;
  readonly editable: boolean;
  readonly onRevert: () => Promise<void>;
}) {
  const t = useTranslations('etp.editor.notApplicable');
  return (
    <div className="flex flex-col gap-2 rounded-card bg-muted p-4">
      <p className="text-sm font-medium">{t('title')}</p>
      <p className="text-sm break-words whitespace-pre-line">{draft.justification}</p>
      {editable ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void onRevert();
            }}
          >
            {t('revert')}
          </Button>
          <span className="text-xs text-muted-foreground">{t('revertHint')}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * `NotApplicableToggle` (RN-ETP-11 · V-04): justificativa ≥ 20 caracteres antes de gravar. O TR
 * (US-036 · V-08) reutiliza o controle com a própria mensagem em `validate` (`null` = válida).
 */
export function NotApplicableToggle({
  sectionKey,
  required,
  onConfirm,
  validate,
}: {
  readonly sectionKey: string;
  readonly required: boolean;
  readonly onConfirm: (justification: string) => Promise<void>;
  readonly validate?: ((justification: string) => string | null) | undefined;
}) {
  const t = useTranslations('etp.editor.notApplicable');
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const fieldId = `etp-na-${sectionKey}`;
  if (!open) {
    return (
      <div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setOpen(true);
          }}
        >
          {t('mark')}
        </Button>
      </div>
    );
  }
  const confirm = () => {
    const etpProblem = validate === undefined ? notApplicableJustificationProblem(text) : null;
    const message =
      validate === undefined
        ? etpProblem === null
          ? null
          : notApplicableJustificationMessage(etpProblem)
        : validate(text);
    if (message !== null) {
      setError(message);
      field.current?.focus();
      return;
    }
    setError(null);
    setOpen(false);
    void onConfirm(text.trim());
  };
  return (
    <div className="flex flex-col gap-3 rounded-card bg-muted p-4">
      <Field
        id={fieldId}
        label={t('justificationLabel')}
        required
        requiredMark=" *"
        description={`${t('justificationHint')}${required ? ` ${t('requiredNote')}` : ''}`}
        error={error === null ? undefined : <span role="alert">{error}</span>}
      >
        <Textarea
          ref={field}
          rows={4}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={confirm}>
          {t('confirm')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}
