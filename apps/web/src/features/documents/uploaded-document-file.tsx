'use client';

import { Alert, Button, Skeleton } from '@contrataflow/ui';
import { PLATFORM_UPLOAD_EXTENSIONS, hasInlinePreview } from '@contrataflow/validation';
import type { AttachmentDto, DocumentDto, DocumentMeta } from '@contrataflow/validation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import type { DragEvent } from 'react';

import { fetchAttachment, fetchAttachmentDownload } from '@/features/attachments/attachments.api';
import {
  ACCEPT_ATTRIBUTE,
  DEFAULT_MAX_FILE_SIZE_MB,
  formatFileSize,
} from '@/features/attachments/upload-rules';
import { Can } from '@/lib/permissions/can';
import { useTenantId } from '@/lib/session/session-context';

import { documentKeys } from './documents.api';
import { startDownload } from './renditions.api';
import { fetchDocumentVersion } from './uploaded-documents.api';
import { useDocumentFileUpload } from './use-document-file-upload';
import type { FileUploadDeps, FileUploadState } from './use-document-file-upload';

const TYPES = PLATFORM_UPLOAD_EXTENSIONS.join(', ');
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg']);

/** Falhas com mensagem própria ("Casos de erro" da US-064); as demais caem em `default`. */
const UPLOAD_ERROR_CODES = [
  'UPLOAD_NOT_RECEIVED',
  'ATTACHMENT_NOT_AVAILABLE',
  'DOCUMENT_NOT_EDITABLE',
  'VERSION_CONFLICT',
  'PERMISSION_DENIED',
  'FILE_TYPE_NOT_ALLOWED',
  'FILE_TOO_LARGE',
  'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE',
  'DEPENDENCY_UNAVAILABLE',
  'NETWORK',
] as const;

export interface UploadedDocumentFileProps {
  readonly document: DocumentDto;
  readonly meta: DocumentMeta;
  /** Testes: relógio da sondagem, XHR e `fetch` dos bytes da prévia simulados. */
  readonly deps?:
    (FileUploadDeps & { readonly fetchBytes?: (url: string) => Promise<Blob> }) | undefined;
  /** Testes: navegação do download. */
  readonly navigate?: ((url: string) => void) | undefined;
}

const defaultFetchBytes = async (url: string): Promise<Blob> => {
  const response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  if (!response.ok) throw new Error(`Prévia indisponível (${String(response.status)}).`);
  return response.blob();
};

/**
 * Arquivo do documento externo na SCR-105 (US-064): `VersionBadge` ("v{N} · enviado por {user} em
 * {data}"), prévia (`InlinePreview` para imagem; PDF e demais formatos com o
 * `UnsupportedPreviewPlaceholder` — "Baixar arquivo" sempre visível), `FileUploadDropzone` (botão =
 * alternativa de teclado à área de soltar) e `UploadProgress` com anúncio `aria-live` a cada 10%.
 * Sem `ATTACHMENT_UPLOAD` o envio some; documento fora de edição (POL-02 → `UPDATE` em
 * `allowedActions`) desabilita com a explicação.
 */
export function UploadedDocumentFile({
  document,
  meta,
  deps,
  navigate = startDownload,
}: UploadedDocumentFileProps) {
  const t = useTranslations('documents.upload');
  const tenantId = useTenantId();
  const headingId = useId();
  const versionId = document.currentVersionId;

  const current = useQuery({
    queryKey: [...documentKeys.all(tenantId, document.id), 'file', versionId],
    enabled: versionId !== null,
    queryFn: async ({ signal }) => {
      const version = await fetchDocumentVersion(versionId ?? '', signal);
      const attachment =
        version.attachmentId === null ? null : await fetchAttachment(version.attachmentId, signal);
      return { version, attachment };
    },
    throwOnError: false,
  });

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-lg font-semibold">
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>

      {versionId === null ? (
        <p className="rounded-card border border-dashed border-border p-4 text-sm">{t('noFile')}</p>
      ) : current.data ? (
        <div className="flex min-w-0 flex-col gap-3">
          <VersionBadge
            number={current.data.version.versionNumber}
            user={current.data.version.createdByName}
            createdAt={current.data.version.createdAt}
          />
          {current.data.attachment ? (
            <FilePreview
              attachment={current.data.attachment}
              fetchBytes={deps?.fetchBytes ?? defaultFetchBytes}
              navigate={navigate}
            />
          ) : null}
        </div>
      ) : current.isError ? (
        <Alert tone="error" live={false} title={t('loadFailed')}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void current.refetch();
            }}
          >
            {t('retryLoad')}
          </Button>
        </Alert>
      ) : (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loadingFile')}</span>
          <Skeleton className="h-4 w-64 max-w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}

      <Can
        permission="ATTACHMENT_UPLOAD"
        action="UPDATE"
        allowedActions={meta.allowedActions}
        unavailableReason={t('notEditable')}
      >
        {({ disabled, describedBy }) => (
          <FileUploadDropzone
            document={document}
            hasFile={versionId !== null}
            disabled={disabled}
            describedBy={describedBy}
            deps={deps}
          />
        )}
      </Can>
    </section>
  );
}

