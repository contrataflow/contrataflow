'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@contrataflow/ui';
import { QUOTATION_IMPORT_LIMITS, QUOTATION_IMPORT_MESSAGES } from '@contrataflow/validation';
import type { QuotationImportPreview, QuotationImportResult } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';

import { CorrelationCode } from '@/components/errors/correlation-code';
import { newIdempotencyKey } from '@/lib/api/client';

import { ImportPreviewTable } from './import-preview-table';
import { canApply, checkImportFile, classifyImportError } from './quotation-import-model';
import {
  applyQuotationImport,
  downloadImportTemplate,
  previewQuotationImport,
} from './quotation-import.api';
import { saveBlob } from '../process-list/use-csv-download';
import { FormField, INPUT_CLASS } from '../processes/form-field';

/*
 * `ImportQuotationsDialog` (US-028 · SCR-009 · fluxo principal 1–8): "Baixar modelo" (PRS-24),
 * "Enviar planilha" (PRS-18 → prévia com erros por linha/célula, resumo anunciado por `aria-live`)
 * e "Aplicar importação" (PRS-19 com o token e uma `Idempotency-Key` por prévia — FA-05), habilitado
 * só com ao menos uma célula válida (FA-04). Prévia expirada (FA-03) ou arquivo recusado (FA-01)
 * voltam ao envio com a mensagem; documento não editável/sem permissão (FA-06) fecham o diálogo;
 * indisponibilidade mantém a etapa com "Tentar novamente".
 */

const ACCEPT = `${QUOTATION_IMPORT_LIMITS.extension},${QUOTATION_IMPORT_LIMITS.mimeType}`;
const FALLBACK_TEMPLATE_NAME = 'cotacoes.xlsx';

type Busy = 'template' | 'preview' | 'apply' | null;

interface Failure {
  readonly message: string;
  readonly correlationId: string | null;
  readonly retry: (() => Promise<void>) | null;
}

export function ImportQuotationsDialog({
  open,
  researchId,
  onClose,
  onImported,
  onBlocked,
}: {
  readonly open: boolean;
  readonly researchId: string;
  readonly onClose: () => void;
  /** Importação aplicada: recarregar fontes, itens e totais. */
  readonly onImported: (result: QuotationImportResult) => Promise<void>;
  /** Recusa que muda a tela (documento não editável, sem permissão). */
  readonly onBlocked: (code: string) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent closeLabel={null}>
        {open ? (
          <ImportQuotationsFlow
            researchId={researchId}
            onClose={onClose}
            onImported={onImported}
            onBlocked={onBlocked}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ImportQuotationsFlow({
  researchId,
  onClose,
  onImported,
  onBlocked,
}: {
  readonly researchId: string;
  readonly onClose: () => void;
  readonly onImported: (result: QuotationImportResult) => Promise<void>;
  readonly onBlocked: (code: string) => void;
}) {
  const t = useTranslations('priceResearch.sources.import');
  const tErrors = useTranslations('errors.correlation');
  const fieldId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [preview, setPreview] = useState<QuotationImportPreview | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  /** Uma chave por prévia: o reenvio da mesma aplicação repete a chave (FA-05). */
  const applyKey = useRef<string | null>(null);
  const messages = { unavailable: t('errors.unavailable'), unexpected: t('errors.unexpected') };

  const handleFailure = (error: unknown, retry: () => Promise<void>) => {
    const outcome = classifyImportError(error, messages);
    if (outcome.step === 'close') {
      onClose();
      onBlocked(outcome.code);
      return;
    }
    if (outcome.step === 'upload') {
      setPreview(null);
      applyKey.current = null;
      setFailure(null);
      setFileError(outcome.message);
      return;
    }
    setFailure({ message: outcome.message, correlationId: outcome.correlationId, retry });
  };

  const downloadTemplate = async () => {
    setBusy('template');
    setFailure(null);
    try {
      const download = await downloadImportTemplate(researchId);
      saveBlob(download.blob, download.fileName ?? FALLBACK_TEMPLATE_NAME);
    } catch (error) {
      const outcome = classifyImportError(error, messages);
      if (outcome.step === 'close') {
        onClose();
        onBlocked(outcome.code);
      } else {
        setFailure({
          message: t('errors.template'),
          correlationId: outcome.step === 'retry' ? outcome.correlationId : null,
          retry: downloadTemplate,
        });
      }
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    if (file === null) {
      setFileError(QUOTATION_IMPORT_MESSAGES.fileRequired);
      return;
    }
    const check = checkImportFile(file);
    if (!check.ok) {
      setFileError(check.message);
      return;
    }
    setBusy('preview');
    setFailure(null);
    setFileError(null);
    try {
      const result = await previewQuotationImport(researchId, file);
      applyKey.current = newIdempotencyKey();
      setPreview(result);
    } catch (error) {
      handleFailure(error, send);
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (preview === null) return;
    applyKey.current ??= newIdempotencyKey();
    setBusy('apply');
    setFailure(null);
    try {
      const result = await applyQuotationImport(researchId, preview.previewToken, applyKey.current);
      onClose();
      await onImported(result);
    } catch (error) {
      handleFailure(error, apply);
    } finally {
      setBusy(null);
    }
  };

  const failureAlert =
    failure === null ? null : (
      <Alert tone="error" title={failure.message}>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {failure.retry === null ? null : (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => {
                void failure.retry?.();
              }}
            >
              {t('retry')}
            </Button>
          )}
          {failure.correlationId === null ? null : (
            <CorrelationCode
              correlationId={failure.correlationId}
              labels={{
                code: tErrors('label', { correlationId: failure.correlationId }),
                copy: tErrors('copy'),
                copied: tErrors('copied'),
              }}
            />
          )}
        </div>
      </Alert>
    );

  if (preview !== null) {
    const applicable = canApply(preview);
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
        <ImportPreviewTable preview={preview} />
        {applicable ? null : (
          <Alert tone="warning" title={QUOTATION_IMPORT_MESSAGES.noValidCells} />
        )}
        <div aria-live="polite">{failureAlert}</div>
        {busy === 'apply' ? (
          <p role="status" className="text-sm">
            {t('applying')}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="secondary"
            disabled={busy !== null}
            onClick={() => {
              setPreview(null);
              setFile(null);
              setFailure(null);
              applyKey.current = null;
            }}
          >
            {t('back')}
          </Button>
          <Button
            disabled={!applicable || busy !== null}
            onClick={() => {
              void apply();
            }}
          >
            {busy === 'apply' ? t('applying') : t('apply')}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <DialogTitle>{t('title')}</DialogTitle>
      <DialogDescription>{t('description')}</DialogDescription>
      <div>
        <Button
          variant="secondary"
          disabled={busy !== null}
          onClick={() => {
            void downloadTemplate();
          }}
        >
          {busy === 'template' ? t('downloadingTemplate') : t('downloadTemplate')}
        </Button>
      </div>
      <FormField
        id={`${fieldId}-file`}
        label={t('file')}
        hint={t('fileHint')}
        required
        error={fileError ?? undefined}
      >
        {(control) => (
          <input
            {...control}
            type="file"
            accept={ACCEPT}
            className={INPUT_CLASS}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setFileError(null);
              setFailure(null);
            }}
          />
        )}
      </FormField>
      {busy === 'preview' ? (
        <p role="status" className="text-sm">
          {t('sending')}
        </p>
      ) : null}
      <div aria-live="polite">{failureAlert}</div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          disabled={busy !== null}
          onClick={() => {
            void send();
          }}
        >
          {busy === 'preview' ? t('sending') : t('send')}
        </Button>
      </DialogFooter>
    </div>
  );
}
