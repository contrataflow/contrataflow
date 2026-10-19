'use client';

import {
  Alert,
  AutosaveIndicator,
  Button,
  ConflictDialog,
  cx,
  RecoveredDraftBanner,
} from '@contrataflow/ui';
import type { LocalDraftStore } from '@contrataflow/ui';
import { richTextPlainText } from '@contrataflow/validation';
import type {
  DocumentDto,
  DocumentMeta,
  DocumentTemplateMetaDto,
  DocumentTemplateSectionDto,
  SectionState,
} from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { useShellSession } from '@/lib/session/session-context';

import {
  allowsNotApplicable,
  canEditFreeText,
  freeTextJustificationProblem,
  freeTextNavItems,
  freeTextReadOnlyReason,
  sectionLimitProblem,
} from './free-text-editor-model';
import type { FreeTextNavItem } from './free-text-editor-model';
import { NotApplicableSummary, NotApplicableToggle } from '../etp/etp-editor';
import { EMPTY_SECTION_DRAFT, sectionDraftOf } from '../etp/etp-editor-model';
import type { EtpSectionDraft } from '../etp/etp-editor-model';
import { useEtpAutosave } from '../etp/use-etp-autosave';
import { TEXTAREA_CLASS } from '../processes/form-field';

/*
 * `FreeTextEditor` (SCR-105 · US-063): o documento livre seção por seção, na ordem do template
 * (`meta.template` do DOC-03). Navegação lateral com o estado de cada seção (vazia, preenchida, não
 * se aplica) e a exigência; a seção ativa com orientação (`helpText`), base legal, texto (autosave
 * de 1,5 s e na perda de foco — o MESMO mecanismo do DFD/ETP/TR sobre o DOC-05, com
 * `If-Match: "s<revision>"`, contingência local cifrada e o diálogo de conflito) e o "Não se aplica"
 * justificado (só em `REQUIRED_OR_JUSTIFY`/`OPTIONAL` — RN-DOC-28). O texto acima do limite fica só
 * no editor, com o aviso (FA-03). Somente leitura sem `UPDATE` ou fora de `DRAFT`/`RETURNED`.
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

export interface FreeTextEditorProps {
  readonly document: DocumentDto;
  readonly meta: DocumentMeta;
  readonly template: DocumentTemplateMetaDto;
  /** Testes: contingência em memória. */
  readonly store?: LocalDraftStore | undefined;
}

