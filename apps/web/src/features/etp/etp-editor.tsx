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
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';

import { useShellSession } from '@/lib/session/session-context';

import { canEditEtp, EMPTY_SECTION_DRAFT, sectionDraftOf } from './etp-editor-model';
import type { EtpSectionDraft } from './etp-editor-model';
import { StructuredSectionContent } from './etp-structured-sections';
import { useEtp } from './etp.api';
import { useEtpAutosave } from './use-etp-autosave';
import { documentKeys, fetchDocumentValidation } from '../documents/documents.api';
import { TEXTAREA_CLASS } from '../processes/form-field';

/*
 * `EtpEditor` (SCR-008 · US-020): o ETP seção por seção. `SectionSidebarNav` com o estado de cada
 * seção (vazia, preenchida, não se aplica) e as pendências não bloqueantes do DOC-08 (RN-ETP-13);
 * a seção ativa com o texto (autosave de 1,5 s e na perda de foco — RN-ETP-10), o controle "Não se
 * aplica" com justificativa (RN-ETP-11) e, nas seções estruturadas, o quadro somente leitura do
 * módulo dono (RN-ETP-12). Somente leitura sem `UPDATE` ou fora de `DRAFT`/`RETURNED` (FA-05).
 * Abaixo de 768 px a navegação recolhe para o menu "Seções".
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

export function EtpEditor({
  processId,
  etpId,
}: {
  readonly processId: string;
  readonly etpId: string;
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
    />
  );
}

export interface EtpEditorLoadedProps {
  readonly processId: string;
  readonly etp: EtpDetailDto;
  readonly meta: EtpDetailMeta;
}

export function EtpEditorLoaded({ processId, etp, meta }: EtpEditorLoadedProps) {
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
  const nav = etpSectionNav(sections, { sections: {} }, violations).map((item) => ({
    ...item,
    state: states[item.key] ?? 'EMPTY',
  }));
  const summary = etpCompletionSummary(nav);
  const active = sections.find((section) => section.key === activeKey) ?? sections[0];
  const activeItem = nav.find((item) => item.key === active?.key);

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
    <section aria-labelledby="etp-editor-title" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="etp-editor-title" className="text-lg font-semibold">
          {t('sectionsNav')}
        </h2>
        <span className="text-sm text-muted-foreground">
          {t('summary', {
            done: summary.filled + summary.notApplicable,
            total: summary.total,
          })}
          {summary.pending > 0 ? ` · ${t('pendingCount', { count: summary.pending })}` : ''}
        </span>
        {allowed ? (
          <AutosaveIndicator
            className="ml-auto"
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

      <div className="flex min-w-0 flex-col gap-4 md:flex-row md:items-start">
        <SectionSidebarNav
          items={nav}
          activeKey={active?.key ?? ''}
          onSelect={(key) => {
            void autosave.flush();
            setActiveKey(key);
          }}
        />
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
          />
        )}
      </div>

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
              <span aria-hidden="true" className="w-4 shrink-0 text-center">
                {STATE_ICON[item.state]}
              </span>
              <span className="min-w-0 flex-1 break-words">
                {index + 1}. {item.title}
                <span className="sr-only">
                  {`, ${t(`state.${item.state}`)}`}
                  {item.issues.length > 0 ? `, ${t('pending')}` : ''}
                </span>
              </span>
              {item.issues.length > 0 ? (
                <span aria-hidden="true" title={t('pending')} className="text-warning">
                  !
                </span>
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
      <nav aria-label={t('sectionsNav')} className="hidden w-64 shrink-0 md:block">
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
}: EtpSectionPanelProps) {
  const t = useTranslations('etp.editor');
  const id = useId();
  const textId = `etp-section-${section.key}`;
  const kind = etpStructuredKind(section);
  const narrative = etpSectionHasNarrative(section);
  const issues = item?.issues ?? [];
  return (
    <article
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 flex-1 flex-col gap-3 rounded-control border border-border p-4"
    >
      <header className="flex flex-col gap-1">
        <h3 id={`${id}-title`} className="text-base font-semibold break-words">
          {section.title}
        </h3>
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
            <StructuredSectionContent kind={kind} processId={processId} documentId={documentId} />
          )}
          {narrative ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={textId} className="text-sm font-medium">
                {t(kind === null ? 'textLabel' : 'narrativeLabel', { title: section.title })}
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

function NotApplicableSummary({
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
    <div className="flex flex-col gap-2 rounded-control border border-border bg-muted/40 p-3">
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

/** `NotApplicableToggle` (RN-ETP-11 · V-04): justificativa ≥ 20 caracteres antes de gravar. */
export function NotApplicableToggle({
  sectionKey,
  required,
  onConfirm,
}: {
  readonly sectionKey: string;
  readonly required: boolean;
  readonly onConfirm: (justification: string) => Promise<void>;
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
    const problem = notApplicableJustificationProblem(text);
    if (problem !== null) {
      setError(notApplicableJustificationMessage(problem));
      field.current?.focus();
      return;
    }
    setError(null);
    setOpen(false);
    void onConfirm(text.trim());
  };
  return (
    <div className="flex flex-col gap-2 rounded-control border border-border p-3">
      <label htmlFor={fieldId} className="text-sm font-medium">
        {t('justificationLabel')} *
      </label>
      <textarea
        ref={field}
        id={fieldId}
        className={`${TEXTAREA_CLASS} min-h-24`}
        value={text}
        aria-invalid={error !== null}
        aria-describedby={`${fieldId}-hint${error === null ? '' : ` ${fieldId}-error`}`}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <span id={`${fieldId}-hint`} className="text-xs text-muted-foreground">
        {t('justificationHint')}
        {required ? ` ${t('requiredNote')}` : ''}
      </span>
      {error === null ? null : (
        <p id={`${fieldId}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
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
