'use client';

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Label,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import type { Ref } from 'react';

import type { GroupedViews } from './saved-views-model';

/*
 * `SavedViewSelect` (SCR-004 · US-003): seletor de visões com os grupos "Minhas visões" e
 * "Compartilhadas" (com o nome do dono) — um `Select` do kit rotulado, acessível por teclado e
 * leitor de tela e confortável no mobile. Skeleton enquanto carrega, erro com nova tentativa e o
 * estado vazio orientando a salvar a primeira visão. O menu "Ações da visão" reúne exportar a
 * visão (FA-06), "Salvar como minha" (FA-04) e "Gerenciar visões" (FA-03).
 */

export interface SavedViewSelectProps {
  readonly grouped: GroupedViews;
  readonly appliedId: string | null;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly onRetry: () => void;
  readonly onSelect: (id: string) => void;
  /** A visão aplicada é de outro dono (só pode ser aplicada ou copiada). */
  readonly appliedIsShared: boolean;
  readonly canExportView: boolean;
  readonly onExportView: () => void;
  readonly onSaveAsMine: () => void;
  readonly onManage: () => void;
  /** Gatilho do menu: para devolver o foco ao fechar um diálogo aberto por ele. */
  readonly menuTriggerRef: Ref<HTMLButtonElement>;
}

export function SavedViewSelect({
  grouped,
  appliedId,
  isPending,
  isError,
  onRetry,
  onSelect,
  appliedIsShared,
  canExportView,
  onExportView,
  onSaveAsMine,
  onManage,
  menuTriggerRef,
}: SavedViewSelectProps) {
  const t = useTranslations('processList.views');
  const id = useId();
  const hasViews = grouped.mine.length + grouped.shared.length > 0;

  if (isPending) {
    return (
      <div role="status" className="flex min-w-0 flex-1 flex-col gap-1 md:max-w-sm">
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-11 w-full md:h-9" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">
        <span role="alert">{t('loadError')}</span>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {t('retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 md:max-w-md">
      {hasViews ? (
        <div className="flex items-center gap-2">
          <Label htmlFor={id}>{t('selectLabel')}</Label>
          <Select
            value={appliedId ?? ''}
            onValueChange={(value) => {
              if (value !== '') onSelect(value);
            }}
          >
            <SelectTrigger id={id} className="min-w-0 flex-1">
              <SelectValue placeholder={t('placeholder')} />
            </SelectTrigger>
            <SelectContent>
              {grouped.mine.length > 0 ? (
                <SelectGroup>
                  <SelectLabel>{t('mine')}</SelectLabel>
                  {grouped.mine.map((view) => (
                    <SelectItem key={view.id} value={view.id}>
                      {view.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
              {grouped.shared.length > 0 ? (
                <SelectGroup>
                  <SelectLabel>{t('shared')}</SelectLabel>
                  {grouped.shared.map((view) => (
                    <SelectItem key={view.id} value={view.id}>
                      {t('sharedOption', { name: view.name, owner: view.owner.name })}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {grouped.mine.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('empty')}</p>
      ) : null}
      <ActionsMenu
        appliedIsShared={appliedIsShared}
        canExportView={canExportView}
        onExportView={onExportView}
        onSaveAsMine={onSaveAsMine}
        onManage={onManage}
        triggerRef={menuTriggerRef}
        hasViews={hasViews}
      />
    </div>
  );
}

function ActionsMenu({
  appliedIsShared,
  canExportView,
  onExportView,
  onSaveAsMine,
  onManage,
  triggerRef,
  hasViews,
}: {
  readonly appliedIsShared: boolean;
  readonly canExportView: boolean;
  readonly onExportView: () => void;
  readonly onSaveAsMine: () => void;
  readonly onManage: () => void;
  readonly triggerRef: Ref<HTMLButtonElement>;
  readonly hasViews: boolean;
}) {
  const t = useTranslations('processList.views');
  const tExport = useTranslations('processList.export');
  if (!hasViews) return null;
  return (
    <div className="self-start">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={triggerRef} variant="ghost" size="sm" aria-haspopup="menu">
            {t('actions')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {canExportView ? (
            <DropdownMenuItem onSelect={onExportView}>{tExport('button')}</DropdownMenuItem>
          ) : null}
          {appliedIsShared ? (
            <DropdownMenuItem onSelect={onSaveAsMine}>{t('saveAsMine')}</DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={onManage}>{t('manage')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