/** `VersionBadge`: "v{N} · enviado por {user} em {data}". */
function VersionBadge({
  number,
  user,
  createdAt,
}: {
  readonly number: number;
  readonly user: string | null;
  readonly createdAt: string;
}) {
  const t = useTranslations('documents.upload');
  const format = useFormatter();
  return (
    <p className="w-fit rounded-control bg-muted px-2 py-1 text-sm font-medium">
      {t('versionBadge', {
        number,
        user: user ?? t('unknownUser'),
        date: format.dateTime(new Date(createdAt), { dateStyle: 'short', timeStyle: 'short' }),
      })}
    </p>
  );
}

/** Prévia + "Baixar arquivo" (ATT-05 a cada clique — a URL vale 300 s e o download é auditado). */
function FilePreview({
  attachment,
  fetchBytes,
  navigate,
}: {
  readonly attachment: AttachmentDto;
  readonly fetchBytes: (url: string) => Promise<Blob>;
  readonly navigate: (url: string) => void;
}) {
  const t = useTranslations('documents.upload.preview');
  const download = useMutation({
    mutationFn: async () => {
      navigate((await fetchAttachmentDownload(attachment.id)).url);
    },
  });
  const extension = attachment.extension.toLowerCase();
  const image = hasInlinePreview(extension) && IMAGE_EXTENSIONS.has(extension);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {image ? (
        <InlinePreview attachment={attachment} fetchBytes={fetchBytes} />
      ) : (
        <UnsupportedPreviewPlaceholder pdf={extension === 'pdf'} />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          disabled={download.isPending}
          aria-busy={download.isPending}
          onClick={() => {
            download.mutate();
          }}
        >
          {download.isPending ? t('downloading') : t('download')}
        </Button>
        <span className="text-sm break-all text-muted-foreground">
          {attachment.fileName} · {formatFileSize(attachment.sizeBytes)}
        </span>
      </div>
      {download.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t('downloadFailed')}
        </p>
      ) : null}
    </div>
  );
}

/**
 * `InlinePreview` (RN-DOC-36): os bytes vêm por `fetch` da URL assinada (o `Content-Disposition:
 * attachment` só afeta a navegação) e viram uma URL `blob:` (`img-src blob:` na CSP). PDF entra
 * aqui quando o visualizador pdf.js for aprovado (a CSP bloqueia `iframe`/`object`).
 */
function InlinePreview({
  attachment,
  fetchBytes,
}: {
  readonly attachment: AttachmentDto;
  readonly fetchBytes: (url: string) => Promise<Blob>;
}) {
  const t = useTranslations('documents.upload.preview');
  const tenantId = useTenantId();
  const bytes = useQuery({
    queryKey: [...documentKeys.all(tenantId, attachment.targetId ?? ''), 'preview', attachment.id],
    queryFn: async () =>
      URL.createObjectURL(await fetchBytes((await fetchAttachmentDownload(attachment.id)).url)),
    // Cada ATT-05 é auditado: a prévia não se renova sozinha; sai do cache ao desmontar.
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
    throwOnError: false,
  });
  const objectUrl = bytes.data ?? null;

  useEffect(
    () => () => {
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    },
    [objectUrl],
  );

  if (bytes.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('failed')}
      </p>
    );
  }
  if (objectUrl === null) {
    return (
      <div role="status">
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- URL `blob:` da prévia; o otimizador do Next não a alcança
    <img
      src={objectUrl}
      alt={t('label', { fileName: attachment.fileName })}
      className="max-h-[70vh] w-full rounded-card border border-border object-contain"
    />
  );
}

/** `UnsupportedPreviewPlaceholder` (FA-02): sem prévia nativa — o download segue ao lado. */
function UnsupportedPreviewPlaceholder({ pdf }: { readonly pdf: boolean }) {
  const t = useTranslations('documents.upload.preview');
  return (
    <p className="rounded-card border border-dashed border-border p-4 text-sm text-muted-foreground">
      {pdf ? t('pdfPending') : t('unsupported')}
    </p>
  );
}

