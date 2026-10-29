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
  Skeleton,
  buttonClassName,
} from '@contrataflow/ui';
import { hasInlinePreview } from '@contrataflow/validation';
import type { AttachmentDto } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useTenantId } from '@/lib/session/session-context';

import {
  attachmentKeys,
  fetchAttachmentDownload,
  fetchProcessAttachments,
  startAttachmentDownload,
} from './attachments.api';
import { FileKindIcon } from './file-kind-icon';
import { ScanProgress } from './scan-progress';
import { formatFileSize } from './upload-rules';

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg']);
/** Estados em que o arquivo ainda não foi liberado pela varredura (FA-01). */
const VERIFYING: ReadonlySet<AttachmentDto['status']> = new Set([
  'PENDING_UPLOAD',
  'UPLOADED',
  'SCANNING',
]);

const defaultFetchBytes = async (url: string): Promise<Blob> => {
  const response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  if (!response.ok) throw new Error(`Prévia indisponível (${String(response.status)}).`);
  return response.blob();
};

export interface AttachmentListProps {
  readonly processId: string;
  readonly targetType: AttachmentTargetType;
  readonly targetId: string;
  /** Anexos já exibidos pela sessão de envio da tela (sem duplicar o cartão). */
  readonly hiddenIds?: ReadonlySet<string> | undefined;
  /** Envios desta sessão da tela: o estado vazio ("Nenhum anexo") só vale sem nenhum deles. */
  readonly sessionCount?: number | undefined;
  /** Testes: `fetch` dos bytes da prévia e navegação do download simulados. */
  readonly fetchBytes?: ((url: string) => Promise<Blob>) | undefined;
  readonly navigate?: ((url: string) => void) | undefined;
}

/**
 * `AttachmentList` + `AttachmentViewer` (US-069 · SCR-006/SCR-105): anexos do alvo (ATT-01) com
 * "Baixar" (ATT-05, URL assinada de 300 s pedida a cada clique — FA-02) e "Visualizar" (imagem
 * inline por `fetch`; PDF aguarda o visualizador aprovado; demais formatos só baixam). Anexo em
 * verificação não oferece download; `aria-label` com nome e tamanho; lista em coluna única < 768 px.
 */
export function AttachmentList({
  processId,
  targetType,
  targetId,
  hiddenIds,
  sessionCount = 0,
  fetchBytes = defaultFetchBytes,
  navigate = startAttachmentDownload,
}: AttachmentListProps) {
  const t = useTranslations('attachments.list');
  const tenantId = useTenantId();
  const list = useQuery({
    queryKey: attachmentKeys.list(tenantId, processId, targetType, targetId),
    queryFn: ({ signal }) => fetchProcessAttachments(processId, { targetType, targetId }, signal),
    throwOnError: false,
  });

  if (list.isError) {
    return (
      <Alert tone="error" live={false} title={t('loadFailed')}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void list.refetch();
          }}
        >
          {t('retryLoad')}
        </Button>
      </Alert>
    );
  }
  if (!list.data) {
    return (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }
  const items = list.data.items.filter(
    (item) => !(hiddenIds?.has(item.id) ?? false) && item.status !== 'DELETED',
  );
  if (items.length === 0) {
    return sessionCount === 0 ? (
      <p className="text-sm text-muted-foreground">{t('empty')}</p>
    ) : null;
  }
  return (
    <ul aria-label={t('label')} className="flex min-w-0 flex-col divide-y divide-border">
      {items.map((item) => (
        <AttachmentRow
          key={item.id}
          attachment={item}
          processId={processId}
          fetchBytes={fetchBytes}
          navigate={navigate}
        />
      ))}
    </ul>
  );
}

