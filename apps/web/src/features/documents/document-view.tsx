'use client';

import { Alert, Skeleton } from '@contrataflow/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef } from 'react';

import { ErrorView } from '@/components/errors/error-view';
import { AiAssistant, isAiTarget } from '@/features/ai/ai-assistant';
import { AttachmentsSection } from '@/features/attachments/attachments-section';
import { CommentsPanel } from '@/features/comments/comments-panel';
import { isApiError } from '@/lib/api/api-error';
import { useTenantId } from '@/lib/session/session-context';

import { AiReviewPanel } from './ai-review';
import { DocumentLifecycle } from './document-lifecycle';
import { DocumentStatusBadge, PendingApprovalBadge } from './document-status-badge';
import { documentKeys, documentVersionsHref, fetchDocument } from './documents.api';
import { GeneratePdfButton } from './generate-pdf-button';
import { SaveVersionAction } from './save-version-dialog';
import { UploadedDocumentFile } from './uploaded-document-file';

export interface DocumentViewProps {
  readonly processId: string;
  readonly documentId: string;
  /** `?ia=<generationId>`: abre o assistente de IA na geração (SCR-117). */
  readonly aiGenerationId?: string | null | undefined;
  /** Foco no título assim que o documento carrega (US-019: chegada à SCR-008 após criar o ETP). */
  readonly focusTitleOnLoad?: boolean | undefined;
}

/**
 * SCR-105 — visualizador do documento com o ciclo de vida (US-065): cabeçalho (código, título,
 * tipo, status, selo "Em aprovação" e versão corrente) e as ações do ciclo de vida; no externo, o
 * arquivo com versões e prévia (US-064). O editor de seções é da US-063. Estados: skeleton na primeira carga e erro com `correlationId` e "Tentar
 * novamente"; 404 mostra a mensagem única (não distingue inexistente de sem acesso).
 */
export function DocumentView({
  processId,
  documentId,
  aiGenerationId = null,
  focusTitleOnLoad = false,
}: DocumentViewProps) {
  const t = useTranslations('documents.view');
  const tErrors = useTranslations('errors');
  const tenantId = useTenantId();
  const heading = useRef<HTMLHeadingElement>(null);
  const focusHeading = useCallback(() => {
    heading.current?.focus();
  }, []);

  const query = useQuery({
    queryKey: documentKeys.detail(tenantId, documentId),
    queryFn: ({ signal }) => fetchDocument(documentId, signal),
    refetchOnWindowFocus: true,
    // O erro fica na tela ("Tentar novamente"); não derruba o segmento.
    throwOnError: false,
  });
  const loaded = query.data !== undefined;
  useEffect(() => {
    if (focusTitleOnLoad && loaded) heading.current?.focus();
  }, [focusTitleOnLoad, loaded]);

  if (!query.data) {
    if (query.isPending) {
      return (
        <div role="status" className="flex flex-col gap-4">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-96 max-w-full" />
          <Skeleton className="h-8 w-64 max-w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      );
    }
    const error = query.error;
    const apiError = isApiError(error) ? error : null;
    const backToProcess = (
      <Link href={`/processos/${processId}`} className="self-center text-sm text-primary underline">
        {t('backToProcess')}
      </Link>
    );
    if (apiError?.status === 404) {
      return (
        <ErrorView
          title={t('notFoundTitle')}
          description={t('notFoundDescription')}
          actions={backToProcess}
        />
      );
    }
    const correlationId = apiError?.correlationId ?? null;
    return (
      <ErrorView
        title={t('loadFailedTitle')}
        description={t('loadFailedDescription')}
        correlationId={correlationId}
        correlationLabels={
          correlationId
            ? {
                code: tErrors('correlation.label', { correlationId }),
                copy: tErrors('correlation.copy'),
                copied: tErrors('correlation.copied'),
              }
            : undefined
        }
        retryLabel={t('retry')}
        onRetry={() => {
          void query.refetch();
        }}
        actions={backToProcess}
      />
    );
  }

  const { document, meta } = query.data;
  return (
    <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-6">
      <header className="flex min-w-0 flex-col gap-2">
        <Link href={`/processos/${processId}`} className="text-sm text-primary underline">
          {t('backToProcess')}
        </Link>
        <p className="text-sm font-medium text-muted-foreground">
          {document.code ?? t('noNumber')}
        </p>
        <h1
          ref={heading}
          tabIndex={-1}
          className="text-2xl font-semibold tracking-tight break-words outline-none"
        >
          {document.title}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <DocumentStatusBadge status={document.status} />
          {document.pendingApprovalId ? <PendingApprovalBadge /> : null}
          <span className="text-sm text-muted-foreground">
            {t('type', { type: document.documentType.name })}
          </span>
          <span className="text-sm text-muted-foreground">
            {document.currentVersionNumber === null
              ? t('noVersion')
              : t('version', { number: document.currentVersionNumber })}
          </span>
          <Link
            href={documentVersionsHref(processId, document.id)}
            className="text-sm text-primary underline"
          >
            {t('versionsLink')}
          </Link>
        </div>
        {/* US-066: "Salvar versão" segue POL-02 (`UPDATE`); externo cria versão por upload (FA-02). */}
        {meta.allowedActions.includes('UPDATE') && document.documentType.kind !== 'UPLOADED' ? (
          <div>
            <SaveVersionAction document={document} />
          </div>
        ) : null}
        {/* US-067: prévia em PDF do rascunho (DOC-20); quem vê o documento (PROCESS_VIEW) pode gerar. */}
        {document.documentType.kind !== 'UPLOADED' ? (
          <GeneratePdfButton source={{ kind: 'preview', documentId: document.id }} />
        ) : null}
        {isAiTarget(document.documentType.systemModule) ? (
          <div>
            <AiAssistant
              processId={processId}
              documentId={document.id}
              targetModule={document.documentType.systemModule}
              editable={document.status === 'DRAFT' || document.status === 'RETURNED'}
              initialGenerationId={aiGenerationId}
            />
          </div>
        ) : null}
      </header>

      {document.status === 'CANCELED' && document.cancellationReason ? (
        <Alert tone="warning" live={false} title={t('cancellationReason')}>
          <p className="break-words whitespace-pre-line">{document.cancellationReason}</p>
        </Alert>
      ) : null}

      {/* US-122: marcas de IA e revisão humana por seção (DOC-27) antes das ações do ciclo de vida. */}
      <AiReviewPanel document={document} meta={meta} />

      <DocumentLifecycle document={document} meta={meta} fallbackFocus={focusHeading} />

      {/* US-064: o externo é o próprio arquivo — envio, versão corrente e prévia; os demais tipos
          recebem anexos (US-068: anexar exige poder editar — POL-02 → `UPDATE`). */}
      {document.documentType.kind === 'UPLOADED' ? (
        <UploadedDocumentFile document={document} meta={meta} />
      ) : (
        <AttachmentsSection
          targetType="DOCUMENT"
          targetId={document.id}
          processId={document.processId}
          action="UPDATE"
          allowedActions={meta.allowedActions}
        />
      )}

      {/* US-071: comentários do documento (alvo `DOCUMENT`, seção opcional — o externo não tem). */}
      <CommentsPanel
        processId={processId}
        document={{
          id: document.id,
          label: document.code ?? document.title,
          sections:
            document.documentType.kind === 'UPLOADED'
              ? []
              : Object.keys(document.draftContent.sections).map((key) => ({ key, title: key })),
        }}
      />
    </div>
  );
}
