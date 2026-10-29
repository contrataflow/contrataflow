'use client';

import {
  Alert,
  Button,
  Checkbox,
  ChevronUp,
  ChevronDown,
  DetailPage,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Ellipsis,
  Field,
  FormActionBar,
  InfoTooltip,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StatusChip,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@contrataflow/ui';
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
  TemplateVersionHistoryItem,
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
import { PublishConfirmDialog } from './template-versions-view';
import {
  fetchTemplateVersion,
  templateKeys,
  TEMPLATES_PATH,
  TEMPLATES_STALE_TIME_MS,
  templateVersionsHref,
  updateTemplateVersion,
} from './templates.api';

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

  if (version.data) {
    return (
      <TemplateEditor
        key={`${version.data.id}:${String(generation)}`}
        version={version.data}
        onReload={() => {
          void version.refetch().then(() => {
            setGeneration((value) => value + 1);
          });
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link href={TEMPLATES_PATH}>{t('editor.back')}</Link>
        </Button>
      </div>
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
  const tShell = useTranslations('shell');
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
    // Remonta junto com a aba "Conteúdo": o contêiner é outro a cada vez que ela abre.
  }, [tab]);

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

  const canPublish = usePermission('TEMPLATE_PUBLISH').allowed;
  const [publishing, setPublishing] = useState(false);
  const showSave = !readOnly && tab === 'content';
  const showPublish = canPublish && isDraft;
  // Item do histórico montado a partir da versão aberta (a `version` é o `If-Match` da publicação).
  const publishItem: TemplateVersionHistoryItem = {
    id: version.id,
    templateId: version.templateId,
    versionNumber: version.versionNumber,
    status: version.status,
    sectionCount: state.drafts.length,
    changeNotes: version.changeNotes,
    isCurrent: false,
    publishedAt: version.publishedAt,
    retiredAt: version.retiredAt,
    contentHash: version.contentHash,
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
    version: revision,
  };

  return (
    <DetailPage
      breadcrumbs={[
        { label: tShell('admin.title'), href: '/admin' },
        { label: t('title'), href: TEMPLATES_PATH },
        { label: version.templateName, href: templateVersionsHref(version.templateId) },
        { label: t('versions.number', { number: version.versionNumber }) },
      ]}
      breadcrumbLabel={t('editor.breadcrumbLabel')}
      linkComponent={Link}
      title={t('editor.heading', { name: version.templateName, number: version.versionNumber })}
      status={
        <StatusChip
          tone={
            version.status === 'PUBLISHED'
              ? 'success'
              : version.status === 'DRAFT'
                ? 'info'
                : 'neutral'
          }
        >
          {t(`editor.status.${version.status}`)}
        </StatusChip>
      }
      subtitle={version.documentType.name}
      notices={
        <div className="flex flex-col gap-3 empty:hidden">
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
            <SaveProblemAlert
              problem={problem}
              onReload={onReload}
              onRetry={() => void runSave()}
            />
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
        </div>
      }
    >
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value === 'layout' ? 'layout' : 'content');
        }}
        className="min-w-0"
      >
        <TabsList aria-label={t('editor.tabs.label')}>
          <TabsTrigger value="content">{t('editor.tabs.content')}</TabsTrigger>
          <TabsTrigger value="layout">{t('editor.tabs.layout')}</TabsTrigger>
        </TabsList>
        <TabsContent value="layout" className="min-w-0">
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
        </TabsContent>
        <TabsContent value="content" className="min-w-0">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)]">
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
            <div ref={fieldsRef} className="flex min-w-0 flex-col gap-5">
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
                <p className="rounded-card bg-surface p-6 text-sm text-muted-foreground shadow-card">
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
                  targets={state.drafts
                    .map((draft) => draft.key.trim())
                    .filter((key) => key !== '')}
                  sources={version.importSources?.sectionKeys ?? []}
                  readOnly={readOnly}
                  onChange={(importMappings) => {
                    change({ importMappings }, 'importMappings');
                  }}
                />
              ) : null}

              <section className="rounded-card bg-surface p-5 shadow-card">
                <Field
                  label={t('editor.changeNotes')}
                  labelAddon={
                    <InfoTooltip label={t('help', { field: t('editor.changeNotes') })}>
                      {t('editor.changeNotesHint')}
                    </InfoTooltip>
                  }
                >
                  <Textarea
                    value={state.changeNotes}
                    maxLength={CHANGE_NOTES_MAX_LENGTH}
                    readOnly={readOnly}
                    onChange={(event) => {
                      change({ changeNotes: event.target.value }, 'changeNotes');
                    }}
                  />
                </Field>
              </section>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      {showSave || showPublish ? (
        <FormActionBar
          label={t('editor.actionsLabel')}
          status={
            showSave ? (
              <span className="text-muted-foreground" aria-hidden="true">
                {saveLabel}
              </span>
            ) : null
          }
        >
          {showSave ? (
            <Button
              variant={showPublish ? 'secondary' : undefined}
              disabled={!isDirty || save.isPending || blocked}
              aria-busy={save.isPending}
              onClick={() => {
                void runSave();
              }}
            >
              {t('editor.save')}
            </Button>
          ) : null}
          {showPublish ? (
            <Button
              disabled={isDirty || save.isPending || blocked}
              onClick={() => {
                setPublishing(true);
              }}
            >
              {t('versions.actions.publishLabel')}
            </Button>
          ) : null}
        </FormActionBar>
      ) : null}

      <PublishConfirmDialog
        templateId={version.templateId}
        item={publishing ? publishItem : null}
        onClose={() => {
          setPublishing(false);
        }}
        onDone={() => {
          void queryClient.invalidateQueries({ queryKey: templateKeys.all(tenantId) });
          onReload();
        }}
      />
    </DetailPage>
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
    <section
      aria-labelledby="template-sections-title"
      className="flex flex-col gap-3 self-start rounded-card bg-surface p-5 shadow-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="template-sections-title" className="text-section-title text-brand-ink">
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
            className={`flex flex-wrap items-center gap-1 rounded-control border p-2 ${
              draft.uid === selectedUid
                ? 'border-primary bg-primary-soft'
                : 'border-border bg-surface'
            }`}
          >
            <button
              type="button"
              className="min-w-0 flex-[1_1_8rem] rounded-control text-left"
              aria-current={draft.uid === selectedUid ? 'true' : undefined}
              aria-label={t('sections.select', { title: label(draft) })}
              onClick={() => {
                onSelect(draft.uid);
              }}
            >
              <span className="block text-sm font-bold break-words">
                {index + 1}. {label(draft)}
              </span>
              <span className="block font-mono text-xs break-words text-muted-foreground">
                {draft.key.trim() || t('sections.noKey')}
                {hasProblems(draft) ? (
                  <span className="ml-2 font-sans text-destructive">
                    · {t('sections.hasErrors')}
                  </span>
                ) : null}
              </span>
            </button>
            {readOnly ? null : (
              <div className="flex flex-none items-center">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={index === 0}
                  aria-label={t('sections.moveUp', { title: label(draft) })}
                  onClick={() => {
                    onMove(index, index - 1);
                  }}
                >
                  <ChevronUp />
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
                  <ChevronDown />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t('sections.menu', { title: label(draft) })}
                    >
                      <Ellipsis />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => {
                        onDuplicate(draft.uid);
                      }}
                    >
                      {t('sections.duplicateLabel')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => {
                        onRemove(draft.uid);
                      }}
                    >
                      {t('sections.removeLabel')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
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
  const narrativeId = `${ids}-narrative`;
  const renders = availableRenders(type);
  const errorOf = (field: DraftField) => problems.find((item) => item.field === field)?.message;
  const help = (field: string, text: string) => (
    <InfoTooltip label={t('help', { field })}>{text}</InfoTooltip>
  );

  return (
    <section
      aria-labelledby={`${ids}-heading`}
      className="flex flex-col gap-4 rounded-card bg-surface p-5 shadow-card"
    >
      <h2 id={`${ids}-heading`} className="text-section-title text-brand-ink">
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
        <Field
          label={t('section.key')}
          error={errorOf('key')}
          labelAddon={help(t('section.key'), t('section.keyHint'))}
        >
          <Input
            className="font-mono"
            value={draft.key}
            maxLength={60}
            readOnly={readOnly}
            onChange={(event) => {
              onChange({ key: event.target.value.toUpperCase() });
            }}
          />
        </Field>
        <Field label={t('section.title')} error={errorOf('title')}>
          <Input
            value={draft.title}
            maxLength={150}
            readOnly={readOnly}
            onChange={(event) => {
              onChange({ title: event.target.value });
            }}
          />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label={t('section.requirement')}>
          <Select
            value={draft.requirement}
            disabled={readOnly}
            onValueChange={(value) => {
              onChange({ requirement: value as SectionDraft['requirement'] });
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SECTION_REQUIREMENTS.map((requirement) => (
                <SelectItem key={requirement} value={requirement}>
                  {t(`section.requirements.${requirement}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('section.render')} error={errorOf('render')}>
          <Select
            value={draft.render}
            disabled={readOnly || renders.length === 1}
            onValueChange={(value) => {
              onChange({ render: value as SectionRender });
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(renders.includes(draft.render) ? renders : [draft.render, ...renders]).map(
                (render) => (
                  <SelectItem key={render} value={render}>
                    {t(`section.renders.${render}`)}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </Field>
      </div>
      {draft.render === 'TEXT' ? null : (
        <div className="flex items-center gap-3">
          <Checkbox
            id={narrativeId}
            checked={draft.allowNarrative}
            disabled={readOnly}
            onCheckedChange={(checked) => {
              onChange({ allowNarrative: checked === true });
            }}
          />
          <Label htmlFor={narrativeId} className="font-normal">
            {t('section.allowNarrative')}
          </Label>
        </div>
      )}
      <Field label={t('section.legalBasis')}>
        <Input
          value={draft.legalBasis}
          maxLength={300}
          placeholder={t('section.legalBasisPlaceholder')}
          readOnly={readOnly}
          onChange={(event) => {
            onChange({ legalBasis: event.target.value });
          }}
        />
      </Field>
      <Field label={t('section.helpText')} error={errorOf('helpText')}>
        <Textarea
          value={draft.helpText}
          maxLength={2000}
          readOnly={readOnly}
          onChange={(event) => {
            onChange({ helpText: event.target.value });
          }}
        />
      </Field>
      <div className="flex flex-col gap-2">
        <Field
          label={t('section.defaultContent')}
          error={errorOf('defaultContent')}
          labelAddon={help(t('section.defaultContent'), t('section.defaultContentHint'))}
        >
          <Textarea
            ref={contentRef}
            rows={6}
            value={draft.defaultContent}
            readOnly={readOnly}
            onChange={(event) => {
              onChange({ defaultContent: event.target.value });
            }}
          />
        </Field>
        {readOnly ? null : (
          <div role="group" aria-label={t('section.variables')} className="flex flex-wrap gap-1.5">
            {SECTION_TEMPLATE_VARIABLES.map((variable) => (
              <Button
                key={variable}
                type="button"
                variant="secondary"
                size="sm"
                className="font-mono text-xs"
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
              </Button>
            ))}
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {(['minChars', 'maxChars'] as const).map((field) => (
          <Field key={field} label={t(`section.${field}`)} error={errorOf(field)}>
            <Input
              type="number"
              inputMode="numeric"
              min={field === 'minChars' ? 0 : 1}
              value={draft[field]}
              readOnly={readOnly}
              onChange={(event) => {
                onChange({ [field]: event.target.value });
              }}
            />
          </Field>
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
    <section
      aria-labelledby="field-config-title"
      className="flex flex-col gap-3 rounded-card bg-surface p-5 shadow-card"
    >
      <div className="flex flex-col gap-1">
        <h2 id="field-config-title" className="text-section-title text-brand-ink">
          {t('fieldConfig.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('fieldConfig.description')}</p>
      </div>
      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('fieldConfig.empty')}</p>
      ) : (
        // Lista em grade, não tabela: cabe na coluna do editor sem rolagem própria (prd-5 · regra 8).
        <div className="flex flex-col">
          <div
            aria-hidden="true"
            className="hidden gap-3 border-b border-border pb-2 text-label font-semibold text-muted-foreground uppercase sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
          >
            <span>{t('fieldConfig.columns.label')}</span>
            <span>{t('fieldConfig.columns.defaultValue')}</span>
            <span>{t('fieldConfig.columns.required')}</span>
          </div>
          <ul aria-label={t('fieldConfig.title')} className="flex flex-col divide-y divide-border">
            {fields.map((field) => {
              const entry = value[field] ?? {};
              return (
                <li
                  key={field}
                  className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center sm:gap-x-3"
                >
                  <span className="font-mono text-xs text-muted-foreground sm:col-span-3">
                    {field}
                  </span>
                  <Input
                    aria-label={t('fieldConfig.label', { field })}
                    value={entry.label ?? ''}
                    maxLength={150}
                    readOnly={readOnly}
                    onChange={(event) => {
                      set(field, { label: event.target.value });
                    }}
                  />
                  <Input
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
                  <span className="flex items-center gap-2 text-sm">
                    <Checkbox
                      aria-label={t('fieldConfig.required', { field })}
                      checked={entry.required === true}
                      disabled={readOnly}
                      onCheckedChange={(checked) => {
                        set(field, { required: checked === true });
                      }}
                    />
                    <span aria-hidden="true" className="sm:hidden">
                      {t('fieldConfig.columns.required')}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
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
  const enableId = `${ids}-enable`;
  return (
    <section
      aria-labelledby="import-mappings-title"
      className="flex flex-col gap-4 rounded-card bg-surface p-5 shadow-card"
    >
      <div className="flex flex-col gap-1">
        <h2 id="import-mappings-title" className="text-section-title text-brand-ink">
          {t('importMappings.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('importMappings.description')}</p>
      </div>
      <div className="flex items-center gap-3">
        <Checkbox
          id={enableId}
          checked={value !== null}
          disabled={readOnly}
          onCheckedChange={(checked) => {
            onChange(checked === true ? structuredClone(DEFAULT_TR_IMPORT_MAPPINGS) : null);
          }}
        />
        <Label htmlFor={enableId} className="font-normal">
          {t('importMappings.enable')}
        </Label>
      </div>
      {value === null ? (
        <p className="text-sm text-muted-foreground">{t('importMappings.none')}</p>
      ) : (
        <>
          <ul className="flex flex-col">
            {value.sections.map((mapping, index) => {
              const targetLabel = mapping.target || t('importMappings.targetPlaceholder');
              const options =
                targets.includes(mapping.target) || mapping.target === ''
                  ? targets
                  : [mapping.target, ...targets];
              return (
                <li
                  key={`${String(index)}-${mapping.target}`}
                  className="flex flex-col gap-3 border-t border-border py-4 first:border-t-0 first:pt-0"
                >
                  <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-[1fr_12rem_auto]">
                    <Field label={t('importMappings.target')}>
                      <Select
                        value={mapping.target}
                        disabled={readOnly}
                        onValueChange={(target) => {
                          updateMapping(index, { target });
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={t('importMappings.targetPlaceholder')} />
                        </SelectTrigger>
                        <SelectContent>
                          {options.map((key) => (
                            <SelectItem key={key} value={key}>
                              {key}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label={t('importMappings.mode', { target: targetLabel })}>
                      <Select
                        value={mapping.mode}
                        disabled={readOnly}
                        onValueChange={(mode) => {
                          updateMapping(index, { mode: mode as 'REPLACE' | 'APPEND' });
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(['REPLACE', 'APPEND'] as const).map((mode) => (
                            <SelectItem key={mode} value={mode}>
                              {t(`importMappings.modes.${mode}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    {readOnly ? null : (
                      <Button
                        variant="ghost"
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
                  <Field group label={t('importMappings.sources', { target: targetLabel })}>
                    <div className="flex flex-wrap gap-x-5 gap-y-2">
                      {[...new Set([...sources, ...mapping.sources])].map((source) => {
                        const sourceId = `${ids}-${String(index)}-${source}`;
                        return (
                          <div key={source} className="flex items-center gap-2">
                            <Checkbox
                              id={sourceId}
                              checked={mapping.sources.includes(source)}
                              disabled={readOnly}
                              onCheckedChange={(checked) => {
                                updateMapping(index, {
                                  sources:
                                    checked === true
                                      ? [...mapping.sources, source]
                                      : mapping.sources.filter((item) => item !== source),
                                });
                              }}
                            />
                            <Label htmlFor={sourceId} className="font-mono text-xs font-normal">
                              {source}
                            </Label>
                          </div>
                        );
                      })}
                    </div>
                  </Field>
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
          {(['copyQuantities', 'copyCalculationMemoToNotes'] as const).map((item) => {
            const itemId = `${ids}-${item}`;
            return (
              <div key={item} className="flex items-center gap-3">
                <Checkbox
                  id={itemId}
                  checked={value.items[item]}
                  disabled={readOnly}
                  onCheckedChange={(checked) => {
                    onChange({ ...value, items: { ...value.items, [item]: checked === true } });
                  }}
                />
                <Label htmlFor={itemId} className="font-normal">
                  {t(`importMappings.${item}`)}
                </Label>
              </div>
            );
          })}
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
