'use client';

import type { AttachmentTargetType } from '@contrataflow/types';
import {
  Alert,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Ellipsis,
  InfoTooltip,
  Progress,
  Upload,
  buttonClassName,
} from '@contrataflow/ui';
import { PLATFORM_UPLOAD_EXTENSIONS } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import type { DragEvent } from 'react';

import { Can } from '@/lib/permissions/can';

import { AttachmentList } from './attachment-list';
import { DeleteAttachmentDialog } from './delete-attachment-dialog';
import { FileKindIcon } from './file-kind-icon';
import { ScanProgress } from './scan-progress';
import {
  ACCEPT_ATTRIBUTE,
  DEFAULT_MAX_FILE_SIZE_MB,
  extensionOf,
  formatFileSize,
} from './upload-rules';
import { useAttachmentUploads } from './use-attachment-uploads';
import type { UploadDeps, UploadItem } from './use-attachment-uploads';

export interface AttachmentsSectionProps {
  readonly targetType: AttachmentTargetType;
  readonly targetId: string;
  /** Processo do alvo: habilita a lista de anexos já enviados (ATT-01 — US-069). */
  readonly processId?: string | undefined;
  /** Ação contextual de edição do alvo (`meta.allowedActions` da API — ex.: `UPDATE` no documento). */
  readonly action?: string | undefined;
  readonly allowedActions?: readonly string[] | undefined;
  /** Texto da falha genérica de envio no lugar do padrão (ex.: o anexo da fonte de pesquisa — US-026). */
  readonly failedMessage?: string | undefined;
  /** Testes: relógio da sondagem e XHR simulados. */
  readonly deps?: UploadDeps | undefined;
}

const TYPES = PLATFORM_UPLOAD_EXTENSIONS.join(', ');

/**
 * `AttachmentUploader` + `AttachmentList` + `DeleteAttachmentDialog` (US-068 · SCR-006/SCR-105 —
 * componente embutido na tela do alvo): botão "Anexar arquivo" e área de soltar (o botão é a
 * alternativa de teclado), validação local, barra de progresso com anúncio `aria-live` a cada 10%,
 * "Verificando segurança do arquivo…" até o fim da varredura, motivo resumido da rejeição (sem
 * detalhe técnico) e exclusão com motivo. Sem `ATTACHMENT_UPLOAD` o botão some; alvo não editável
 * desabilita com a explicação (`<Can>`).
 */
export function AttachmentsSection({
  targetType,
  targetId,
  processId,
  action,
  allowedActions,
  failedMessage,
  deps,
}: AttachmentsSectionProps) {
  const t = useTranslations('attachments');
  const headingId = useId();
  const hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [deleting, setDeleting] = useState<UploadItem | null>(null);
  const uploads = useAttachmentUploads({ targetType, targetId }, deps);

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    uploads.add([...event.dataTransfer.files]);
  };

  const sessionIds = new Set(
    uploads.items.flatMap((item) => (item.attachment === null ? [] : [item.attachment.id])),
  );

  const rejectionMessage = uploads.rejection
    ? uploads.rejection.reason === 'TYPE'
      ? t('uploader.typeNotAllowed', { types: TYPES })
      : uploads.rejection.reason === 'SIZE'
        ? t('uploader.tooLarge', { maxMb: DEFAULT_MAX_FILE_SIZE_MB })
        : t('uploader.empty')
    : null;

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <h2 id={headingId} className="text-lg font-semibold">
            {t('section.title')}
          </h2>
          <InfoTooltip label={t('section.helpLabel')}>{t('section.help')}</InfoTooltip>
        </div>
        <p className="text-sm text-muted-foreground">{t('section.description')}</p>
      </div>

      <Can
        permission="ATTACHMENT_UPLOAD"
        action={action}
        allowedActions={allowedActions}
        unavailableReason={t('item.notEditable')}
      >
        {({ disabled, describedBy }) => (
          // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- área de soltar; a alternativa de teclado é o botão "Anexar arquivo"
          <div
            data-testid="attachment-dropzone"
            onDragOver={(event) => {
              if (disabled) return;
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => {
              setDragging(false);
            }}
            onDrop={disabled ? undefined : onDrop}
            className={`flex flex-col items-center gap-2 rounded-card border border-dashed px-4 py-6 text-center ${
              dragging ? 'border-primary bg-primary/5' : 'border-border-strong'
            }`}
          >
            <Upload aria-hidden="true" className="size-6 text-muted-foreground" />
            <p className="text-sm">{t('uploader.dropzone')}</p>
            <input
              ref={input}
              type="file"
              multiple
              accept={ACCEPT_ATTRIBUTE}
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                uploads.add([...(event.target.files ?? [])]);
                event.target.value = '';
              }}
            />
            <Button
              variant="secondary"
              disabled={disabled}
              aria-describedby={[hintId, describedBy].filter(Boolean).join(' ')}
              onClick={() => input.current?.click()}
            >
              {t('uploader.button')}
            </Button>
            <p id={hintId} className="text-xs text-muted-foreground">
              {t('uploader.hint', { types: TYPES, maxMb: DEFAULT_MAX_FILE_SIZE_MB })}
            </p>
          </div>
        )}
      </Can>

      {rejectionMessage === null ? null : <Alert tone="error" title={rejectionMessage} />}

      {processId === undefined ? null : (
        <AttachmentList
          processId={processId}
          targetType={targetType}
          targetId={targetId}
          hiddenIds={sessionIds}
          sessionCount={uploads.items.length}
          fetchBytes={deps?.fetchBytes}
          navigate={deps?.navigate}
        />
      )}

      {uploads.items.length === 0 ? (
        processId === undefined ? (
          <p className="text-sm text-muted-foreground">{t('section.empty')}</p>
        ) : null
      ) : (
        <ul className="flex min-w-0 flex-col divide-y divide-border">
          {uploads.items.map((item) => (
            <AttachmentCard
              key={item.key}
              item={item}
              failedMessage={failedMessage}
              onRetry={() => {
                uploads.retry(item.key);
              }}
              onDismiss={() => {
                uploads.dismiss(item.key);
              }}
              onDelete={() => {
                setDeleting(item);
              }}
            />
          ))}
        </ul>
      )}

      <DeleteAttachmentDialog
        fileName={deleting?.file.name ?? null}
        onClose={() => {
          setDeleting(null);
        }}
        onConfirm={async (reason) => {
          if (deleting) await uploads.remove(deleting.key, reason);
        }}
      />
    </section>
  );
}

