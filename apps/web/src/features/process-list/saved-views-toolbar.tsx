'use client';

import { Alert, Button } from '@contrataflow/ui';
import { SAVED_VIEW_MESSAGES } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';

import { ManageViewsDialog } from './manage-views-dialog';
import { SaveViewDialog } from './save-view-dialog';
import { SavedViewSelect } from './saved-view-select';
import { viewFailureMessage } from './saved-views-model';
import type { SavedViewsController } from './use-saved-views';

/*
 * Barra de visões de SCR-004 (US-003): seletor de visões, "Salvar visão", chip "Visão: {nome}" com "Limpar" (FA-01), indicador "Alterações
 * não salvas" com "Atualizar visão"/"Salvar como nova" (FA-02), aviso de filtros desatualizados
 * (FA-05) e os conflitos de PRC-37 (412 → "Recarregar a visão" / "Salvar como nova"; 403 →
 * "Salvar como minha"). "Exportar CSV" (só com `PROCESS_EXPORT`) fica no cabeçalho da página
 * (prd-4); o item "Exportar CSV" do menu da visão (FA-06) pede a exportação por `onExport`.
 */

type Dialog = 'save' | 'copy' | 'manage' | null;

export interface SavedViewsToolbarProps {
  readonly controller: SavedViewsController;
  readonly canExport: boolean;
  /** Abre a exportação da página; `trigger` recebe o foco de volta ao fechar. */
  readonly onExport: (trigger: HTMLElement | null) => void;
  /** Resumo textual dos critérios atuais ("Status: Em andamento · Atrasados"). */
  readonly summarize: () => string;
}

export function SavedViewsToolbar({
  controller,
  canExport,
  onExport,
  summarize,
}: SavedViewsToolbarProps) {
  const t = useTranslations('processList.views');
  const [dialog, setDialog] = useState<Dialog>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const { applied, unsaved, conflict } = controller;

  const open = (next: Exclude<Dialog, null>, trigger: HTMLElement | null) => {
    returnFocus.current = trigger;
    setDialog(next);
  };
  const close = (isOpen: boolean) => {
    if (!isOpen) setDialog(null);
  };

  const conflictActions = conflict === null ? null : conflictControls(conflict.kind);

  return (
    <section aria-label={t('label')} className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 md:flex-row md:items-start">
        <SavedViewSelect
          grouped={controller.grouped}
          appliedId={applied?.id ?? null}
          isPending={controller.isPending}
          isError={controller.isError}
          onRetry={() => void controller.refetch()}
          onSelect={controller.select}
          appliedIsShared={applied !== null && !applied.isOwner}
          canExportView={canExport && applied !== null}
          onExportView={() => {
            // FA-06: aplica a visão (se a lista divergiu dela) e abre a exportação.
            if (applied !== null && unsaved) controller.apply(applied);
            onExport(menuTrigger.current);
          }}
          onSaveAsMine={() => {
            open('copy', menuTrigger.current);
          }}
          onManage={() => {
            open('manage', menuTrigger.current);
          }}
          menuTriggerRef={menuTrigger}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={(event) => {
              open('save', event.currentTarget);
            }}
          >
            {t('save')}
          </Button>
        </div>
      </div>

      {applied !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex min-h-11 items-center gap-2 rounded-full bg-muted px-3 text-xs md:min-h-7">
            {t('origin', { name: applied.name })}
            <button
              type="button"
              aria-label={t('clearLabel', { name: applied.name })}
              className="text-primary underline"
              onClick={controller.clear}
            >
              {t('clear')}
            </button>
          </span>
        </div>
      ) : null}

      <div aria-live="polite" className="text-sm font-medium">
        {unsaved && applied !== null ? t('unsaved') : null}
      </div>
      {unsaved && applied !== null ? (
        <div className="flex flex-wrap gap-2">
          {applied.isOwner ? (
            <>
              <Button
                size="sm"
                disabled={controller.updating}
                aria-busy={controller.updating}
                onClick={() => void controller.updateApplied()}
              >
                {t('update')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={(event) => {
                  open('save', event.currentTarget);
                }}
              >
                {t('saveAsNew')}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              onClick={(event) => {
                open('copy', event.currentTarget);
              }}
            >
              {t('saveAsMine')}
            </Button>
          )}
        </div>
      ) : null}

      {controller.staleFilters ? (
        <Alert tone="warning" title={SAVED_VIEW_MESSAGES.staleFilters} />
      ) : null}

      {conflict !== null ? (
        <Alert tone="warning" title={viewFailureMessage(conflict) ?? t('unavailable')}>
          <div className="mt-2 flex flex-wrap gap-2">
            {conflictActions?.reload === true ? (
              <Button size="sm" onClick={() => void controller.reloadApplied()}>
                {t('reload')}
              </Button>
            ) : null}
            {conflictActions?.saveAsNew === true ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={(event) => {
                  open('save', event.currentTarget);
                }}
              >
                {t('saveAsNew')}
              </Button>
            ) : null}
            {conflictActions?.saveAsMine === true ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={(event) => {
                  open('copy', event.currentTarget);
                }}
              >
                {t('saveAsMine')}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={controller.dismissConflict}>
              {t('dismiss')}
            </Button>
          </div>
        </Alert>
      ) : null}

      {dialog === 'save' || dialog === 'copy' ? (
        <SaveViewDialog
          open
          onOpenChange={close}
          mode={dialog === 'copy' ? 'copy' : 'new'}
          initialName={dialog === 'copy' ? (applied?.name ?? '') : ''}
          summary={summarize()}
          onSubmit={controller.create}
          returnFocusRef={returnFocus}
        />
      ) : null}
      {dialog === 'manage' ? (
        <ManageViewsDialog
          open
          onOpenChange={close}
          views={controller.grouped.mine}
          onRename={(view, name) => controller.patch(view, { name })}
          onSetDefault={(view, isDefault) => controller.patch(view, { isDefault })}
          onDelete={controller.remove}
          onStale={() => void controller.refetch()}
          returnFocusRef={returnFocus}
        />
      ) : null}
    </section>
  );
}

/** Quais saídas cada conflito de PRC-37 oferece ("Casos de erro" da US-003). */
function conflictControls(kind: string): {
  readonly reload: boolean;
  readonly saveAsNew: boolean;
  readonly saveAsMine: boolean;
} {
  switch (kind) {
    case 'versionConflict':
      return { reload: true, saveAsNew: true, saveAsMine: false };
    case 'precondition':
      return { reload: true, saveAsNew: false, saveAsMine: false };
    case 'notOwner':
      return { reload: false, saveAsNew: false, saveAsMine: true };
    default:
      return { reload: false, saveAsNew: false, saveAsMine: false };
  }
}
