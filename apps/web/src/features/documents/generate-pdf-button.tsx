'use client';

import { Button } from '@contrataflow/ui';
import { RENDITION_MESSAGES } from '@contrataflow/validation';
import type { RenditionStatus } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useTenantId } from '@/lib/session/session-context';

import { PdfPreviewPanel } from './pdf-preview-panel';
import { RenditionErrorAlert } from './rendition-error-alert';
import { describeRenditionError } from './rendition-errors';
import type { RenditionOutcome } from './rendition-errors';
import { RenditionStatusBadge } from './rendition-status-badge';
import {
  fetchRenditionDownload,
  isRenditionExpired,
  isRenditionInProgress,
  renditionKeys,
  requestDocumentPreview,
  requestVersionRendition,
  startDownload,
} from './renditions.api';
import type { RenditionRequestResult } from './renditions.api';
import { useRendition } from './use-rendition';

/** O que o botão gera: a prévia do rascunho (DOC-20) ou o PDF oficial de uma versão (DOC-21). */
export type PdfSource =
  | { readonly kind: 'preview'; readonly documentId: string }
  | { readonly kind: 'version'; readonly versionId: string; readonly versionNumber: number };

export interface GeneratePdfButtonProps {
  readonly source: PdfSource;
  /** Segue a URL pré-assinada do DOC-23; injetável nos testes (o padrão navega a janela). */
  readonly navigate?: ((url: string) => void) | undefined;
}

type OutcomeOrigin = 'request' | 'download' | 'poll';

/**
 * `GeneratePdfButton` (US-067 · SCR-105/106): pede o PDF, acompanha a geração por DOC-22 (a cada
 * 2 s enquanto `PENDING`/`PROCESSING`) e libera "Baixar PDF" em `READY` (DOC-23 → navega até a URL
 * pré-assinada). `FAILED` mostra a mensagem e "Tentar novamente"; prévia vencida (`EXPIRED`,
 * `expiresAt` no passado ou 409 no download) desabilita o download e oferece gerar de novo. O
 * status é anunciado numa região `aria-live="polite"` sempre montada. Os erros (404, 409, 403,
 * 429 com `Retry-After`, 503) aparecem em linha, sem fechar nada. O PDF ficar pronto não depende
 * do usuário na tela: o estado vive só nesta sessão (não há rota que liste os PDFs do documento).
 */