function AttachmentRow({
  attachment,
  processId,
  fetchBytes,
  navigate,
}: {
  readonly attachment: AttachmentDto;
  readonly processId: string;
  readonly fetchBytes: (url: string) => Promise<Blob>;
  readonly navigate: (url: string) => void;
}) {
  const t = useTranslations('attachments.list');
  const format = useFormatter();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const messageId = useId();
  const [previewing, setPreviewing] = useState(false);
  const verifying = VERIFYING.has(attachment.status);
  const unavailable = verifying || attachment.status !== 'AVAILABLE';
  const previewable = !unavailable && hasInlinePreview(attachment.extension);
  const description = `${attachment.fileName} (${formatFileSize(attachment.sizeBytes)})`;

  const download = useMutation({
    mutationFn: async () => {
      // A URL vale 300 s e cada pedido é auditado: sempre uma nova chamada, nunca um cache (FA-02).
      const signed = await fetchAttachmentDownload(attachment.id);
      navigate(signed.url);
    },
    onError: (error) => {
      // O anexo mudou desde a listagem (excluído, em verificação ou fora do ar): renova a lista.
      if (isApiError(error) && ['ATTACHMENT_NOT_AVAILABLE', 'NOT_FOUND'].includes(error.code)) {
        void queryClient.invalidateQueries({
          queryKey: attachmentKeys.process(tenantId, processId),
        });
      }
    },
  });

  const failure = download.error;
  const failureMessage = failure
    ? isApiError(failure)
      ? failure.code === 'ATTACHMENT_NOT_AVAILABLE'
        ? t('errors.notAvailable')
        : failure.code === 'PERMISSION_DENIED'
          ? t('errors.forbidden')
          : failure.code === 'NOT_FOUND'
            ? t('errors.notFound')
            : t('errors.unavailable')
      : t('errors.unavailable')
    : null;
  const correlationId =
    isApiError(failure) && failure.code !== 'PERMISSION_DENIED' ? failure.correlationId : null;

  return (
    <li aria-label={description} className="flex min-w-0 flex-col gap-2 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <FileKindIcon extension={attachment.extension} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold" title={attachment.fileName}>
            {attachment.fileName}
          </span>
          <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            <span>{formatFileSize(attachment.sizeBytes)}</span>
            <span>
              {t('uploadedAt', {
                date: format.dateTime(new Date(attachment.createdAt), { dateStyle: 'short' }),
              })}
            </span>
            {download.isPending ? <span aria-live="polite">{t('downloading')}</span> : null}
            {attachment.status === 'AVAILABLE' && !previewable ? (
              <span>{t('noPreview')}</span>
            ) : null}
          </span>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            className={buttonClassName({ variant: 'ghost', size: 'icon' })}
            aria-label={t('actionsLabel', { fileName: attachment.fileName })}
            aria-describedby={failureMessage === null ? undefined : messageId}
          >
            <Ellipsis aria-hidden="true" className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={unavailable || download.isPending}
              aria-label={t('downloadLabel', { fileName: attachment.fileName })}
              onSelect={() => {
                download.mutate();
              }}
            >
              {t('download')}
            </DropdownMenuItem>
            {previewable ? (
              <DropdownMenuItem
                aria-label={t(previewing ? 'closePreviewLabel' : 'previewLabel', {
                  fileName: attachment.fileName,
                })}
                onSelect={() => {
                  setPreviewing((open) => !open);
                }}
              >
                {previewing ? t('closePreview') : t('preview')}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {verifying ? (
        <>
          <ScanProgress label={t('verifyingLabel')} />
          <p className="text-sm">{t('verifying')}</p>
        </>
      ) : null}
      {attachment.status === 'INFECTED' || attachment.status === 'REJECTED' ? (
        <Alert tone="error" live={false} title={t('rejected')} />
      ) : null}

      {failureMessage === null ? null : (
        <Alert tone="error" id={messageId} title={failureMessage}>
          {correlationId === null ? null : (
            <span className="text-xs text-muted-foreground">
              {t('correlation', { id: correlationId })}
            </span>
          )}
        </Alert>
      )}

      {previewing ? (
        IMAGE_EXTENSIONS.has(attachment.extension.toLowerCase()) ? (
          <AttachmentViewer attachment={attachment} tenantId={tenantId} fetchBytes={fetchBytes} />
        ) : (
          <p className="rounded-card border border-dashed border-border p-4 text-sm text-muted-foreground">
            {t('pdfPending')}
          </p>
        )
      ) : null}
    </li>
  );
}

/**
 * `AttachmentViewer` (RN-DOC-86): os bytes vêm por `fetch` da URL assinada (o `Content-Disposition:
 * attachment` só afeta a navegação) e viram uma URL `blob:` (`img-src blob:` na CSP).
 */
function AttachmentViewer({
  attachment,
  tenantId,
  fetchBytes,
}: {
  readonly attachment: AttachmentDto;
  readonly tenantId: string;
  readonly fetchBytes: (url: string) => Promise<Blob>;
}) {
  const t = useTranslations('attachments.list');
  const bytes = useQuery({
    queryKey: [
      ...attachmentKeys.process(tenantId, attachment.processId ?? ''),
      'preview',
      attachment.id,
    ],
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
    return <Alert tone="error" title={t('previewFailed')} />;
  }
  if (objectUrl === null) {
    return (
      <div role="status">
        <span className="sr-only">{t('previewLoading')}</span>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- URL `blob:` da prévia; o otimizador do Next não a alcança
    <img
      src={objectUrl}
      alt={t('previewAlt', { fileName: attachment.fileName })}
      className="max-h-[70vh] w-full rounded-card border border-border object-contain"
    />
  );
}
