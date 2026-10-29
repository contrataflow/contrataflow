'use client';

import {
  Alert,
  Button,
  Eye,
  Field,
  FormSection,
  InfoTooltip,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Switch,
  Textarea,
} from '@contrataflow/ui';
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

const LOGO_ACCEPT = 'image/png,image/jpeg,image/svg+xml';

type SaveProblem =
  'conflict' | 'invalid' | 'notDraft' | 'forbidden' | 'logoInvalid' | 'unavailable' | 'generic';

/**
 * Aba "Layout" de SCR-114 (US-109): `LayoutFormPanel` (orientação, margens, fonte, tamanho e
 * entrelinha), `HeaderFooterEditor` (texto com o seletor de variáveis — o catálogo completo, com
 * `page`/`pages`/`document.hash`), `LogoUploader` (upload genérico de anexos, `TENANT_ASSET`) e
 * `PreviewSheet` (TPL-09 → *polling* de TPL-12 → download de TPL-13, num painel lateral largo).
 * Salva por TPL-08 ao sair do formulário, com o `If-Match` compartilhado com a aba "Conteúdo".
 * Sem `TEMPLATE_MANAGE` (ou versão publicada) o formulário fica somente leitura e a prévia continua.
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

  const formRef = useRef<HTMLFieldSetElement>(null);
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

  return (
    <div className="flex flex-col gap-5">
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

      <PreviewSheet
        versionId={version.id}
        revision={revision}
        dirty={Object.keys(layoutPatch(saved, form)).length > 0}
      />

      <fieldset
        ref={formRef}
        disabled={readOnly}
        className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0"
      >
        <legend className="sr-only">{t('legend')}</legend>

        <FormSection title={t('page.title')}>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label={t('page.orientation')}>
              <Select
                value={form.orientation}
                onValueChange={(value) => {
                  commit({ orientation: value as LayoutForm['orientation'] });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEMPLATE_LAYOUT_ORIENTATIONS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`page.orientations.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <p className="text-sm text-muted-foreground md:self-end md:pb-3">{t('page.size')}</p>
          </div>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {LAYOUT_SIDES.map((side) => {
              const field = `margins.${side}` as const;
              return (
                <Field key={side} label={t(`page.margins.${side}`)} error={errorOf(field)}>
                  <Input
                    inputMode="decimal"
                    value={form.margins[side]}
                    onChange={(event) => {
                      update({ margins: { ...form.margins, [side]: event.target.value } });
                    }}
                  />
                </Field>
              );
            })}
          </div>
        </FormSection>

        <FormSection title={t('typography.title')}>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Field label={t('typography.fontFamily')}>
              <Select
                value={form.fontFamily}
                onValueChange={(value) => {
                  commit({ fontFamily: value as LayoutForm['fontFamily'] });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEMPLATE_FONT_FAMILIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('typography.fontSize')} error={errorOf('fontSizePt')}>
              <Input
                inputMode="decimal"
                value={form.fontSizePt}
                onChange={(event) => {
                  update({ fontSizePt: event.target.value });
                }}
              />
            </Field>
            <Field label={t('typography.lineHeight')} error={errorOf('lineHeight')}>
              <Input
                inputMode="decimal"
                value={form.lineHeight}
                onChange={(event) => {
                  update({ lineHeight: event.target.value });
                }}
              />
            </Field>
          </div>
        </FormSection>

        <FormSection title={t('headerFooter.title')}>
          {(['header', 'footer'] as const).map((field) => (
            <HeaderFooterEditor
              key={field}
              label={t(`headerFooter.${field}`)}
              value={form[field]}
              readOnly={readOnly}
              error={errorOf(field)}
              onChange={(value) => {
                update({ [field]: value });
              }}
            />
          ))}
          <div className="flex flex-col gap-3">
            {(['showPageNumbers', 'showDocumentHashInFooter', 'draftWatermark'] as const).map(
              (flag) => (
                <FlagSwitch
                  key={flag}
                  label={t(`headerFooter.${flag}`)}
                  checked={form[flag]}
                  help={flag === 'showDocumentHashInFooter' ? t('headerFooter.hashHint') : null}
                  onChange={(checked) => {
                    commit({ [flag]: checked });
                  }}
                />
              ),
            )}
          </div>
        </FormSection>

        <LogoUploader
          versionId={version.id}
          form={form}
          readOnly={readOnly}
          heightError={errorOf('logoMaxHeightMm')}
          onChange={update}
          onCommit={commit}
        />
      </fieldset>
    </div>
  );
}

/** Interruptor com rótulo (salva na hora) e, opcionalmente, a ajuda em `InfoTooltip`. */
function FlagSwitch({
  label,
  checked,
  help,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly help: string | null;
  readonly onChange: (checked: boolean) => void;
}) {
  const t = useTranslations('templates');
  const id = useId();
  return (
    <div className="flex items-center gap-3">
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
      {help ? <InfoTooltip label={t('help', { field: label })}>{help}</InfoTooltip> : null}
    </div>
  );
}

