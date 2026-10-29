'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Checkbox,
  Label,
} from '@contrataflow/ui';
import type { Violation } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { warningCodes } from './document-errors';
import type { DocumentOutcome } from './document-errors';
import { OutcomeAlert } from './outcome-alert';
import { useReturnFocus } from './use-return-focus';
import { ViolationList } from './violation-list';

export interface AcknowledgeWarningsDialogProps {
  readonly open: boolean;
  readonly action: 'FINALIZE' | 'SUBMIT';
  /** Só avisos (`WARNING`): sem pendência bloqueante, a ação segue depois do reconhecimento. */
  readonly warnings: readonly Violation[];
  readonly pending: boolean;
  readonly feedback: DocumentOutcome | null;
  /** Recebe os `code` dos avisos, que vão em `acknowledgedWarnings`. */
  readonly onConfirm: (acknowledgedWarnings: string[]) => void;
  readonly onRetry: () => void;
  readonly onCancel: () => void;
}

/**
 * `AcknowledgeWarningsDialog` (US-065 · V-02): a ação só é habilitada depois que o usuário marca
 * "Reconheço os avisos"; a confirmação envia os códigos dos avisos listados.
 */
export function AcknowledgeWarningsDialog(props: AcknowledgeWarningsDialogProps) {
  const { open, pending, onCancel } = props;
  const checkbox = useRef<HTMLButtonElement>(null);
  const returnFocus = useReturnFocus();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
    >
      <DialogContent
        onOpenAutoFocus={(event) => {
          returnFocus.remember();
          event.preventDefault();
          checkbox.current?.focus();
        }}
        onCloseAutoFocus={returnFocus.restore}
      >
        <Body {...props} checkbox={checkbox} />
      </DialogContent>
    </Dialog>
  );
}

function Body({
  action,
  warnings,
  pending,
  feedback,
  onConfirm,
  onRetry,
  onCancel,
  checkbox,
}: AcknowledgeWarningsDialogProps & {
  readonly checkbox: RefObject<HTMLButtonElement | null>;
}) {
  const t = useTranslations('documents.acknowledge');
  const tPanel = useTranslations('documents.completeness');
  const id = useId();
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <>
      <DialogTitle>{t('title')}</DialogTitle>
      <DialogDescription>{t('description')}</DialogDescription>

      <ViolationList label={t('listLabel')} violations={warnings} />

      <div className="flex items-start gap-2">
        <Checkbox
          id={`${id}-ack`}
          ref={checkbox}
          checked={acknowledged}
          onCheckedChange={(checked) => {
            setAcknowledged(checked === true);
          }}
        />
        <Label htmlFor={`${id}-ack`} className="font-medium">
          {t('checkbox')}
        </Label>
      </div>

      <div aria-live="assertive">
        {feedback ? <OutcomeAlert outcome={feedback} onRetry={onRetry} /> : null}
      </div>

      <DialogFooter>
        <Button variant="secondary" disabled={pending} onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button
          disabled={!acknowledged || pending}
          aria-busy={pending}
          onClick={() => {
            onConfirm(warningCodes(warnings));
          }}
        >
          {pending ? tPanel('working') : tPanel(`confirm.${action}`)}
        </Button>
      </DialogFooter>
    </>
  );
}
