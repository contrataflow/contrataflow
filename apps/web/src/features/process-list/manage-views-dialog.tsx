'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@contrataflow/ui';
import type { SavedViewDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';
import type { RefObject } from 'react';

import { classifyViewError, validateViewName, viewFailureMessage } from './saved-views-model';

/*
 * `ManageViewsDialog` (US-003 · FA-03): o dono renomeia, exclui (com confirmação) e troca a visão
 * padrão. Só aparecem as visões próprias — as compartilhadas por colegas ficam fora (só podem ser
 * aplicadas ou copiadas). Versão divergente (412), visão removida (404) e `If-Match` ausente (428)
 * recarregam a lista e avisam; o nome repetido (409) aparece no campo.
 */

export interface ManageViewsDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Visões do usuário (as compartilhadas por outros não entram). */
  readonly views: readonly SavedViewDto[];
  readonly onRename: (view: SavedViewDto, name: string) => Promise<unknown>;
  readonly onSetDefault: (view: SavedViewDto, isDefault: boolean) => Promise<unknown>;
  readonly onDelete: (view: SavedViewDto) => Promise<unknown>;
  /** A visão mudou ou sumiu no servidor: recarrega a lista. */
  readonly onStale: () => void;
  readonly returnFocusRef?: RefObject<HTMLElement | null> | undefined;
}

export function ManageViewsDialog({
  open,
  onOpenChange,
  views,
  onRename,
  onSetDefault,
  onDelete,
  onStale,
  returnFocusRef,
}: ManageViewsDialogProps) {
  const t = useTranslations('processList.views.manageDialog');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={t('close')}
        className="max-h-[90vh] overflow-y-auto"
        onCloseAutoFocus={(event) => {
          if (returnFocusRef?.current) {
            event.preventDefault();
            returnFocusRef.current.focus();
          }
        }}
      >
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
        <ManageList
          views={views}
          onRename={onRename}
          onSetDefault={onSetDefault}
          onDelete={onDelete}
          onStale={onStale}
        />
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ManageList({
  views,
  onRename,
  onSetDefault,
  onDelete,
  onStale,
}: Pick<ManageViewsDialogProps, 'views' | 'onRename' | 'onSetDefault' | 'onDelete' | 'onStale'>) {
  const t = useTranslations('processList.views.manageDialog');
  const tViews = useTranslations('processList.views');
  const id = useId();
  const [editing, setEditing] = useState<{ readonly id: string; readonly name: string } | null>(
    null,
  );
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  // Ao abrir "Renomear", o foco vai para o campo do nome.
  const editingId = editing?.id ?? null;
  useEffect(() => {
    if (editingId !== null) document.getElementById(`${id}-${editingId}-name`)?.focus();
  }, [editingId, id]);
  const [notice, setNotice] = useState('');

  const setError = (viewId: string, message: string | null) => {
    setErrors((current) => {
      const { [viewId]: _removed, ...rest } = current;
      return message === null ? rest : { ...rest, [viewId]: message };
    });
  };

  /** Executa uma ação sobre uma visão; devolve `true` se concluiu. */
  const run = async (
    view: SavedViewDto,
    action: () => Promise<unknown>,
    success: string,
  ): Promise<boolean> => {
    setBusyId(view.id);
    setError(view.id, null);
    setNotice('');
    try {
      await action();
      setNotice(success);
      return true;
    } catch (error) {
      const failure = classifyViewError(error, 'change');
      if (
        failure.kind === 'versionConflict' ||
        failure.kind === 'notFound' ||
        failure.kind === 'precondition'
      ) {
        onStale();
      }
      setError(view.id, viewFailureMessage(failure) ?? tViews('unavailable'));
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const saveName = async (view: SavedViewDto, name: string) => {
    const invalid = validateViewName(name);
    if (invalid !== null) {
      setError(view.id, invalid);
      return;
    }
    if (await run(view, () => onRename(view, name.trim()), t('renamed'))) setEditing(null);
  };

  if (views.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <p role="status" className="sr-only">
        {notice}
      </p>
      <ul aria-label={t('list')} className="flex flex-col divide-y divide-border">
        {views.map((view) => {
          const isEditing = editing?.id === view.id;
          const busy = busyId === view.id;
          const error = errors[view.id];
          const errorId = `${id}-${view.id}-error`;
          return (
            <li key={view.id} className="flex flex-col gap-2 py-3">
              {isEditing ? (
                <form
                  noValidate
                  className="flex flex-col gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveName(view, editing.name);
                  }}
                >
                  <label htmlFor={`${id}-${view.id}-name`} className="text-sm font-medium">
                    {t('renameLabel', { name: view.name })}
                  </label>
                  <input
                    id={`${id}-${view.id}-name`}
                    type="text"
                    value={editing.name}
                    aria-invalid={error !== undefined}
                    aria-describedby={error === undefined ? undefined : errorId}
                    onChange={(event) => {
                      setEditing({ id: view.id, name: event.target.value });
                      setError(view.id, null);
                    }}
                    className="h-11 rounded-control border border-border bg-surface px-3 text-sm md:h-9"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" size="sm" disabled={busy}>
                      {t('saveName')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(null);
                        setError(view.id, null);
                      }}
                    >
                      {t('cancel')}
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 text-sm font-medium break-words">{view.name}</span>
                  {view.isDefault ? (
                    <span className="rounded-full bg-primary-soft px-2 text-xs">
                      {t('defaultBadge')}
                    </span>
                  ) : null}
                  {view.isShared ? (
                    <span className="rounded-full bg-muted px-2 text-xs">{t('sharedBadge')}</span>
                  ) : null}
                </div>
              )}

              {confirmingId === view.id ? (
                <div
                  role="group"
                  aria-label={t('deleteConfirm', { name: view.name })}
                  className="flex flex-col gap-2"
                >
                  <p className="text-sm">{t('deleteConfirm', { name: view.name })}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        void run(view, () => onDelete(view), t('deleted')).then((done) => {
                          if (done) setConfirmingId(null);
                        });
                      }}
                    >
                      {t('confirmDelete')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setConfirmingId(null);
                      }}
                    >
                      {t('cancel')}
                    </Button>
                  </div>
                </div>
              ) : isEditing ? null : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    aria-label={t('renameAction', { name: view.name })}
                    onClick={() => {
                      setEditing({ id: view.id, name: view.name });
                      setError(view.id, null);
                    }}
                  >
                    {t('rename')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    aria-label={
                      view.isDefault
                        ? t('removeDefaultAction', { name: view.name })
                        : t('setDefaultAction', { name: view.name })
                    }
                    onClick={() => {
                      void run(
                        view,
                        () => onSetDefault(view, !view.isDefault),
                        t('defaultChanged'),
                      );
                    }}
                  >
                    {view.isDefault ? t('removeDefault') : t('setDefault')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    aria-label={t('deleteAction', { name: view.name })}
                    onClick={() => {
                      setConfirmingId(view.id);
                      setError(view.id, null);
                    }}
                  >
                    {t('delete')}
                  </Button>
                </div>
              )}

              {error !== undefined ? (
                <p id={errorId} role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