/** Mensagem do estado do envio (sem detalhe técnico). */
function useStatusMessage(state: FileUploadState): string | null {
  const t = useTranslations('documents.upload');
  if (state.localRejection === 'TYPE') return t('typeNotAllowed', { types: TYPES });
  if (state.localRejection === 'SIZE') return t('tooLarge', { maxMb: DEFAULT_MAX_FILE_SIZE_MB });
  if (state.localRejection === 'EMPTY') return t('empty');
  switch (state.phase) {
    case 'scanning':
      return t('scanning');
    case 'registering':
      return t('registering');
    case 'done':
      return state.version ? t('done', { number: state.version.versionNumber }) : null;
    case 'rejected':
      return t('rejected');
    case 'failed': {
      const code = UPLOAD_ERROR_CODES.find((known) => known === state.errorCode) ?? 'default';
      return t(`errors.${code}`);
    }
    default:
      return null;
  }
}

/** `FileUploadDropzone` + `UploadProgress`. */
function FileUploadDropzone({
  document,
  hasFile,
  disabled,
  describedBy,
  deps,
}: {
  readonly document: DocumentDto;
  readonly hasFile: boolean;
  readonly disabled: boolean;
  readonly describedBy: string | undefined;
  readonly deps: FileUploadDeps | undefined;
}) {
  const t = useTranslations('documents.upload');
  const hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const upload = useDocumentFileUpload(document, deps);
  const { state } = upload;
  const busy =
    state.phase === 'uploading' || state.phase === 'scanning' || state.phase === 'registering';
  const message = useStatusMessage(state);
  const failure =
    state.localRejection !== null || state.phase === 'failed' || state.phase === 'rejected';

  const pick = (files: readonly File[]) => {
    const [file] = files;
    if (file !== undefined) upload.start(file);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!disabled && !busy) pick([...event.dataTransfer.files]);
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- área de soltar; a alternativa de teclado é o botão "Enviar arquivo"
    <div
      data-testid="document-file-dropzone"
      onDragOver={(event) => {
        if (disabled || busy) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => {
        setDragging(false);
      }}
      onDrop={onDrop}
      className={`flex min-w-0 flex-col items-start gap-2 rounded-card border border-dashed p-4 ${
        dragging ? 'border-primary bg-primary/5' : 'border-border'
      }`}
    >
      <p className="text-sm">{t('dropzone')}</p>
      <p id={hintId} className="text-xs text-muted-foreground">
        {t('hint', { types: TYPES, maxMb: DEFAULT_MAX_FILE_SIZE_MB })}
      </p>
      <input
        ref={input}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          pick([...(event.target.files ?? [])]);
          event.target.value = '';
        }}
      />
      <Button
        disabled={disabled || busy}
        aria-busy={busy}
        aria-describedby={[hintId, describedBy].filter(Boolean).join(' ')}
        onClick={() => input.current?.click()}
      >
        {hasFile ? t('sendNew') : t('send')}
      </Button>

      {state.phase === 'uploading' && state.fileName !== null ? (
        <UploadProgress fileName={state.fileName} progress={state.progress} />
      ) : null}

      <div aria-live="polite" className="text-sm">
        {message !== null ? (
          <p className={failure ? 'text-destructive' : undefined}>{message}</p>
        ) : null}
      </div>
      {state.phase === 'failed' ? (
        <Button variant="secondary" size="sm" onClick={upload.retry}>
          {t('retry')}
        </Button>
      ) : null}
      {state.phase === 'rejected' ? (
        <Button variant="secondary" size="sm" onClick={() => input.current?.click()}>
          {t('chooseAnother')}
        </Button>
      ) : null}
    </div>
  );
}

/** `UploadProgress`: barra com o percentual; o anúncio só muda a cada 10%. */
function UploadProgress({
  fileName,
  progress,
}: {
  readonly fileName: string;
  readonly progress: number;
}) {
  const t = useTranslations('documents.upload');
  const step = Math.floor(progress / 10) * 10;
  return (
    <div className="flex w-full min-w-0 flex-col gap-1">
      <p className="text-sm break-all">{t('uploading', { fileName, progress })}</p>
      <div
        role="progressbar"
        aria-label={t('progressLabel', { fileName })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full bg-primary" style={{ width: `${String(progress)}%` }} />
      </div>
      <span className="sr-only" aria-live="polite">
        {t('progressAnnouncement', { progress: step })}
      </span>
    </div>
  );
}
