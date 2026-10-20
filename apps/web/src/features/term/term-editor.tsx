'use client';

import {
  Alert,
  AutosaveIndicator,
  Button,
  ConflictDialog,
  cx,
  RecoveredDraftBanner,
  Skeleton,
} from '@contrataflow/ui';
import {
  etpSectionHasNarrative,
  richTextPlainText,
  termJustificationProblem,
  termSectionAllowsNotApplicable,
} from '@contrataflow/validation';
import type {
  SectionState,
  TermCompletenessDto,
  TermDetailDto,
  TermDetailMeta,
  TermTemplateSectionDto,
} from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { useShellSession } from '@/lib/session/session-context';

import { ImportEtpPanel, StaleEtpBanner } from './import-etp-panel';
import {
  localCompleteness,
  termNavItems,
  termReadOnlyReason,
  canEditTerm,
} from './term-editor-model';
import type { TermNavItem } from './term-editor-model';
import { EstimatedValueText, TermGeneralDataPanel } from './term-general-data-panel';
import { useTerm } from './term.api';
import { AiSectionMenu } from '../ai/ai-section-assistant';
import type { AiSectionChange } from '../ai/ai-section-assistant';
import { NotApplicableSummary, NotApplicableToggle } from '../etp/etp-editor';
import { draftState, EMPTY_SECTION_DRAFT, sectionDraftOf } from '../etp/etp-editor-model';
import type { EtpSectionDraft } from '../etp/etp-editor-model';
import { useEtpAutosave } from '../etp/use-etp-autosave';
import { TEXTAREA_CLASS } from '../processes/form-field';

/*
 * `TermEditor` (SCR-012 · US-036): o TR seção por seção. Navegação lateral com o estado de cada
 * seção (vazia, preenchida, não se aplica), o marcador de obrigatória e o percentual de completude
 * (RN-TR-13 — recalculado aqui com `termCompleteness` depois de cada gravação); a seção ativa com
 * orientação (`helpText`), base legal, texto (autosave de 1,5 s e na perda de foco — o MESMO
 * mecanismo do ETP/DFD sobre o DOC-05, com `If-Match: "s<revision>"` e o diálogo de conflito) e o
 * "Não se aplica" justificado (só fora das `REQUIRED` — RN-TR-12); o painel "Dados do TR" (objeto e
 * valor estimado — TRM-04). Somente leitura sem `UPDATE` ou fora de `DRAFT`/`RETURNED` (FA-06).
 * Abaixo de 768 px a navegação recolhe para o menu "Seções". US-037: "Importar do ETP" (TRM-05/06 —
 * oculto sem `UPDATE`) e o aviso de ETP atualizado desde a última importação (RN-TR-24); depois da
 * importação o editor recarrega o TR e remonta com o rascunho novo.
 */

function timeOf(value: string | number, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone }).format(
    new Date(value),
  );
}

const STATE_ICON: Readonly<Record<SectionState, string>> = {
  EMPTY: '○',
  FILLED: '●',
  NOT_APPLICABLE: '⊘',
};

export function TermEditor({
  processId,
  termId,
}: {
  readonly processId: string;
  readonly termId: string;
}) {
  const t = useTranslations('term.editor');
  const query = useTerm(termId);
  // US-037: a importação troca o rascunho no servidor — o editor remonta com o TR recarregado.
  const [generation, setGeneration] = useState(0);
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
    <TermEditorLoaded
      key={`${query.data.term.documentId}:${String(generation)}`}
      processId={processId}
      term={query.data.term}
      meta={query.data.meta}
      onReload={async () => {
        await query.refetch();
        setGeneration((value) => value + 1);
      }}
    />
  );
}

export interface TermEditorLoadedProps {
  readonly processId: string;
  readonly term: TermDetailDto;
  readonly meta: TermDetailMeta;
  /** US-037: recarregar o TR (depois da importação do ETP ou de um conflito). */
  readonly onReload?: () => Promise<void>;
}

