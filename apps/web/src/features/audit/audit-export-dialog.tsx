'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Field,
  Label,
  RadioGroup,
  RadioGroupItem,
} from '@contrataflow/ui';
import { AUDIT_EXPORT_FORMATS } from '@contrataflow/validation';
import type { AuditExportFormat } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import type { AuditFailure } from './audit-log-model';

export interface AuditExportDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onExport: (format: AuditExportFormat) => void;
  readonly pending: boolean;
  /** Falha da última exportação (422 `EXPORT_TOO_LARGE`, 429, 503…). */
  readonly failure: AuditFailure | null;
}

/**
 * `ExportDialog` (SCR-037 · AUD-03): formato (CSV ou NDJSON, padrão CSV — RN-AUD-19) e
 * confirmação. A exportação reaproveita os filtros da última pesquisa; o botão fica desabilitado
 * enquanto o arquivo é gerado. Acima do limite (FA-02), mostra a mensagem da API e a sugestão de
 * refinar; o MFA ausente (FA-04) cai no step-up global e a exportação é repetida na volta.
 */
export function AuditExportDialog({
  open,
  onOpenChange,
  onExport,
  pending,
  failure,
}: AuditExportDialogProps) {
  const t = useTranslations('audit.records.export');
  const tErrors = useTranslations('audit.records.errors');
  const id = useId();
  const [format, setFormat] = useState<AuditExportFormat>('csv');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('cancel')}>
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            onExport(format);
          }}
        >
          <Field label={t('format')} group>
            <RadioGroup
              value={format}
              onValueChange={(value) => {
                setFormat(value as AuditExportFormat);
              }}
            >
              {AUDIT_EXPORT_FORMATS.map((option) => (
                <div key={option} className="flex items-center gap-2.5">
                  <RadioGroupItem id={`${id}-format-${option}`} value={option} />
                  <Label htmlFor={`${id}-format-${option}`} className="font-normal">
                    {t(option)}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </Field>

          {failure?.kind === 'tooLarge' ? (
            <Alert tone="error" title={failure.message}>
              <p className="text-sm">{t('tooLargeHint')}</p>
            </Alert>
          ) : null}
          {failure?.kind === 'rateLimited' ? <Alert tone="info" title={t('rateLimited')} /> : null}
          {failure?.kind === 'forbidden' ? <Alert tone="error" title={t('forbidden')} /> : null}
          {failure?.kind === 'validation' ? <Alert tone="error" title={failure.message} /> : null}
          {failure?.kind === 'unavailable' || failure?.kind === 'unexpected' ? (
            <Alert tone="error" title={tErrors('unavailable')}>
              {failure.correlationId ? (
                <p className="text-sm">
                  {tErrors('code', { correlationId: failure.correlationId })}
                </p>
              ) : null}
            </Alert>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {pending ? t('exporting') : t('confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
