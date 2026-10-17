'use client';

import { Alert, Button } from '@contrataflow/ui';
import {
  LAYOUT_LIMITS,
  LAYOUT_TEMPLATE_VARIABLES,
  TEMPLATE_FONT_FAMILIES,
  TEMPLATE_LAYOUT_ORIENTATIONS,
  TEMPLATE_LOGO_POSITIONS,
  TEMPLATE_PREVIEW_IN_PROGRESS,
  TEMPLATE_PREVIEW_TTL_HOURS,
} from '@contrataflow/validation';
import type {
  LayoutUpdateInput,
  TemplateLogoPosition,
  TemplatePreviewDto,
  TemplateVersionDto,
} from '@contrataflow/validation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useTenantId } from '@/lib/session/session-context';

import { insertVariable } from './template-editor-model';
import {
  LAYOUT_SIDES,
  layoutFieldErrors,
  layoutPatch,
  layoutProblems,
  toLayoutForm,
} from './template-layout-model';
import type { LayoutField, LayoutForm, LayoutProblem } from './template-layout-model';
import {
  fetchTemplatePreview,
  fetchTemplatePreviewDownload,
  requestTemplatePreview,
  TEMPLATE_PREVIEW_POLL_MS,
  templateKeys,
  updateTemplateVersion,
} from './templates.api';
import { startAttachmentDownload } from '../attachments/attachments.api';
import { useAttachmentUploads } from '../attachments/use-attachment-uploads';

const INPUT = 'h-10 w-full rounded-control border border-border bg-surface px-3 text-sm';
const TEXTAREA =
  'min-h-20 w-full rounded-control border border-border bg-surface px-3 py-2 text-sm';
const LOGO_ACCEPT = 'image/png,image/jpeg,image/svg+xml';

type SaveProblem =
  'conflict' | 'invalid' | 'notDraft' | 'forbidden' | 'logoInvalid' | 'unavailable' | 'generic';

/**
 * Aba "Layout" de SCR-114 (US-109): `LayoutFormPanel` (orientação, margens, fonte, tamanho e
 * entrelinha), `HeaderFooterEditor` (texto com o seletor de variáveis — o catálogo completo, com
 * `page`/`pages`/`document.hash`), `LogoUploader` (upload genérico de anexos, `TENANT_ASSET`) e
 * `PreviewButton` + `PreviewViewer` (TPL-09 → *polling* de TPL-12 → download de TPL-13). Salva por
 * TPL-08 ao sair do formulário, com o `If-Match` compartilhado com a aba "Conteúdo". Sem
 * `TEMPLATE_MANAGE` (ou versão publicada) o formulário fica somente leitura e a prévia continua.
 */