export function TermEditorLoaded({ processId, term, meta, onReload }: TermEditorLoadedProps) {
  const t = useTranslations('term.editor');
  const session = useShellSession();
  const timeZone = session.activeTenant.timezone;
  const sections = [...(meta.template?.sections ?? [])].sort((a, b) => a.order - b.order);
  const readOnlyReason = termReadOnlyReason(term.status, meta.allowedActions);
  const allowed = canEditTerm(term.status, meta.allowedActions);

  const [drafts, setDrafts] = useState<Record<string, EtpSectionDraft>>(() =>
    Object.fromEntries(
      Object.entries(term.draftContent.sections).map(([key, section]) => [
        key,
        sectionDraftOf(section),
      ]),
    ),
  );
  // O que o servidor já gravou: o estado de cada seção (navegação) e o valor (completude local).
  const [states, setStates] = useState<Record<string, SectionState>>(() =>
    Object.fromEntries(
      Object.entries(term.draftContent.sections).map(([key, section]) => [key, section.state]),
    ),
  );
  const [savedDrafts, setSavedDrafts] = useState<Record<string, EtpSectionDraft>>(() => ({
    ...drafts,
  }));
  // Até a primeira gravação vale a completude do TRM-03; depois, o recálculo local (RN-TR-13).
  const [recalculated, setRecalculated] = useState(false);
  const completeness: TermCompletenessDto = recalculated
    ? localCompleteness(sections, savedDrafts)
    : term.completeness;
  const [activeKey, setActiveKey] = useState<string>(() => sections[0]?.key ?? '');

  const autosave = useEtpAutosave({
    etp: term,
    tenantId: session.activeTenant.id,
    userId: session.user.id,
    enabled: allowed,
    onSection: (key, draft) => {
      setDrafts((previous) => ({ ...previous, [key]: draft }));
    },
    onSaved: (saved, value) => {
      setStates((previous) => ({ ...previous, [saved.sectionKey]: saved.state }));
      setSavedDrafts((previous) => ({ ...previous, [saved.sectionKey]: value }));
      setRecalculated(true);
    },
  });
  const editable = allowed && autosave.blocked === null;

  const nav = termNavItems(sections, states, completeness);
  const active = sections.find((section) => section.key === activeKey) ?? sections[0];
  const activeIndex = nav.findIndex((item) => item.key === active?.key);
  const activeItem = nav[activeIndex];

  const select = (key: string) => {
    void autosave.flush();
    setActiveKey(key);
  };
  const change = (key: string, draft: EtpSectionDraft) => {
    setDrafts((previous) => ({ ...previous, [key]: draft }));
    autosave.change(key, draft);
  };
  const commit = async (key: string, draft: EtpSectionDraft) => {
    setDrafts((previous) => ({ ...previous, [key]: draft }));
    await autosave.commit(key, draft);
  };

  const [importing, setImporting] = useState(false);
  const reload = async () => {
    await autosave.flush();
    await onReload?.();
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
    <section aria-labelledby="term-editor-title" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="term-editor-title" className="text-lg font-semibold">
          {t('heading')}
        </h2>
        {term.inApproval ? (
          <span
            data-testid="term-in-approval"
            className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning"
          >
            {t('inApproval')}
          </span>
        ) : null}
        {allowed ? (
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto"
            onClick={() => {
              void autosave.flush();
              setImporting(true);
            }}
          >
            {t('import.action')}
          </Button>
        ) : null}
        {allowed ? (
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
        ) : null}
      </div>

      <CompletenessBar completeness={completeness} />

      {readOnlyReason === null ? null : (
        <Alert tone="info" live={false} title={t('readOnly.title')}>
          <p>{t(`readOnly.${readOnlyReason}`)}</p>
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

      {term.etpChangedSinceImport ? (
        <StaleEtpBanner
          editable={allowed}
          onReimport={() => {
            setImporting(true);
          }}
        />
      ) : null}

      <TermGeneralDataPanel processId={processId} term={term} editable={allowed} />

      <div className="flex min-w-0 flex-col gap-4 md:flex-row md:items-start">
        <TermSectionNav items={nav} activeKey={active?.key ?? ''} onSelect={select} />
        {active === undefined ? null : (
          <TermSectionPanel
            key={active.key}
            term={term}
            section={active}
            item={activeItem}
            draft={drafts[active.key] ?? EMPTY_SECTION_DRAFT}
            editable={editable}
            previous={nav[activeIndex - 1]}
            next={nav[activeIndex + 1]}
            onSelect={select}
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
      </div>

      {allowed ? (
        <ImportEtpPanel
          open={importing}
          processId={processId}
          termId={term.id}
          version={term.version}
          sections={sections}
          onClose={() => {
            setImporting(false);
          }}
          onImported={reload}
          onStale={reload}
        />
      ) : null}

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
            // A versão do servidor passa a ser a gravada (navegação e completude).
            const { key, current } = conflict;
            setStates((previous) => ({ ...previous, [key]: current.state }));
            setSavedDrafts((previous) => ({ ...previous, [key]: sectionDraftOf(current) }));
            setRecalculated(true);
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

// --- Completude ----------------------------------------------------------------------------------

function CompletenessBar({ completeness }: { readonly completeness: TermCompletenessDto }) {
  const t = useTranslations('term.editor.completeness');
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-muted-foreground">
        {t('label')}:{' '}
        <span className="font-medium text-foreground" data-testid="term-completeness">
          {t('summary', {
            percent: completeness.percent,
            satisfied: completeness.satisfied,
            required: completeness.required,
          })}
        </span>
      </p>
      <div
        role="progressbar"
        aria-label={t('label')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={completeness.percent}
        aria-valuetext={t('progress', { percent: completeness.percent })}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full bg-primary" style={{ width: `${String(completeness.percent)}%` }} />
      </div>
    </div>
  );
}

// --- Navegação lateral ---------------------------------------------------------------------------

export function TermSectionNav({
  items,
  activeKey,
  onSelect,
}: {
  readonly items: readonly TermNavItem[];
  readonly activeKey: string;
  readonly onSelect: (key: string) => void;
}) {
  const t = useTranslations('term.editor');
  const [open, setOpen] = useState(false);
  const list = (
    <ol className="flex flex-col gap-1">
      {items.map((item, index) => {
        const current = item.key === activeKey;
        return (
          <li key={item.key}>
            <button
              type="button"
              aria-current={current ? 'true' : undefined}
              data-state={item.state}
              data-requirement={item.requirement}
              className={cx(
                'flex w-full items-start gap-2 rounded-control px-2 py-1.5 text-left text-sm',
                current ? 'bg-primary-soft font-medium text-primary' : 'hover:bg-muted',
              )}
              onClick={() => {
                setOpen(false);
                onSelect(item.key);
              }}
            >
              <span aria-hidden="true" className="w-4 shrink-0 text-center">
                {STATE_ICON[item.state]}
              </span>
              <span className="min-w-0 flex-1 break-words">
                {index + 1}. {item.title}
                <span className="sr-only">
                  {`, ${t(`requirement.${item.requirement}`)}, ${t(`state.${item.state}`)}`}
                </span>
              </span>
              {item.requirement === 'OPTIONAL' ? null : (
                <span aria-hidden="true" title={t('requiredMark')} className="text-destructive">
                  *
                </span>
              )}
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
          aria-controls="term-sections-menu"
          onClick={() => {
            setOpen((value) => !value);
          }}
        >
          {t('sectionsMenu')}
        </Button>
        {open ? (
          <nav id="term-sections-menu" aria-label={t('sectionsNav')} className="mt-2">
            {list}
          </nav>
        ) : null}
      </div>
      <nav aria-label={t('sectionsNav')} className="hidden w-64 shrink-0 md:block">
        {list}
      </nav>
    </>
  );
}

// --- Seção ativa ---------------------------------------------------------------------------------

interface TermSectionPanelProps {
  readonly term: TermDetailDto;
  readonly section: TermTemplateSectionDto;
  readonly item: TermNavItem | undefined;
  readonly draft: EtpSectionDraft;
  readonly editable: boolean;
  readonly previous: TermNavItem | undefined;
  readonly next: TermNavItem | undefined;
  readonly onSelect: (key: string) => void;
  readonly onChange: (draft: EtpSectionDraft) => void;
  readonly onCommit: (draft: EtpSectionDraft) => Promise<void>;
  readonly onBlur: () => void;
  /** US-121: seção ajustada com IA (aplicação ou "Desfazer") — o editor adota a do servidor. */
  readonly onAiChange: (change: AiSectionChange) => void;
}

function TermSectionPanel({
  term,
  section,
  item,
  draft,
  editable,
  previous,
  next,
  onSelect,
  onChange,
  onCommit,
  onBlur,
  onAiChange,
}: TermSectionPanelProps) {
  const t = useTranslations('term.editor');
  const id = useId();
  const textId = `term-section-${section.key}`;
  const structured = section.render === 'TEXT' ? null : section.render;
  const narrative = etpSectionHasNarrative(section);
  return (
    <article
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 flex-1 flex-col gap-3 rounded-control border border-border p-4"
    >
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 id={`${id}-title`} className="text-base font-semibold break-words">
            {section.title}
          </h3>
          <AiSectionMenu
            processId={term.processId}
            documentId={term.documentId}
            targetModule="TERM_OF_REFERENCE"
            section={section}
            state={draftState(draft)}
            text={draft.text}
            editable={editable}
            onSectionChanged={onAiChange}
          />
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>{t(`requirement.${section.requirement}`)}</span>
          <span>· {t(`state.${item?.state ?? 'EMPTY'}`)}</span>
          {section.legalBasis ? (
            <span>· {t('legalBasis', { basis: section.legalBasis })}</span>
          ) : null}
        </div>
      </header>
      {section.helpText ? (
        <details className="rounded-control border border-border p-3 text-sm">
          <summary className="cursor-pointer font-medium">{t('help')}</summary>
          <p className="mt-2 text-muted-foreground">{section.helpText}</p>
        </details>
      ) : null}

      {draft.notApplicable ? (
        <NotApplicableSummary
          draft={draft}
          editable={editable}
          onRevert={() => onCommit({ text: '', notApplicable: false, justification: '' })}
        />
      ) : (
        <>
          {structured === 'ESTIMATED_VALUE' ? (
            <p className="text-sm">
              <span className="font-medium">
                <EstimatedValueText term={term} />
              </span>
            </p>
          ) : null}
          {structured === 'ITEMS_TABLE' || structured === 'ALTERNATIVES_TABLE' ? (
            <p className="text-sm text-muted-foreground">{t(`structured.${structured}`)}</p>
          ) : null}
          {narrative ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={textId} className="text-sm font-medium">
                {t(structured === null ? 'textLabel' : 'narrativeLabel', { title: section.title })}
              </label>
              <textarea
                id={textId}
                aria-describedby={`${textId}-hint`}
                className={`${TEXTAREA_CLASS} min-h-48`}
                maxLength={section.maxChars}
                value={draft.text}
                readOnly={!editable}
                onChange={(event) => {
                  onChange({ ...draft, text: event.target.value });
                }}
                onBlur={onBlur}
              />
              <span id={`${textId}-hint`} className="text-xs text-muted-foreground">
                {t('maxChars', { max: section.maxChars.toLocaleString('pt-BR') })}
              </span>
            </div>
          ) : null}
          {editable && termSectionAllowsNotApplicable(section.requirement) ? (
            <NotApplicableToggle
              sectionKey={section.key}
              required={false}
              validate={termJustificationProblem}
              onConfirm={(justification) =>
                onCommit({ text: draft.text, notApplicable: true, justification })
              }
            />
          ) : null}
        </>
      )}

      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        <Button
          size="sm"
          variant="secondary"
          disabled={previous === undefined}
          onClick={() => {
            if (previous !== undefined) onSelect(previous.key);
          }}
        >
          {t('previous')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={next === undefined}
          onClick={() => {
            if (next !== undefined) onSelect(next.key);
          }}
        >
          {t('next')}
        </Button>
      </div>
    </article>
  );
}
