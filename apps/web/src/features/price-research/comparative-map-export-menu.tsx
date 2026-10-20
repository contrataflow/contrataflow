'use client';

import { Alert, Button, toast } from '@contrataflow/ui';
import { COMPARATIVE_MAP_MESSAGES, comparativeMapFileName } from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { describeExportError } from './comparative-map-model';
import type { ExportFailure } from './comparative-map-model';
import { downloadComparativeMapXlsx } from './comparative-map.api';
import { GeneratePdfButton } from '../documents/generate-pdf-button';
import { saveBlob } from '../process-list/use-csv-download';

/*
 * `ExportMenu` da SCR-010 (US-031): "Exportar XLSX" (PRS-22, síncrono — o arquivo baixa direto) e
 * "Gerar PDF" (o `GeneratePdfButton` do US-067 faz o papel de `RenditionStatusPoller`: DOC-20 →
 * DOC-22 a cada 2 s até `READY`/`FAILED` → DOC-23). Os dois caminhos são independentes (FA-02): a
 * falha do PDF não bloqueia o XLSX e vice-versa. Acima do teto (FA-01) a mensagem sugere o PDF ou
 * reduzir o recorte; indisponibilidade mantém o mapa em tela com "Tentar novamente".
 */
export function ComparativeMapExportMenu({
  researchId,
  code,
}: {
  readonly researchId: string;
  readonly code: string | null;
}) {
  const t = useTranslations('priceResearch.map.export');
  const router = useRouter();
  const [failure, setFailure] = useState<ExportFailure | null>(null);

  const exportXlsx = useMutation({
    mutationFn: () => downloadComparativeMapXlsx(researchId),
    onSuccess: (download) => {
      saveBlob(download.blob, download.fileName ?? comparativeMapFileName(code));
      toast({ title: t('done'), tone: 'success' });
    },
    onError: (error: unknown) => {
      const outcome = describeExportError(error);
      if (outcome.kind === 'notFound') {
        router.push('/processos');
        return;
      }
      setFailure(outcome);
    },
  });

  const start = () => {
    setFailure(null);
    exportXlsx.mutate();
  };

  return (
    <section aria-label={t('label')} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-start gap-3">
        <Button variant="primary" size="sm" disabled={exportXlsx.isPending} onClick={start}>
          {exportXlsx.isPending ? (
            <span
              aria-hidden="true"
              className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
            />
          ) : null}
          {exportXlsx.isPending ? t('exporting') : t('xlsx')}
        </Button>
        <GeneratePdfButton
          source={{ kind: 'preview', documentId: researchId }}
          label={t('pdf')}
          failedMessage={COMPARATIVE_MAP_MESSAGES.pdfFailed}
        />
      </div>
      {failure === null ? null : failure.kind === 'tooLarge' ? (
        <Alert tone="warning" title={failure.message}>
          <p>{t('tooLargeHint')}</p>
        </Alert>
      ) : (
        <Alert tone="error" title={failure.message}>
          {failure.kind === 'retry' && failure.correlationId !== null ? (
            <p className="text-xs break-all text-muted-foreground">
              {t('correlationId', { id: failure.correlationId })}
            </p>
          ) : null}
          <Button size="sm" variant="secondary" className="mt-2" onClick={start}>
            {t('retry')}
          </Button>
        </Alert>
      )}
    </section>
  );
}