function AttachmentCard({
  item,
  failedMessage,
  onRetry,
  onDismiss,
  onDelete,
}: {
  readonly item: UploadItem;
  readonly failedMessage: string | undefined;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
  readonly onDelete: () => void;
}) {
  const t = useTranslations('attachments');
  // Anúncio a cada 10% (não a cada evento de progresso).
  const announced = Math.floor(item.progress / 10) * 10;
  const problem = item.phase === 'failed' || item.phase === 'rejected';
  return (
    <li className="flex min-w-0 flex-col gap-2 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <FileKindIcon extension={extensionOf(item.file.name)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold" title={item.file.name}>
            {item.file.name}
          </span>
          <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            <span>{formatFileSize(item.file.size)}</span>
            {item.phase === 'uploading' ? (
              <span>{t('item.uploading', { progress: item.progress })}</span>
            ) : problem ? null : (
              <span aria-live="polite">
                <StatusText item={item} failedMessage={failedMessage} />
              </span>
            )}
          </span>
        </div>
        {item.phase === 'available' ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              className={buttonClassName({ variant: 'ghost', size: 'icon' })}
              aria-label={t('item.actionsLabel', { fileName: item.file.name })}
            >
              <Ellipsis aria-hidden="true" className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onDelete}>{t('item.delete')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {item.phase === 'uploading' ? (
        <>
          <Progress
            value={item.progress}
            aria-label={t('item.progressLabel', { fileName: item.file.name })}
          />
          <p aria-live="polite" className="sr-only">
            {t('item.progressAnnouncement', { fileName: item.file.name, progress: announced })}
          </p>
        </>
      ) : null}

      {item.phase === 'scanning' ? <ScanProgress label={t('item.scanning')} /> : null}

      {problem ? (
        <Alert tone="error" title={<StatusText item={item} failedMessage={failedMessage} />}>
          <div className="flex flex-wrap gap-2">
            {item.phase === 'failed' ? (
              <Button size="sm" variant="secondary" onClick={onRetry}>
                {t('item.retry')}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              {t('item.dismiss')}
            </Button>
          </div>
        </Alert>
      ) : null}
    </li>
  );
}

const FAILURE_KEYS: Readonly<Record<string, string>> = {
  UPLOAD_NOT_RECEIVED: 'item.uploadNotReceived',
  DOCUMENT_NOT_EDITABLE: 'item.notEditable',
  INVALID_PROCESS_STATUS: 'item.notEditable',
  PERMISSION_DENIED: 'item.permissionDenied',
  STORAGE_QUOTA_EXCEEDED: 'item.quotaExceeded',
};

function StatusText({
  item,
  failedMessage,
}: {
  readonly item: UploadItem;
  readonly failedMessage: string | undefined;
}) {
  const t = useTranslations('attachments');
  switch (item.phase) {
    case 'uploading':
      return null;
    case 'scanning':
      return <>{t('item.scanning')}</>;
    case 'available':
      return <>{t('item.available')}</>;
    case 'deleted':
      return <>{t('item.deleted')}</>;
    case 'rejected': {
      const code = item.reasonCode ?? 'default';
      const key = ['INFECTED', 'TYPE_MISMATCH', 'TYPE_NOT_ALLOWED', 'SIZE_MISMATCH'].includes(code)
        ? code
        : 'default';
      return <>{t(`rejected.${key}` as 'rejected.default')}</>;
    }
    case 'failed': {
      if (item.errorCode === 'FILE_TYPE_NOT_ALLOWED' || item.errorCode === 'FILE_TOO_LARGE') {
        return <>{item.errorDetail}</>;
      }
      const key = (item.errorCode && FAILURE_KEYS[item.errorCode]) ?? 'item.failed';
      if (key === 'item.failed' && failedMessage !== undefined) return <>{failedMessage}</>;
      return <>{t(key as 'item.failed')}</>;
    }
  }
}