export function GeneratePdfButton({ source, navigate = startDownload }: GeneratePdfButtonProps) {
  const t = useTranslations('documents.renditions');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const [renditionId, setRenditionId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    readonly outcome: RenditionOutcome;
    readonly origin: OutcomeOrigin;
  } | null>(null);
  // Prévia que a API recusou no download por vencida (409), mesmo com o status ainda `READY`.
  const [lapsedId, setLapsedId] = useState<string | null>(null);
  // 429: os botões esperam o `Retry-After` antes de aceitar novo pedido.
  const [blockedUntil, setBlockedUntil] = useState<number | null>(null);

  const query = useRendition(renditionId);
  const rendition = query.data;

  useEffect(() => {
    if (blockedUntil === null) return undefined;
    const timer = setTimeout(
      () => {
        setBlockedUntil(null);
      },
      Math.max(0, blockedUntil - Date.now()),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [blockedUntil]);

  const fail = (error: unknown, origin: OutcomeOrigin) => {
    const outcome = describeRenditionError(error, pathname);
    if (outcome.kind === 'redirect') {
      router.push(outcome.href);
      return;
    }
    if (outcome.kind === 'rateLimited' && outcome.retryAfterSeconds !== null) {
      setBlockedUntil(Date.now() + outcome.retryAfterSeconds * 1000);
    }
    setFailure({ outcome, origin });
  };

  const request = useMutation({
    mutationFn: (): Promise<RenditionRequestResult> =>
      source.kind === 'preview'
        ? requestDocumentPreview(source.documentId)
        : requestVersionRendition(source.versionId),
    onSuccess: (result) => {
      // Semeia o cache com a rendition `PENDING`: a tela já mostra "Gerando PDF…" sem esperar o GET.
      queryClient.setQueryData(
        renditionKeys.detail(tenantId, result.rendition.id),
        result.rendition,
      );
      setRenditionId(result.rendition.id);
    },
    onError: (error) => {
      fail(error, 'request');
    },
  });

  const download = useMutation({
    mutationFn: async (id: string) => {
      const { url } = await fetchRenditionDownload(id);
      navigate(url);
    },
    onError: (error, id) => {
      if (isApiError(error) && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: renditionKeys.detail(tenantId, id) });
        // Prévia: 409 no download = vencida (o status pode demorar a virar `EXPIRED`).
        if (rendition?.kind === 'PREVIEW') {
          setLapsedId(id);
          return;
        }
      }
      fail(error, 'download');
    },
  });

  const generate = () => {
    setFailure(null);
    request.mutate();
  };

  const startDownloadOf = (id: string) => {
    setFailure(null);
    if (rendition && isRenditionExpired(rendition)) {
      setLapsedId(id);
      return;
    }
    download.mutate(id);
  };

  const pollFailure =
    query.isError && failure === null ? describeRenditionError(query.error, pathname) : null;
  const shown: { outcome: RenditionOutcome; origin: OutcomeOrigin } | null =
    failure ?? (pollFailure ? { outcome: pollFailure, origin: 'poll' } : null);

  // Status exibido: pedido em curso = "Gerando"; `READY` com prévia vencida = `EXPIRED`.
  let status: RenditionStatus | null = null;
  if (request.isPending) status = 'PENDING';
  else if (rendition) {
    const lapsed = rendition.status === 'READY' && lapsedId === rendition.id;
    status =
      lapsed || (rendition.status === 'READY' && isRenditionExpired(rendition))
        ? 'EXPIRED'
        : rendition.status;
  }
  const inProgress = isRenditionInProgress(status ?? undefined);

  const blocked = blockedUntil !== null;
  const target = source.kind === 'version' ? source.versionNumber : null;
  const showGenerate = !(status === 'READY' && source.kind === 'version');
  const baseLabel = source.kind === 'preview' ? t('generate.preview') : t('generate.version');
  let generateLabel = baseLabel;
  if (status === 'FAILED') generateLabel = t('retry');
  else if (status === 'EXPIRED' || (status === 'READY' && source.kind === 'preview')) {
    generateLabel =
      source.kind === 'preview' ? t('generate.again.preview') : t('generate.again.version');
  }

  const targetHint =
    target === null ? null : <span className="sr-only"> {t('target', { number: target })}</span>;

  const message =
    status === 'FAILED'
      ? RENDITION_MESSAGES.failed
      : status === 'EXPIRED'
        ? RENDITION_MESSAGES.previewExpired
        : null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {showGenerate ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={request.isPending || inProgress || blocked}
            onClick={generate}
          >
            {generateLabel}
            {targetHint}
          </Button>
        ) : null}
        {/* Sempre montada: o leitor de tela anuncia cada mudança de situação (polite). */}
        <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-2 text-sm">
          {status ? (
            <>
              {inProgress ? (
                <span
                  aria-hidden="true"
                  className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent motion-reduce:animate-none"
                />
              ) : null}
              <RenditionStatusBadge status={status} />
              {message ? <span className="break-words">{message}</span> : null}
            </>
          ) : null}
        </div>
      </div>

      {shown ? (
        <RenditionErrorAlert
          outcome={shown.outcome}
          onRetry={() => {
            if (shown.origin === 'request') generate();
            else if (shown.origin === 'download' && renditionId) startDownloadOf(renditionId);
            else {
              setFailure(null);
              void query.refetch();
            }
          }}
        />
      ) : null}

      {status === 'READY' && rendition ? (
        <PdfPreviewPanel rendition={rendition}>
          <Button
            variant="primary"
            size="sm"
            disabled={download.isPending || blocked}
            onClick={() => {
              startDownloadOf(rendition.id);
            }}
          >
            {download.isPending ? t('downloading') : t('download')}
            {targetHint}
          </Button>
        </PdfPreviewPanel>
      ) : null}

      {status === 'EXPIRED' ? (
        <div>
          <Button variant="primary" size="sm" disabled>
            {t('previewExpiredAction')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