function HeaderFooterEditor({
  label,
  value,
  readOnly,
  error,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly readOnly: boolean;
  readonly error: string | undefined;
  readonly onChange: (value: string) => void;
}) {
  const t = useTranslations('templates.layout.headerFooter');
  const tRoot = useTranslations('templates');
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="flex flex-col gap-2">
      <Field
        label={label}
        error={error}
        labelAddon={<InfoTooltip label={tRoot('help', { field: label })}>{t('hint')}</InfoTooltip>}
      >
        <Textarea
          ref={ref}
          rows={3}
          value={value}
          readOnly={readOnly}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      </Field>
      {readOnly ? null : (
        <div
          role="group"
          aria-label={t('variables', { field: label })}
          className="flex flex-wrap gap-1.5"
        >
          {LAYOUT_TEMPLATE_VARIABLES.map((variable) => (
            <Button
              key={variable}
              type="button"
              variant="secondary"
              size="sm"
              className="font-mono text-xs"
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
            </Button>
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
  onChange,
  onCommit,
}: {
  readonly versionId: string;
  readonly form: LayoutForm;
  readonly readOnly: boolean;
  readonly heightError: string | undefined;
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
    <FormSection
      title={t('title')}
      description={form.logoAttachmentId === null ? t('none') : t('current')}
    >
      {uploadState ? (
        <p className="text-sm" role="status">
          {uploadState}
        </p>
      ) : null}
      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="secondary" size="sm" className="cursor-pointer">
            <label htmlFor={`${ids}-file`}>
              {form.logoAttachmentId === null ? t('upload') : t('replace')}
            </label>
          </Button>
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
          <Field label={t('position')}>
            <Select
              value={form.logoPosition}
              onValueChange={(value) => {
                onCommit({ logoPosition: value as TemplateLogoPosition });
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TEMPLATE_LOGO_POSITIONS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`positions.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('maxHeight')} error={heightError}>
            <Input
              inputMode="decimal"
              value={form.logoMaxHeightMm}
              placeholder={String(LAYOUT_LIMITS.logoMaxHeightMm)}
              onChange={(event) => {
                onChange({ logoMaxHeightMm: event.target.value });
              }}
            />
          </Field>
        </div>
      )}
    </FormSection>
  );
}

/**
 * `PreviewSheet`: botão "Ver prévia em PDF" que abre o painel lateral largo com o pedido, o
 * *polling* até `READY`/`FAILED` e o download. O estado fica fora do painel: fechar não perde a
 * prévia gerada.
 */
function PreviewSheet({
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
  const [open, setOpen] = useState(false);
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
    <>
      <div className="flex justify-end">
        <Button
          variant="secondary"
          iconLeft={<Eye />}
          onClick={() => {
            setOpen(true);
          }}
        >
          {t('open')}
        </Button>
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent size="wide">
          <SheetHeader>
            <SheetTitle>{t('title')}</SheetTitle>
            <SheetDescription>
              {t('description', { hours: TEMPLATE_PREVIEW_TTL_HOURS })}
            </SheetDescription>
          </SheetHeader>
          <SheetBody>
            <div>
              <Button
                disabled={generating}
                aria-busy={generating}
                onClick={() => {
                  void generate();
                }}
              >
                {generating
                  ? t('generating')
                  : data?.status === 'FAILED'
                    ? t('retry')
                    : t('generate')}
              </Button>
            </div>
            <p className="text-sm" aria-live="polite" role="status">
              {status}
            </p>
            {requestError ? <Alert tone="error" title={requestError} /> : null}
            {preview.isError ? <Alert tone="error" title={t('expired')} /> : null}
            {outdated && data?.status === 'READY' ? (
              <Alert tone="warning" title={t('outdated')} />
            ) : null}
            {data?.status === 'READY' ? (
              <div className="flex flex-col gap-3">
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
                <div>
                  <Button
                    variant="secondary"
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
                </div>
                {downloadError ? <Alert tone="error" title={t('downloadFailed')} /> : null}
              </div>
            ) : null}
          </SheetBody>
        </SheetContent>
      </Sheet>
    </>
  );
}

function isInProgress(preview: TemplatePreviewDto | undefined): boolean {
  return preview !== undefined && TEMPLATE_PREVIEW_IN_PROGRESS.includes(preview.status);
}