export function FreeTextEditor({ document, meta, template, store }: FreeTextEditorProps) {
  const t = useTranslations('documents.editor');
  const session = useShellSession();
  const timeZone = session.activeTenant.timezone;
  const sections = [...template.sections].sort((a, b) => a.order - b.order);
  const readOnlyReason = freeTextReadOnlyReason(document.status, meta.allowedActions);
  const allowed = canEditFreeText(document.status, meta.allowedActions);

  // O rascunho lido ao abrir: o editor guarda o seu (o DOC-03 relido não sobrescreve a digitação).
  const [initial] = useState(() => ({
    documentId: document.id,
    draftContent: document.draftContent,
  }));
  const [drafts, setDrafts] = useState<Record<string, EtpSectionDraft>>(() =>
    Object.fromEntries(
      Object.entries(initial.draftContent.sections).map(([key, section]) => [
        key,
        sectionDraftOf(section),
      ]),
    ),
  );
  const [states, setStates] = useState<Record<string, SectionState>>(() =>
    Object.fromEntries(
      Object.entries(initial.draftContent.sections).map(([key, section]) => [key, section.state]),
    ),
  );
  const [activeKey, setActiveKey] = useState<string>(() => sections[0]?.key ?? '');

  const autosave = useEtpAutosave({
    etp: initial,
    tenantId: session.activeTenant.id,
    userId: session.user.id,
    enabled: allowed,
    store,
    onSection: (key, draft) => {
      setDrafts((previous) => ({ ...previous, [key]: draft }));
    },
    onSaved: (saved) => {
      setStates((previous) => ({ ...previous, [saved.sectionKey]: saved.state }));
    },
  });
  const editable = allowed && autosave.blocked === null;

  const nav = freeTextNavItems(sections, states);
  const active = sections.find((section) => section.key === activeKey) ?? sections[0];
  const activeIndex = nav.findIndex((item) => item.key === active?.key);

  const select = (key: string) => {
    void autosave.flush();
    setActiveKey(key);
  };
  const change = (section: DocumentTemplateSectionDto, draft: EtpSectionDraft) => {
    setDrafts((previous) => ({ ...previous, [section.key]: draft }));
    // FA-03: acima do limite, o texto fica só no editor (com o aviso) até voltar ao permitido.
    if (sectionLimitProblem(draft.text, section.maxChars) === null) {
      autosave.change(section.key, draft);
    }
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
    <section aria-labelledby="free-text-editor-title" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="free-text-editor-title" className="text-lg font-semibold">
          {t('heading')}
        </h2>
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

      <div className="flex min-w-0 flex-col gap-4 md:flex-row md:items-start">
        <FreeTextSectionNav items={nav} activeKey={active?.key ?? ''} onSelect={select} />
        {active === undefined ? null : (
          <FreeTextSectionPanel
            key={active.key}
            section={active}
            item={nav[activeIndex]}
            draft={drafts[active.key] ?? EMPTY_SECTION_DRAFT}
            editable={editable}
            previous={nav[activeIndex - 1]}
            next={nav[activeIndex + 1]}
            onSelect={select}
            onChange={(draft) => {
              change(active, draft);
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
            const { key, current } = conflict;
            setStates((previous) => ({ ...previous, [key]: current.state }));
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

function FreeTextSectionNav({
  items,
  activeKey,
  onSelect,
}: {
  readonly items: readonly FreeTextNavItem[];
  readonly activeKey: string;
  readonly onSelect: (key: string) => void;
}) {
  const t = useTranslations('documents.editor');
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
          aria-controls="free-text-sections-menu"
          onClick={() => {
            setOpen((value) => !value);
          }}
        >
          {t('sectionsMenu')}
        </Button>
        {open ? (
          <nav id="free-text-sections-menu" aria-label={t('sectionsNav')} className="mt-2">
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

interface FreeTextSectionPanelProps {
  readonly section: DocumentTemplateSectionDto;
  readonly item: FreeTextNavItem | undefined;
  readonly draft: EtpSectionDraft;
  readonly editable: boolean;
  readonly previous: FreeTextNavItem | undefined;
  readonly next: FreeTextNavItem | undefined;
  readonly onSelect: (key: string) => void;
  readonly onChange: (draft: EtpSectionDraft) => void;
  readonly onCommit: (draft: EtpSectionDraft) => Promise<void>;
  readonly onBlur: () => void;
}

function FreeTextSectionPanel({
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
}: FreeTextSectionPanelProps) {
  const t = useTranslations('documents.editor');
  const id = useId();
  const textId = `free-text-section-${section.key}`;
  const limit = sectionLimitProblem(draft.text, section.maxChars);
  const max = section.maxChars.toLocaleString('pt-BR');
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

      {draft.notApplicable ? (
        <NotApplicableSummary
          draft={draft}
          editable={editable}
          onRevert={() => onCommit({ text: '', notApplicable: false, justification: '' })}
        />
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <label htmlFor={textId} className="text-sm font-medium">
              {t('textLabel', { title: section.title })}
            </label>
            <textarea
              id={textId}
              aria-describedby={`${textId}-hint${limit === null ? '' : ` ${textId}-limit`}`}
              aria-invalid={limit !== null}
              className={`${TEXTAREA_CLASS} min-h-48`}
              value={draft.text}
              readOnly={!editable}
              onChange={(event) => {
                onChange({ ...draft, text: event.target.value });
              }}
              onBlur={onBlur}
            />
            <span id={`${textId}-hint`} className="text-xs text-muted-foreground">
              {t('count', { count: draft.text.length.toLocaleString('pt-BR'), max })}
            </span>
            {limit === null ? null : (
              <p id={`${textId}-limit`} role="alert" className="text-sm text-destructive">
                {limit}
              </p>
            )}
          </div>
          {editable && allowsNotApplicable(section.requirement) ? (
            <NotApplicableToggle
              sectionKey={section.key}
              required={false}
              validate={freeTextJustificationProblem}
              onConfirm={(justification) =>
                onCommit({ text: draft.text, notApplicable: true, justification })
              }
            />
          ) : null}
        </>
      )}

      {previous === undefined && next === undefined ? null : (
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
      )}
    </article>
  );
}
