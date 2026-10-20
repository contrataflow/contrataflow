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
import { aiTermsDocument } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

export interface AiTermsDialogProps {
  readonly open: boolean;
  /** Versão vigente (`meta.aiTerms.currentVersion` do SET-01). */
  readonly version: string;
  /** `enable`: aceitar e ligar; `accept`: só aceitar a nova versão (IA já ligada — FA-02). */
  readonly mode: 'enable' | 'accept';
  readonly pending: boolean;
  readonly error: string | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * `AiTermsDialog` (US-116 · SCR-041): os termos de uso da versão vigente (texto versionado em
 * `@contrataflow/validation`) e "Li e aceito". O botão de confirmar fica desabilitado até o aceite
 * (FA-01). Foco preso e fechável por teclado (Radix).
 */
export function AiTermsDialog({
  open,
  version,
  mode,
  pending,
  error,
  onConfirm,
  onCancel,
}: AiTermsDialogProps) {
  const t = useTranslations('ai.admin.terms');
  const checkboxId = useId();
  const [accepted, setAccepted] = useState(false);
  const document = aiTermsDocument(version);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setAccepted(false);
          onCancel();
        }
      }}
    >
      <DialogContent
        className="h-dvh max-h-dvh overflow-y-auto md:h-auto md:max-h-[90vh]"
        style={{ maxWidth: '40rem' }}
      >
        <DialogTitle>{document.title}</DialogTitle>
        <DialogDescription>{`Versão ${document.version}`}</DialogDescription>
        <div className="mt-4 flex flex-col gap-4 text-sm">
          {document.sections.map((section) => (
            <section key={section.title} className="flex flex-col gap-1">
              <h3 className="font-semibold">{section.title}</h3>
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph} className="text-muted-foreground">
                  {paragraph}
                </p>
              ))}
            </section>
          ))}
        </div>
        {error === null ? null : <Alert tone="error" title={error} className="mt-4" />}
        <div className="mt-4 flex items-start gap-2">
          <input
            id={checkboxId}
            type="checkbox"
            className="mt-1 size-4"
            checked={accepted}
            onChange={(event) => {
              setAccepted(event.target.checked);
            }}
          />
          <label htmlFor={checkboxId} className="text-sm font-medium">
            {t('accept', { version: document.version })}
          </label>
        </div>
        <DialogFooter className="mt-6">
          <Button
            variant="secondary"
            onClick={() => {
              setAccepted(false);
              onCancel();
            }}
          >
            {t('cancel')}
          </Button>
          <Button
            disabled={!accepted || pending}
            aria-busy={pending}
            onClick={() => {
              onConfirm();
            }}
          >
            {mode === 'enable' ? t('activate') : t('acceptOnly')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
