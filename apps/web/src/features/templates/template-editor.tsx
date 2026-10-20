'use client';

import { Alert, Button, Skeleton } from '@contrataflow/ui';
import {
  CHANGE_NOTES_MAX_LENGTH,
  DEFAULT_TR_IMPORT_MAPPINGS,
  SECTION_REQUIREMENTS,
  SECTION_TEMPLATE_VARIABLES,
  TYPED_HEADER_FIELDS,
} from '@contrataflow/validation';
import type {
  FieldConfig,
  ImportMappings,
  SectionRender,
  TemplateVersionDto,
  TemplateVersionUpdateInput,
  Violation,
} from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import type { DragEvent } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { usePermission } from '@/lib/permissions/use-permission';
import { useTenantId } from '@/lib/session/session-context';

import {
  availableRenders,
  duplicateSection,
  insertVariable,
  localProblems,
  moveSection,
  newSection,
  toDraft,
  toSections,
  violationsBySection,
} from './template-editor-model';
import type {
  DraftField,
  LocalProblem,
  SectionDraft,
  TemplateTypeInfo,
} from './template-editor-model';
import { TemplateLayoutTab } from './template-layout-tab';
import {
  fetchTemplateVersion,
  templateKeys,
  TEMPLATES_PATH,
  TEMPLATES_STALE_TIME_MS,
  updateTemplateVersion,
} from './templates.api';

const INPUT = 'h-10 w-full rounded-control border border-border bg-surface px-3 text-sm';
const TEXTAREA =
  'min-h-24 w-full rounded-control border border-border bg-surface px-3 py-2 text-sm';

/**
 * SCR-114 (`/admin/templates/[id]/versoes/[versionId]` — US-107, aba "Conteúdo"): carrega a versão
 * (TPL-07) e abre o editor; versão não `DRAFT` ou usuário sem `TEMPLATE_MANAGE` → modo leitura com
 * `ReadOnlyBanner` (FA-04/FA-05). A aba "Layout" (US-109) edita o layout de impressão e gera a prévia
 * em PDF (`TemplateLayoutTab`), com o mesmo `If-Match` da aba "Conteúdo".
 */
export function TemplateEditorView({ versionId }: { readonly versionId: string }) {
  const t = useTranslations('templates');
  const tenantId = useTenantId();
  // Recarregar (412) remonta o editor com o estado persistido; salvar não remonta (foco mantido).
  const [generation, setGeneration] = useState(0);
  const version = useQuery({
    queryKey: templateKeys.version(tenantId, versionId),
    queryFn: async ({ signal }) => (await fetchTemplateVersion(versionId, signal)).data,
    staleTime: TEMPLATES_STALE_TIME_MS,
    throwOnError: false,
  });

  return (
    <div className="flex flex-col gap-6">
      <Link href={TEMPLATES_PATH} className="text-sm text-muted-foreground underline">
        {t('editor.back')}
      </Link>
      {version.isPending ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('editor.loading')}</span>
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : null}
      {version.isError ? (
        isApiError(version.error) && version.error.status === 404 ? (
          <Alert tone="error" title={t('editor.notFound')} />
        ) : isApiError(version.error) && version.error.status === 403 ? (
          <Alert tone="error" title={t('forbidden.title')}>
            {t('forbidden.description')}
          </Alert>
        ) : (
          <Alert tone="error" title={t('editor.loadFailed')}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void version.refetch();
              }}
            >
              {t('retry')}
            </Button>
          </Alert>
        )
      ) : null}
      {version.data ? (
        <TemplateEditor
          key={`${version.data.id}:${String(generation)}`}
          version={version.data}
          onReload={() => {
            void version.refetch().then(() => {
              setGeneration((value) => value + 1);
            });
          }}
        />
      ) : null}
    </div>
  );
}

type SaveProblem =
  | { readonly kind: 'conflict' }
  | { readonly kind: 'invalid'; readonly violations: readonly Violation[] }
  | { readonly kind: 'notDraft' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'generic'; readonly message: string };

interface Dirty {
  readonly sections: boolean;
  readonly fieldConfig: boolean;
  readonly importMappings: boolean;
  readonly changeNotes: boolean;
}

const CLEAN: Dirty = {
  sections: false,
  fieldConfig: false,
  importMappings: false,
  changeNotes: false,
};

interface EditorState {
  readonly drafts: readonly SectionDraft[];
  readonly fieldConfig: FieldConfig;
  readonly importMappings: ImportMappings | null;
  readonly changeNotes: string;
  readonly dirty: Dirty;
}

