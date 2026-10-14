'use client';

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

export interface ConflictDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onReload: () => void;
  /** Comparação campo a campo; cada tela de negócio fornece a sua (DEC-182). */
  readonly onShowDiff?: (() => void) | undefined;
}

/**
 * Diálogo padrão de conflito (409/412 — FA-05): genérico e reutilizável até cada tela trocar o
 * conteúdo pelo específico (`SectionConflictDialog`, `HeaderConflictDialog`…).
 */
export function ConflictDialog({ open, onOpenChange, onReload, onShowDiff }: ConflictDialogProps) {
  const t = useTranslations('errors.conflict');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">{t('cancel')}</Button>
          </DialogClose>
          {onShowDiff ? (
            <Button variant="secondary" onClick={onShowDiff}>
              {t('diff')}
            </Button>
          ) : null}
          <Button onClick={onReload}>{t('reload')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