export function TemplateLayoutTab({
  version,
  revision,
  readOnly,
  onSaved,
  onReload,
}: {
  readonly version: TemplateVersionDto;
  readonly revision: number;
  readonly readOnly: boolean;
  readonly onSaved: (saved: TemplateVersionDto) => void;
  readonly onReload: () => void;
}) {
  const t = useTranslations('templates.layout');
  const ids = useId();
  const [saved, setSaved] = useState(version.layout);
  const [form, setForm] = useState<LayoutForm>(() => toLayoutForm(version.layout));
  const [problem, setProblem] = useState<SaveProblem | null>(null);
  const [serverErrors, setServerErrors] = useState<LayoutProblem[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const latest = useRef({ form, saved, revision });
  useEffect(() => {
    latest.current = { form, saved, revision };
  });

  const problems = [...layoutProblems(form), ...serverErrors];
  const errorOf = (field: LayoutField) => problems.find((item) => item.field === field)?.message;

  const save = useMutation({
    mutationFn: (input: { layout: LayoutUpdateInput; revision: number }) =>
      updateTemplateVersion(version.id, { layout: input.layout }, input.revision),
  });

  const runSave = async (next: LayoutForm = latest.current.form) => {
    const { saved: current, revision: expected } = latest.current;
    if (readOnly || save.isPending || layoutProblems(next).length > 0) return;
    const patch = layoutPatch(current, next);
    if (Object.keys(patch).length === 0) return;
    try {
      const result = await save.mutateAsync({ layout: patch, revision: expected });
      setSaved(result.data.layout);
      setProblem(null);
      setServerErrors([]);
      setAnnouncement(t('saved'));
      onSaved(result.data);
    } catch (error) {
      if (!isApiError(error)) {
        setProblem('generic');
        return;
      }
      if (error.code === 'VERSION_CONFLICT') setProblem('conflict');
      else if (error.code === 'TEMPLATE_INVALID') {
        setProblem('invalid');
        setServerErrors(
          error.violations.flatMap((violation) =>
            violation.field === 'layout.header' || violation.field === 'layout.footer'
              ? [
                  {
                    field: violation.field === 'layout.header' ? 'header' : 'footer',
                    message: violation.message,
                  } as const,
                ]
              : [],
          ),
        );
      } else if (error.code === 'TEMPLATE_VERSION_NOT_DRAFT') setProblem('notDraft');
      else if (error.code === 'ATTACHMENT_NOT_AVAILABLE') setProblem('logoInvalid');
      else if (error.code === 'VALIDATION_ERROR') {
        const fields = layoutFieldErrors(error.errors);
        setServerErrors(fields);
        setProblem(
          error.errors.some((item) => item.field === 'layout.logo.attachmentId')
            ? 'logoInvalid'
            : 'invalid',
        );
      } else if (error.status === 403) setProblem('forbidden');
      else if (error.status === 503) setProblem('unavailable');
      else setProblem('generic');
    }
  };

  const update = (patch: Partial<LayoutForm>) => {
    setServerErrors([]);
    setForm((now) => ({ ...now, ...patch }));
  };
  /** Seleções e interruptores salvam na hora; campos de texto, ao sair do formulário. */
  const commit = (patch: Partial<LayoutForm>) => {
    const next = { ...latest.current.form, ...patch };
    update(patch);
    void runSave(next);
  };

  const formRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef(runSave);
  useEffect(() => {
    saveRef.current = runSave;
  });
  useEffect(() => {
    const container = formRef.current;
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

  const fieldId = (name: string) => `${ids}-${name}`;
  const describedBy = (field: LayoutField, hint?: string) =>
    [errorOf(field) ? `${fieldId(field)}-error` : null, hint ?? null]
      .filter((value): value is string => value !== null)
      .join(' ') || undefined;
  const errorText = (field: LayoutField) => {
    const message = errorOf(field);
    return message ? (
      <p id={`${fieldId(field)}-error`} className="text-error text-xs">
        {message}
      </p>
    ) : null;
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="sr-only" aria-live="polite" role="status">
        {announcement}
      </p>
      {problem ? (
        <Alert tone="error" title={t(`problems.${problem}`)}>
          {problem === 'conflict' ? (
            <Button variant="secondary" size="sm" onClick={onReload}>
              {t('reload')}
            </Button>
          ) : problem === 'unavailable' ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void runSave();
              }}
            >
              {t('tryAgain')}
            </Button>
          ) : null}
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]">
        <div ref={formRef} className="flex min-w-0 flex-col gap-6">
          <fieldset className="flex flex-col gap-4" disabled={readOnly}>
            <legend className="text-lg font-semibold">{t('page.title')}</legend>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-1">
                <label htmlFor={fieldId('orientation')} className="text-sm font-medium">
                  {t('page.orientation')}
                </label>
                <select
                  id={fieldId('orientation')}
                  className={INPUT}
                  value={form.orientation}
                  onChange={(event) => {
                    commit({ orientation: event.target.value as LayoutForm['orientation'] });
                  }}
                >
                  {TEMPLATE_LAYOUT_ORIENTATIONS.map((value) => (
                    <option key={value} value={value}>
                      {t(`page.orientations.${value}`)}
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-sm text-muted-foreground md:self-end">{t('page.size')}</p>
            </div>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {LAYOUT_SIDES.map((side) => {
                const field = `margins.${side}` as const;
                return (
                  <div key={side} className="flex flex-col gap-1">
                    <label htmlFor={fieldId(field)} className="text-sm font-medium">
                      {t(`page.margins.${side}`)}
                    </label>
                    <input
                      id={fieldId(field)}
                      className={INPUT}
                      inputMode="decimal"
                      value={form.margins[side]}
                      aria-invalid={errorOf(field) ? true : undefined}
                      aria-describedby={describedBy(field)}
                      onChange={(event) => {
                        update({ margins: { ...form.margins, [side]: event.target.value } });
                      }}
                    />
                    {errorText(field)}
                  </div>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-4" disabled={readOnly}>
            <legend className="text-lg font-semibold">{t('typography.title')}</legend>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="flex flex-col gap-1">
                <label htmlFor={fieldId('font')} className="text-sm font-medium">
                  {t('typography.fontFamily')}
                </label>
                <select
                  id={fieldId('font')}
                  className={INPUT}
                  value={form.fontFamily}
                  onChange={(event) => {
                    commit({ fontFamily: event.target.value as LayoutForm['fontFamily'] });
                  }}
                >
                  {TEMPLATE_FONT_FAMILIES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={fieldId('fontSizePt')} className="text-sm font-medium">
                  {t('typography.fontSize')}
                </label>
                <input
                  id={fieldId('fontSizePt')}
                  className={INPUT}
                  inputMode="decimal"
                  value={form.fontSizePt}
                  aria-invalid={errorOf('fontSizePt') ? true : undefined}
                  aria-describedby={describedBy('fontSizePt')}
                  onChange={(event) => {
                    update({ fontSizePt: event.target.value });
                  }}
                />
                {errorText('fontSizePt')}
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={fieldId('lineHeight')} className="text-sm font-medium">
                  {t('typography.lineHeight')}
                </label>
                <input
                  id={fieldId('lineHeight')}
                  className={INPUT}
                  inputMode="decimal"
                  value={form.lineHeight}
                  aria-invalid={errorOf('lineHeight') ? true : undefined}
                  aria-describedby={describedBy('lineHeight')}
                  onChange={(event) => {
                    update({ lineHeight: event.target.value });
                  }}
                />
                {errorText('lineHeight')}
              </div>
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-4" disabled={readOnly}>
            <legend className="text-lg font-semibold">{t('headerFooter.title')}</legend>
            {(['header', 'footer'] as const).map((field) => (
              <HeaderFooterEditor
                key={field}
                id={fieldId(field)}
                label={t(`headerFooter.${field}`)}
                value={form[field]}
                readOnly={readOnly}
                error={errorText(field)}
                describedBy={describedBy(field, `${fieldId(field)}-hint`)}
                invalid={errorOf(field) !== undefined}
                onChange={(value) => {
                  update({ [field]: value });
                }}
              />
            ))}
            <div className="flex flex-col gap-2">
              {(['showPageNumbers', 'showDocumentHashInFooter', 'draftWatermark'] as const).map(
                (flag) => (
                  <label key={flag} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      role="switch"
                      checked={form[flag]}
                      onChange={(event) => {
                        commit({ [flag]: event.target.checked });
                      }}
                    />
                    {t(`headerFooter.${flag}`)}
                  </label>
                ),
              )}
              <p className="text-xs text-muted-foreground">{t('headerFooter.hashHint')}</p>
            </div>
          </fieldset>

          <LogoUploader
            versionId={version.id}
            form={form}
            readOnly={readOnly}
            heightError={errorText('logoMaxHeightMm')}
            heightInvalid={errorOf('logoMaxHeightMm') !== undefined}
            heightDescribedBy={describedBy('logoMaxHeightMm')}
            onChange={update}
            onCommit={commit}
          />
        </div>

        <PreviewPanel
          versionId={version.id}
          revision={revision}
          dirty={Object.keys(layoutPatch(saved, form)).length > 0}
        />
      </div>
    </div>
  );
}

function HeaderFooterEditor({
  id,
  label,
  value,
  readOnly,
  error,
  invalid,
  describedBy,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly readOnly: boolean;
  readonly error: ReactNode;
  readonly invalid: boolean;
  readonly describedBy: string | undefined;
  readonly onChange: (value: string) => void;
}) {
  const t = useTranslations('templates.layout.headerFooter');
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        ref={ref}
        className={TEXTAREA}
        value={value}
        readOnly={readOnly}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {t('hint')}
      </p>
      {error}
      {readOnly ? null : (
        <div
          role="group"
          aria-label={t('variables', { field: label })}
          className="flex flex-wrap gap-1"
        >
          {LAYOUT_TEMPLATE_VARIABLES.map((variable) => (
            <button
              key={variable}
              type="button"
              className="rounded-control border border-border px-2 py-0.5 font-mono text-xs hover:bg-muted"
              aria-label={t('insertVariable', { variable, field: label })}
              onClick={() => {
                const element = ref.current;
                const result = insertVariable(
                  value,
                  variable,
                  element
                    ? { start: element.selectionStart, end: element.selectionEnd }
                    : undefined,
                );
                onChange(result.text);
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
  );
}

function LogoUploader({
  versionId,
  form,
  readOnly,
  heightError,
  heightInvalid,
  heightDescribedBy,
  onChange,
  onCommit,
}: {
  readonly versionId: string;
  readonly form: LayoutForm;
  readonly readOnly: boolean;
  readonly heightError: ReactNode;
  readonly heightInvalid: boolean;
  readonly heightDescribedBy: string | undefined;
  readonly onChange: (patch: Partial<LayoutForm>) => void;
  readonly onCommit: (patch: Partial<LayoutForm>) => void;
}) {
  const t = useTranslations('templates.layout.logo');
  const ids = useId();
  const uploads = useAttachmentUploads({ targetType: 'TENANT_ASSET', targetId: versionId });
  const adopted = useRef(new Set<string>());
  const latestUpload = uploads.items.at(-1);

  // Logo enviado e liberado pela varredura: passa a ser o timbre do layout (salva na hora).
  useEffect(() => {
    const attachment = latestUpload?.attachment;
    if (latestUpload?.phase !== 'available' || !attachment) return;
    if (adopted.current.has(attachment.id)) return;
    adopted.current.add(attachment.id);
    onCommit({ logoAttachmentId: attachment.id });
  }, [latestUpload, onCommit]);

  const uploadState = latestUpload
    ? latestUpload.phase === 'uploading' || latestUpload.phase === 'scanning'
      ? t('uploading')
      : latestUpload.phase === 'rejected' || latestUpload.phase === 'failed'
        ? t('uploadFailed')
        : null
    : null;

  return (
    <fieldset className="flex flex-col gap-4" disabled={readOnly}>
      <legend className="text-lg font-semibold">{t('title')}</legend>
      <p className="text-sm text-muted-foreground">
        {form.logoAttachmentId === null ? t('none') : t('current')}
      </p>
      {uploadState ? (
        <p className="text-sm" role="status">
          {uploadState}
        </p>
      ) : null}
      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor={`${ids}-file`}
            className="inline-flex h-9 cursor-pointer items-center rounded-control border border-border px-3 text-sm font-medium hover:bg-muted"
          >
            {form.logoAttachmentId === null ? t('upload') : t('replace')}
          </label>
          <input
            id={`${ids}-file`}
            type="file"
            accept={LOGO_ACCEPT}
            className="sr-only"
            onChange={(event) => {
              uploads.add([...(event.target.files ?? [])]);
              event.target.value = '';
            }}
          />
          {form.logoAttachmentId === null ? null : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                onCommit({ logoAttachmentId: null });
              }}
            >
              {t('remove')}
            </Button>
          )}
        </div>
      )}
      {form.logoAttachmentId === null ? null : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${ids}-position`} className="text-sm font-medium">
              {t('position')}
            </label>
            <select
              id={`${ids}-position`}
              className={INPUT}
              value={form.logoPosition}
              onChange={(event) => {
                onCommit({ logoPosition: event.target.value as TemplateLogoPosition });
              }}
            >
              {TEMPLATE_LOGO_POSITIONS.map((value) => (
                <option key={value} value={value}>
                  {t(`positions.${value}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${ids}-height`} className="text-sm font-medium">
              {t('maxHeight')}
            </label>
            <input
              id={`${ids}-height`}
              className={INPUT}
              inputMode="decimal"
              value={form.logoMaxHeightMm}
              placeholder={String(LAYOUT_LIMITS.logoMaxHeightMm)}
              aria-invalid={heightInvalid ? true : undefined}
              aria-describedby={heightDescribedBy}
              onChange={(event) => {
                onChange({ logoMaxHeightMm: event.target.value });
              }}
            />
            {heightError}
          </div>
        </div>
      )}
    </fieldset>
  );
}

/** `PreviewButton` + `PreviewViewer`: pedido, *polling* até `READY`/`FAILED` e download. */
function PreviewPanel({
  versionId,
  revision,
  dirty,
}: {
  readonly versionId: string;
  readonly revision: number;
  readonly dirty: boolean;
}) {
  const t = useTranslations('templates.layout.preview');
  const format = useFormatter();
  const tenantId = useTenantId();
  const [current, setCurrent] = useState<{ id: string; revision: number } | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState(false);

  const request = useMutation({ mutationFn: () => requestTemplatePreview(versionId) });
  const preview = useQuery({
    queryKey: templateKeys.preview(tenantId, versionId, current?.id ?? 'none'),
    queryFn: async ({ signal }) =>
      (await fetchTemplatePreview(versionId, current?.id ?? '', signal)).data,
    enabled: current !== null,
    refetchInterval: (query) => (isInProgress(query.state.data) ? TEMPLATE_PREVIEW_POLL_MS : false),
    refetchIntervalInBackground: false,
    throwOnError: false,
  });

  const generate = async () => {
    setRequestError(null);
    setDownloadError(false);
    try {
      const result = await request.mutateAsync();
      setCurrent({ id: result.data.renditionId, revision });
    } catch (error) {
      setRequestError(
        isApiError(error) && error.code === 'TEMPLATE_INVALID'
          ? t('invalid')
          : isApiError(error) && error.status === 429
            ? t('rateLimited')
            : t('requestFailed'),
      );
    }
  };

  const data = preview.data;
  const generating = request.isPending || (current !== null && (!data || isInProgress(data)));
  const outdated = current !== null && (current.revision !== revision || dirty);
  const status = generating
    ? t('generating')
    : data?.status === 'READY'
      ? t('ready')
      : data?.status === 'FAILED'
        ? (data.errorMessage ?? t('failed'))
        : '';

  return (
    <section aria-labelledby={`${versionId}-preview-title`} className="flex flex-col gap-3">
      <h2 id={`${versionId}-preview-title`} className="text-lg font-semibold">
        {t('title')}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t('description', { hours: TEMPLATE_PREVIEW_TTL_HOURS })}
      </p>
      <Button
        disabled={generating}
        aria-busy={generating}
        onClick={() => {
          void generate();
        }}
      >
        {generating ? t('generating') : data?.status === 'FAILED' ? t('retry') : t('generate')}
      </Button>
      <p className="text-sm" aria-live="polite" role="status">
        {status}
      </p>
      {requestError ? <Alert tone="error" title={requestError} /> : null}
      {preview.isError ? <Alert tone="error" title={t('expired')} /> : null}
      {outdated && data?.status === 'READY' ? <Alert tone="warning" title={t('outdated')} /> : null}
      {data?.status === 'READY' ? (
        <div className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {data.pageCount === null ? null : (
              <>
                <dt className="text-muted-foreground">{t('pages')}</dt>
                <dd>{format.number(data.pageCount)}</dd>
              </>
            )}
            <dt className="text-muted-foreground">{t('validUntil')}</dt>
            <dd>
              {format.dateTime(new Date(data.expiresAt), {
                dateStyle: 'short',
                timeStyle: 'short',
              })}
            </dd>
          </dl>
          <p className="text-xs text-muted-foreground">{t('watermark')}</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setDownloadError(false);
              void fetchTemplatePreviewDownload(versionId, data.renditionId).then(
                (result) => {
                  startAttachmentDownload(result.data.url);
                },
                () => {
                  setDownloadError(true);
                },
              );
            }}
          >
            {t('download')}
          </Button>
          {downloadError ? <Alert tone="error" title={t('downloadFailed')} /> : null}
        </div>
      ) : null}
    </section>
  );
}

function isInProgress(preview: TemplatePreviewDto | undefined): boolean {
  return preview !== undefined && TEMPLATE_PREVIEW_IN_PROGRESS.includes(preview.status);
}