/** Mapeamento com seção do TR ou fontes do ETP ainda não escolhidas não é enviado. */
function mappingsAreIncomplete(mappings: ImportMappings | null): boolean {
  return (
    mappings?.sections.some((mapping) => mapping.target === '' || mapping.sources.length === 0) ??
    false
  );
}

/** Erros de campo do 422 `VALIDATION_ERROR` (`sections[2].minChars`) por seção. */
function fieldErrorsOf(
  errors: readonly { field: string; message: string }[],
  drafts: readonly SectionDraft[],
): LocalProblem[] {
  return errors.flatMap((error) => {
    const match = /^sections\[(\d+)\]\.(\w+)/.exec(error.field);
    const draft = match ? drafts[Number(match[1])] : undefined;
    return draft && match?.[2]
      ? [{ uid: draft.uid, field: match[2] as DraftField, message: error.message }]
      : [];
  });
}

function TemplateEditor({
  version,
  onReload,
}: {
  readonly version: TemplateVersionDto;
  readonly onReload: () => void;
}) {
  const t = useTranslations('templates');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const ids = useId();
  const permission = usePermission('TEMPLATE_MANAGE');
  const isDraft = version.status === 'DRAFT';
  const readOnly = !isDraft || !permission.allowed;
  const type: TemplateTypeInfo = version.documentType;

  const [state, setState] = useState<EditorState>(() => ({
    drafts: version.sections.map(toDraft),
    fieldConfig: version.fieldConfig,
    importMappings: version.importMappings,
    changeNotes: version.changeNotes ?? '',
    dirty: CLEAN,
  }));
  const [revision, setRevision] = useState(version.version);
  const [tab, setTab] = useState<EditorTab>('content');
  const [selectedUid, setSelectedUid] = useState<string | null>(state.drafts[0]?.uid ?? null);
  const [problem, setProblem] = useState<SaveProblem | null>(null);
  const [serverFieldErrors, setServerFieldErrors] = useState<LocalProblem[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const latest = useRef({ state, revision });
  useEffect(() => {
    latest.current = { state, revision };
  });
  const queued = useRef(false);

  const problems = localProblems(state.drafts, type);
  const mappingsIncomplete = mappingsAreIncomplete(state.importMappings);
  const blocked = problems.length > 0 || mappingsIncomplete;
  const isDirty = Object.values(state.dirty).some(Boolean);

  const save = useMutation({
    mutationFn: ({
      body,
      revision: expected,
    }: {
      body: TemplateVersionUpdateInput;
      revision: number;
    }) => updateTemplateVersion(version.id, body, expected),
  });

  const runSave = async () => {
    const { state: current, revision: expected } = latest.current;
    if (readOnly || !Object.values(current.dirty).some(Boolean)) return;
    if (localProblems(current.drafts, type).length > 0) return;
    if (mappingsAreIncomplete(current.importMappings)) return;
    if (save.isPending) {
      queued.current = true;
      return;
    }
    const body: TemplateVersionUpdateInput = {
      ...(current.dirty.sections ? { sections: toSections(current.drafts) } : {}),
      ...(current.dirty.fieldConfig ? { fieldConfig: current.fieldConfig } : {}),
      ...(current.dirty.importMappings ? { importMappings: current.importMappings } : {}),
      ...(current.dirty.changeNotes
        ? { changeNotes: current.changeNotes.trim() === '' ? null : current.changeNotes }
        : {}),
    };
    const sent = current;
    try {
      const result = await save.mutateAsync({ body, revision: expected });
      setRevision(result.data.version);
      setProblem(null);
      setServerFieldErrors([]);
      // Só limpa o que foi enviado e não mudou desde então.
      setState((now) => ({
        ...now,
        dirty: {
          sections: now.dirty.sections && now.drafts !== sent.drafts,
          fieldConfig: now.dirty.fieldConfig && now.fieldConfig !== sent.fieldConfig,
          importMappings: now.dirty.importMappings && now.importMappings !== sent.importMappings,
          changeNotes: now.dirty.changeNotes && now.changeNotes !== sent.changeNotes,
        },
      }));
      setAnnouncement(t('editor.saveState.saved'));
      queryClient.setQueryData(templateKeys.version(tenantId, version.id), result.data);
      void queryClient.invalidateQueries({ queryKey: templateKeys.list(tenantId) });
    } catch (error) {
      setProblem(problemOf(error));
      if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
        setServerFieldErrors(fieldErrorsOf(error.errors, sent.drafts));
      }
    } finally {
      if (queued.current) {
        queued.current = false;
        void runSave();
      }
    }
  };

  const problemOf = (error: unknown): SaveProblem => {
    if (!isApiError(error)) return { kind: 'generic', message: t('editor.unavailable') };
    if (error.code === 'VERSION_CONFLICT') return { kind: 'conflict' };
    if (error.code === 'TEMPLATE_INVALID') return { kind: 'invalid', violations: error.violations };
    if (error.code === 'TEMPLATE_VERSION_NOT_DRAFT') return { kind: 'notDraft' };
    if (error.status === 403) return { kind: 'forbidden' };
    if (error.status === 503) return { kind: 'unavailable' };
    return { kind: 'generic', message: error.message };
  };

  const change = (next: Partial<Omit<EditorState, 'dirty'>>, part: keyof Dirty) => {
    setState((now) => ({ ...now, ...next, dirty: { ...now.dirty, [part]: true } }));
  };
  const updateDraft = (uid: string, patch: Partial<SectionDraft>) => {
    setState((now) => ({
      ...now,
      drafts: now.drafts.map((draft) => (draft.uid === uid ? { ...draft, ...patch } : draft)),
      dirty: { ...now.dirty, sections: true },
    }));
  };
  /** Mudanças estruturais (reordenar, duplicar, remover) salvam logo depois do render. */
  const [saveTick, setSaveTick] = useState(0);
  useEffect(() => {
    if (saveTick > 0) void runSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dispara só no tique pedido
  }, [saveTick]);
  const structural = (drafts: readonly SectionDraft[]) => {
    change({ drafts }, 'sections');
    setSaveTick((tick) => tick + 1);
  };

  /** Autosave ao sair de um campo do painel (passo 5): `focusout` nativo no contêiner. */
  const fieldsRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef(runSave);
  useEffect(() => {
    saveRef.current = runSave;
  });
  useEffect(() => {
    const container = fieldsRef.current;
    if (!container) return undefined;
    const onFocusOut = (event: FocusEvent) => {
      if (container.contains(event.relatedTarget as Node | null)) return;
      void saveRef.current();
    };
    container.addEventListener('focusout', onFocusOut);
    return () => {
      container.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  const violations = problem?.kind === 'invalid' ? violationsBySection(problem.violations) : null;
  const selectedIndex = state.drafts.findIndex((draft) => draft.uid === selectedUid);
  const selected = state.drafts[selectedIndex];
  const sectionProblems = (uid: string) => [
    ...problems.filter((item) => item.uid === uid),
    ...serverFieldErrors.filter((item) => item.uid === uid),
  ];
  const sectionViolations = (draft: SectionDraft) =>
    violations?.bySection.get(draft.key.trim()) ?? [];

  const saveLabel = save.isPending
    ? t('editor.saveState.saving')
    : blocked && isDirty
      ? t('editor.saveState.blocked')
      : isDirty
        ? t('editor.saveState.dirty')
        : t('editor.saveState.saved');

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('editor.heading', { name: version.templateName, number: version.versionNumber })}
          </h1>
          <p className="mt-1 text-muted-foreground">
            {version.documentType.name} · {t(`editor.status.${version.status}`)}
          </p>
        </div>
        {readOnly || tab === 'layout' ? null : (
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground" aria-hidden="true">
              {saveLabel}
            </span>
            <Button
              disabled={!isDirty || save.isPending || blocked}
              aria-busy={save.isPending}
              onClick={() => {
                void runSave();
              }}
            >
              {t('editor.save')}
            </Button>
          </div>
        )}
      </header>
      <p className="sr-only" aria-live="polite" role="status">
        {announcement}
      </p>

      {readOnly ? (
        <Alert
          tone="info"
          title={
            version.status === 'PUBLISHED'
              ? t('editor.readOnly.published')
              : version.status === 'RETIRED'
                ? t('editor.readOnly.retired')
                : t('editor.readOnly.noPermission')
          }
        />
      ) : null}

      {problem ? (
        <SaveProblemAlert problem={problem} onReload={onReload} onRetry={() => void runSave()} />
      ) : null}
      {violations && violations.general.length > 0 ? (
        <Alert tone="error" title={t('violations.general')}>
          <ul className="list-disc pl-5">
            {violations.general.map((violation, index) => (
              <li key={`${violation.code}-${String(index)}`}>{violation.message}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <EditorTabs tab={tab} onChange={setTab} />

      {tab === 'layout' ? (
        <div role="tabpanel" id={`${ids}-panel-layout`} aria-labelledby={`${ids}-tab-layout`}>
          <TemplateLayoutTab
            version={version}
            revision={revision}
            readOnly={readOnly}
            onReload={onReload}
            onSaved={(saved) => {
              setRevision(saved.version);
              queryClient.setQueryData(templateKeys.version(tenantId, version.id), saved);
            }}
          />
        </div>
      ) : (
        <div
          role="tabpanel"
          id={`${ids}-panel-content`}
          aria-labelledby={`${ids}-tab-content`}
          className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(16rem,20rem)_1fr]"
        >
          <SectionList
            drafts={state.drafts}
            selectedUid={selectedUid}
            readOnly={readOnly}
            hasProblems={(draft) =>
              sectionProblems(draft.uid).length > 0 || sectionViolations(draft).length > 0
            }
            onSelect={setSelectedUid}
            onAdd={() => {
              const draft = newSection();
              change({ drafts: [...state.drafts, draft] }, 'sections');
              setSelectedUid(draft.uid);
            }}
            onMove={(from, to) => {
              const moved = state.drafts[from];
              structural(moveSection(state.drafts, from, to));
              if (moved) {
                setAnnouncement(
                  t('sections.moved', { title: moved.title || moved.key, position: to + 1 }),
                );
              }
            }}
            onDuplicate={(uid) => {
              const result = duplicateSection(state.drafts, uid);
              change({ drafts: result.drafts }, 'sections');
              setSelectedUid(result.copyUid);
            }}
            onRemove={(uid) => {
              const remaining = state.drafts.filter((draft) => draft.uid !== uid);
              structural(remaining);
              if (selectedUid === uid) setSelectedUid(remaining[0]?.uid ?? null);
            }}
          />
          <div ref={fieldsRef} className="flex flex-col gap-6">
            {selected ? (
              <SectionEditorPanel
                key={selected.uid}
                draft={selected}
                position={selectedIndex + 1}
                type={type}
                readOnly={readOnly}
                problems={sectionProblems(selected.uid)}
                violations={sectionViolations(selected)}
                onChange={(patch) => {
                  updateDraft(selected.uid, patch);
                }}
              />
            ) : state.drafts.length > 0 ? (
              <p className="rounded-card border border-dashed border-border p-6 text-muted-foreground">
                {t('section.nonePanel')}
              </p>
            ) : null}

            {type.kind === 'STRUCTURED' && type.systemModule ? (
              <FieldConfigPanel
                fields={TYPED_HEADER_FIELDS[type.systemModule]}
                value={state.fieldConfig}
                readOnly={readOnly}
                onChange={(fieldConfig) => {
                  change({ fieldConfig }, 'fieldConfig');
                }}
              />
            ) : null}

            {type.systemModule === 'TERM_OF_REFERENCE' ? (
              <ImportMappingsPanel
                value={state.importMappings}
                targets={state.drafts.map((draft) => draft.key.trim()).filter((key) => key !== '')}
                sources={version.importSources?.sectionKeys ?? []}
                readOnly={readOnly}
                onChange={(importMappings) => {
                  change({ importMappings }, 'importMappings');
                }}
              />
            ) : null}

            <div className="flex flex-col gap-1">
              <label htmlFor={`${ids}-notes`} className="text-sm font-medium">
                {t('editor.changeNotes')}
              </label>
              <textarea
                id={`${ids}-notes`}
                className={TEXTAREA}
                value={state.changeNotes}
                maxLength={CHANGE_NOTES_MAX_LENGTH}
                readOnly={readOnly}
                aria-describedby={`${ids}-notes-hint`}
                onChange={(event) => {
                  change({ changeNotes: event.target.value }, 'changeNotes');
                }}
              />
              <p id={`${ids}-notes-hint`} className="text-xs text-muted-foreground">
                {t('editor.changeNotesHint')}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SaveProblemAlert({
  problem,
  onReload,
  onRetry,
}: {
  readonly problem: SaveProblem;
  readonly onReload: () => void;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('templates');
  switch (problem.kind) {
    case 'conflict':
      return (
        <Alert tone="error" title={t('editor.conflict')}>
          <Button variant="secondary" size="sm" onClick={onReload}>
            {t('editor.reload')}
          </Button>
        </Alert>
      );
    case 'invalid':
      return <Alert tone="error" title={t('editor.invalid')} />;
    case 'notDraft':
      return <Alert tone="error" title={t('editor.notDraft')} />;
    case 'forbidden':
      return <Alert tone="error" title={t('editor.forbidden')} />;
    case 'unavailable':
      return (
        <Alert tone="error" title={t('editor.unavailable')}>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {t('editor.tryAgain')}
          </Button>
        </Alert>
      );
    case 'generic':
      return <Alert tone="error" title={problem.message} />;
  }
}

type EditorTab = 'content' | 'layout';

function EditorTabs({
  tab,
  onChange,
}: {
  readonly tab: EditorTab;
  readonly onChange: (tab: EditorTab) => void;
}) {
  const t = useTranslations('templates');
  const ids = useId();
  return (
    <div className="flex flex-col gap-3">
      <div
        role="tablist"
        aria-label={t('editor.tabs.label')}
        className="flex gap-2 border-b border-border"
      >
        {(['content', 'layout'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`${ids}-tab-${value}`}
            aria-selected={tab === value}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === value ? 'border-primary' : 'border-transparent text-muted-foreground'
            }`}
            onClick={() => {
              onChange(value);
            }}
          >
            {t(`editor.tabs.${value}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

function SectionList({
  drafts,
  selectedUid,
  readOnly,
  hasProblems,
  onSelect,
  onAdd,
  onMove,
  onDuplicate,
  onRemove,
}: {
  readonly drafts: readonly SectionDraft[];
  readonly selectedUid: string | null;
  readonly readOnly: boolean;
  readonly hasProblems: (draft: SectionDraft) => boolean;
  readonly onSelect: (uid: string) => void;
  readonly onAdd: () => void;
  readonly onMove: (from: number, to: number) => void;
  readonly onDuplicate: (uid: string) => void;
  readonly onRemove: (uid: string) => void;
}) {
  const t = useTranslations('templates');
  const dragFrom = useRef<number | null>(null);
  const label = (draft: SectionDraft) => draft.title.trim() || t('sections.untitled');

  return (
    <section aria-labelledby="template-sections-title" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="template-sections-title" className="text-lg font-semibold">
          {t('sections.title')}
        </h2>
        {readOnly ? null : (
          <Button size="sm" variant="secondary" onClick={onAdd}>
            {t('sections.add')}
          </Button>
        )}
      </div>
      {drafts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('sections.empty')}</p>
      ) : null}
      {readOnly || drafts.length < 2 ? null : (
        <p className="text-xs text-muted-foreground">{t('sections.dragHint')}</p>
      )}
      <ol aria-label={t('sections.listLabel')} className="flex flex-col gap-2">
        {drafts.map((draft, index) => (
          // Arrastar é atalho de mouse; o teclado usa os botões ↑/↓ da própria seção (FA-01).
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
          <li
            key={draft.uid}
            draggable={!readOnly}
            onDragStart={(event: DragEvent<HTMLLIElement>) => {
              dragFrom.current = index;
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(event) => {
              if (dragFrom.current !== null) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragFrom.current !== null) onMove(dragFrom.current, index);
              dragFrom.current = null;
            }}
            className={`rounded-card border p-2 ${
              draft.uid === selectedUid ? 'border-primary bg-muted' : 'border-border bg-surface'
            }`}
          >
            <button
              type="button"
              className="w-full text-left"
              aria-current={draft.uid === selectedUid ? 'true' : undefined}
              aria-label={t('sections.select', { title: label(draft) })}
              onClick={() => {
                onSelect(draft.uid);
              }}
            >
              <span className="block text-sm font-medium">
                {index + 1}. {label(draft)}
              </span>
              <span className="block font-mono text-xs text-muted-foreground">
                {draft.key.trim() || t('sections.noKey')}
                {hasProblems(draft) ? (
                  <span className="ml-2 font-sans text-destructive">
                    · {t('sections.hasErrors')}
                  </span>
                ) : null}
              </span>
            </button>
            {readOnly ? null : (
              <div className="mt-2 flex flex-wrap gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={index === 0}
                  aria-label={t('sections.moveUp', { title: label(draft) })}
                  onClick={() => {
                    onMove(index, index - 1);
                  }}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={index === drafts.length - 1}
                  aria-label={t('sections.moveDown', { title: label(draft) })}
                  onClick={() => {
                    onMove(index, index + 1);
                  }}
                >
                  ↓
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('sections.duplicate', { title: label(draft) })}
                  onClick={() => {
                    onDuplicate(draft.uid);
                  }}
                >
                  {t('sections.duplicateLabel')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('sections.remove', { title: label(draft) })}
                  onClick={() => {
                    onRemove(draft.uid);
                  }}
                >
                  {t('sections.removeLabel')}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function SectionEditorPanel({
  draft,
  position,
  type,
  readOnly,
  problems,
  violations,
  onChange,
}: {
  readonly draft: SectionDraft;
  readonly position: number;
  readonly type: TemplateTypeInfo;
  readonly readOnly: boolean;
  readonly problems: readonly LocalProblem[];
  readonly violations: readonly Violation[];
  readonly onChange: (patch: Partial<SectionDraft>) => void;
}) {
  const t = useTranslations('templates');
  const ids = useId();
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const renders = availableRenders(type);
  const errorOf = (field: DraftField) => problems.find((item) => item.field === field)?.message;
  const fieldId = (field: string) => `${ids}-${field}`;
  const describedBy = (field: DraftField, hint?: string) =>
    [errorOf(field) ? `${fieldId(field)}-error` : null, hint ?? null].filter(Boolean).join(' ') ||
    undefined;
  const errorText = (field: DraftField) => {
    const message = errorOf(field);
    return message ? (
      <p id={`${fieldId(field)}-error`} className="text-sm text-destructive">
        {message}
      </p>
    ) : null;
  };

  const text = (
    field: 'key' | 'title' | 'legalBasis',
    label: string,
    extra: { hint?: string; maxLength: number; placeholder?: string },
  ) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={fieldId(field)} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={fieldId(field)}
        className={field === 'key' ? `${INPUT} font-mono` : INPUT}
        value={draft[field]}
        maxLength={extra.maxLength}
        placeholder={extra.placeholder}
        readOnly={readOnly}
        aria-invalid={field !== 'legalBasis' && errorOf(field) ? true : undefined}
        aria-describedby={
          field === 'legalBasis'
            ? undefined
            : describedBy(field, extra.hint ? `${fieldId(field)}-hint` : undefined)
        }
        onChange={(event) => {
          onChange({
            [field]: field === 'key' ? event.target.value.toUpperCase() : event.target.value,
          });
        }}
      />
      {extra.hint ? (
        <p id={`${fieldId(field)}-hint`} className="text-xs text-muted-foreground">
          {extra.hint}
        </p>
      ) : null}
      {field === 'legalBasis' ? null : errorText(field)}
    </div>
  );

  return (
    <section
      aria-labelledby={`${ids}-heading`}
      className="flex flex-col gap-4 rounded-card border border-border bg-surface p-4 shadow-card"
    >
      <h2 id={`${ids}-heading`} className="text-lg font-semibold">
        {t('section.panelTitle', { position })}
      </h2>
      {violations.length > 0 ? (
        <Alert tone="error" title={t('editor.invalid')}>
          <ul className="list-disc pl-5">
            {violations.map((violation, index) => (
              <li key={`${violation.code}-${String(index)}`}>{violation.message}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {text('key', t('section.key'), { hint: t('section.keyHint'), maxLength: 60 })}
        {text('title', t('section.title'), { maxLength: 150 })}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={fieldId('requirement')} className="text-sm font-medium">
            {t('section.requirement')}
          </label>
          <select
            id={fieldId('requirement')}
            className={INPUT}
            value={draft.requirement}
            disabled={readOnly}
            onChange={(event) => {
              onChange({ requirement: event.target.value as SectionDraft['requirement'] });
            }}
          >
            {SECTION_REQUIREMENTS.map((requirement) => (
              <option key={requirement} value={requirement}>
                {t(`section.requirements.${requirement}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={fieldId('render')} className="text-sm font-medium">
            {t('section.render')}
          </label>
          <select
            id={fieldId('render')}
            className={INPUT}
            value={draft.render}
            disabled={readOnly || renders.length === 1}
            aria-invalid={errorOf('render') ? true : undefined}
            aria-describedby={describedBy('render')}
            onChange={(event) => {
              onChange({ render: event.target.value as SectionRender });
            }}
          >
            {(renders.includes(draft.render) ? renders : [draft.render, ...renders]).map(
              (render) => (
                <option key={render} value={render}>
                  {t(`section.renders.${render}`)}
                </option>
              ),
            )}
          </select>
          {errorText('render')}
        </div>
      </div>
      {draft.render === 'TEXT' ? null : (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.allowNarrative}
            disabled={readOnly}
            onChange={(event) => {
              onChange({ allowNarrative: event.target.checked });
            }}
          />
          {t('section.allowNarrative')}
        </label>
      )}
      {text('legalBasis', t('section.legalBasis'), {
        maxLength: 300,
        placeholder: t('section.legalBasisPlaceholder'),
      })}
      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId('helpText')} className="text-sm font-medium">
          {t('section.helpText')}
        </label>
        <textarea
          id={fieldId('helpText')}
          className={TEXTAREA}
          value={draft.helpText}
          maxLength={2000}
          readOnly={readOnly}
          aria-invalid={errorOf('helpText') ? true : undefined}
          aria-describedby={describedBy('helpText')}
          onChange={(event) => {
            onChange({ helpText: event.target.value });
          }}
        />
        {errorText('helpText')}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId('defaultContent')} className="text-sm font-medium">
          {t('section.defaultContent')}
        </label>
        <textarea
          id={fieldId('defaultContent')}
          ref={contentRef}
          className={`${TEXTAREA} min-h-32`}
          value={draft.defaultContent}
          readOnly={readOnly}
          aria-invalid={errorOf('defaultContent') ? true : undefined}
          aria-describedby={describedBy('defaultContent', `${fieldId('defaultContent')}-hint`)}
          onChange={(event) => {
            onChange({ defaultContent: event.target.value });
          }}
        />
        <p id={`${fieldId('defaultContent')}-hint`} className="text-xs text-muted-foreground">
          {t('section.defaultContentHint')}
        </p>
        {errorText('defaultContent')}
        {readOnly ? null : (
          <div role="group" aria-label={t('section.variables')} className="flex flex-wrap gap-1">
            {SECTION_TEMPLATE_VARIABLES.map((variable) => (
              <button
                key={variable}
                type="button"
                className="rounded-control border border-border px-2 py-0.5 font-mono text-xs hover:bg-muted"
                aria-label={t('section.insertVariable', { variable })}
                onClick={() => {
                  const element = contentRef.current;
                  const result = insertVariable(
                    draft.defaultContent,
                    variable,
                    element
                      ? { start: element.selectionStart, end: element.selectionEnd }
                      : undefined,
                  );
                  onChange({ defaultContent: result.text });
                  requestAnimationFrame(() => {
                    element?.focus();
                    element?.setSelectionRange(result.cursor, result.cursor);
                  });
                }}
              >
                {`{{${variable}}}`}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {(['minChars', 'maxChars'] as const).map((field) => (
          <div key={field} className="flex flex-col gap-1">
            <label htmlFor={fieldId(field)} className="text-sm font-medium">
              {t(`section.${field}`)}
            </label>
            <input
              id={fieldId(field)}
              type="number"
              inputMode="numeric"
              min={field === 'minChars' ? 0 : 1}
              className={INPUT}
              value={draft[field]}
              readOnly={readOnly}
              aria-invalid={errorOf(field) ? true : undefined}
              aria-describedby={describedBy(field)}
              onChange={(event) => {
                onChange({ [field]: event.target.value });
              }}
            />
            {errorText(field)}
          </div>
        ))}
      </div>
    </section>
  );
}

function FieldConfigPanel({
  fields,
  value,
  readOnly,
  onChange,
}: {
  readonly fields: readonly string[];
  readonly value: FieldConfig;
  readonly readOnly: boolean;
  readonly onChange: (value: FieldConfig) => void;
}) {
  const t = useTranslations('templates');
  const set = (field: string, patch: Partial<FieldConfig[string]>) => {
    const entry = { ...value[field], ...patch };
    const cleaned = Object.fromEntries(
      Object.entries(entry).filter(
        ([, item]) => item !== undefined && item !== '' && item !== false,
      ),
    );
    const others = Object.entries(value).filter(([key]) => key !== field);
    onChange(
      Object.fromEntries(
        Object.keys(cleaned).length === 0 ? others : [...others, [field, cleaned]],
      ),
    );
  };
  return (
    <section aria-labelledby="field-config-title" className="flex flex-col gap-2">
      <h2 id="field-config-title" className="text-lg font-semibold">
        {t('fieldConfig.title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('fieldConfig.description')}</p>
      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('fieldConfig.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-border">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="bg-muted text-xs text-muted-foreground uppercase">
              <tr>
                <th scope="col" className="px-3 py-2">
                  {t('fieldConfig.columns.field')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('fieldConfig.columns.label')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('fieldConfig.columns.required')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('fieldConfig.columns.defaultValue')}
                </th>
              </tr>
            </thead>
            <tbody>
              {fields.map((field) => {
                const entry = value[field] ?? {};
                return (
                  <tr key={field} className="border-t border-border">
                    <th scope="row" className="px-3 py-2 font-mono text-xs">
                      {field}
                    </th>
                    <td className="px-3 py-2">
                      <input
                        className={INPUT}
                        aria-label={t('fieldConfig.label', { field })}
                        value={entry.label ?? ''}
                        maxLength={150}
                        readOnly={readOnly}
                        onChange={(event) => {
                          set(field, { label: event.target.value });
                        }}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={t('fieldConfig.required', { field })}
                        checked={entry.required === true}
                        disabled={readOnly}
                        onChange={(event) => {
                          set(field, { required: event.target.checked });
                        }}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        className={INPUT}
                        aria-label={t('fieldConfig.defaultValue', { field })}
                        value={
                          typeof entry.defaultValue === 'string' ||
                          typeof entry.defaultValue === 'number'
                            ? String(entry.defaultValue)
                            : ''
                        }
                        readOnly={readOnly}
                        onChange={(event) => {
                          set(field, { defaultValue: event.target.value });
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ImportMappingsPanel({
  value,
  targets,
  sources,
  readOnly,
  onChange,
}: {
  readonly value: ImportMappings | null;
  readonly targets: readonly string[];
  readonly sources: readonly string[];
  readonly readOnly: boolean;
  readonly onChange: (value: ImportMappings | null) => void;
}) {
  const t = useTranslations('templates');
  const ids = useId();
  const updateMapping = (index: number, patch: Partial<ImportMappings['sections'][number]>) => {
    if (!value) return;
    onChange({
      ...value,
      sections: value.sections.map((mapping, position) =>
        position === index ? { ...mapping, ...patch } : mapping,
      ),
    });
  };
  return (
    <section aria-labelledby="import-mappings-title" className="flex flex-col gap-3">
      <h2 id="import-mappings-title" className="text-lg font-semibold">
        {t('importMappings.title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('importMappings.description')}</p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value !== null}
          disabled={readOnly}
          onChange={(event) => {
            onChange(event.target.checked ? structuredClone(DEFAULT_TR_IMPORT_MAPPINGS) : null);
          }}
        />
        {t('importMappings.enable')}
      </label>
      {value === null ? (
        <p className="text-sm text-muted-foreground">{t('importMappings.none')}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {value.sections.map((mapping, index) => {
              const targetLabel = mapping.target || t('importMappings.targetPlaceholder');
              const options =
                targets.includes(mapping.target) || mapping.target === ''
                  ? targets
                  : [mapping.target, ...targets];
              return (
                <li
                  key={`${String(index)}-${mapping.target}`}
                  className="rounded-card border border-border p-3"
                >
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_12rem_auto]">
                    <div className="flex flex-col gap-1">
                      <label
                        htmlFor={`${ids}-target-${String(index)}`}
                        className="text-sm font-medium"
                      >
                        {t('importMappings.target')}
                      </label>
                      <select
                        id={`${ids}-target-${String(index)}`}
                        className={INPUT}
                        value={mapping.target}
                        disabled={readOnly}
                        onChange={(event) => {
                          updateMapping(index, { target: event.target.value });
                        }}
                      >
                        <option value="">{t('importMappings.targetPlaceholder')}</option>
                        {options.map((key) => (
                          <option key={key} value={key}>
                            {key}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label
                        htmlFor={`${ids}-mode-${String(index)}`}
                        className="text-sm font-medium"
                      >
                        {t('importMappings.mode', { target: targetLabel })}
                      </label>
                      <select
                        id={`${ids}-mode-${String(index)}`}
                        className={INPUT}
                        value={mapping.mode}
                        disabled={readOnly}
                        onChange={(event) => {
                          updateMapping(index, {
                            mode: event.target.value as 'REPLACE' | 'APPEND',
                          });
                        }}
                      >
                        {(['REPLACE', 'APPEND'] as const).map((mode) => (
                          <option key={mode} value={mode}>
                            {t(`importMappings.modes.${mode}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                    {readOnly ? null : (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t('importMappings.remove', { target: targetLabel })}
                        onClick={() => {
                          onChange({
                            ...value,
                            sections: value.sections.filter((_, position) => position !== index),
                          });
                        }}
                      >
                        {t('importMappings.removeLabel')}
                      </Button>
                    )}
                  </div>
                  <fieldset className="mt-2">
                    <legend className="text-sm font-medium">
                      {t('importMappings.sources', { target: targetLabel })}
                    </legend>
                    <div className="mt-1 flex flex-wrap gap-3">
                      {[...new Set([...sources, ...mapping.sources])].map((source) => (
                        <label key={source} className="flex items-center gap-1 font-mono text-xs">
                          <input
                            type="checkbox"
                            checked={mapping.sources.includes(source)}
                            disabled={readOnly}
                            onChange={(event) => {
                              updateMapping(index, {
                                sources: event.target.checked
                                  ? [...mapping.sources, source]
                                  : mapping.sources.filter((item) => item !== source),
                              });
                            }}
                          />
                          {source}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </li>
              );
            })}
          </ul>
          {readOnly ? null : (
            <div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  onChange({
                    ...value,
                    sections: [...value.sections, { target: '', sources: [], mode: 'REPLACE' }],
                  });
                }}
              >
                {t('importMappings.add')}
              </Button>
            </div>
          )}
          {(['copyQuantities', 'copyCalculationMemoToNotes'] as const).map((item) => (
            <label key={item} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={value.items[item]}
                disabled={readOnly}
                onChange={(event) => {
                  onChange({ ...value, items: { ...value.items, [item]: event.target.checked } });
                }}
              />
              {t(`importMappings.${item}`)}
            </label>
          ))}
          <p className="text-xs text-muted-foreground">
            {t('importMappings.fields', {
              fields:
                value.fields.map((field) => `${field.target} ← ${field.source}`).join(', ') || '—',
            })}
          </p>
        </>
      )}
    </section>
  );
}
