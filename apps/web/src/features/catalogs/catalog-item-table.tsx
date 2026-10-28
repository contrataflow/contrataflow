'use client';

import { Button } from '@contrataflow/ui';
import type { CatalogItemDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Can } from '@/lib/permissions/can';
import { usePermission } from '@/lib/permissions/use-permission';

function Badge({
  children,
  tone,
}: {
  readonly children: string;
  readonly tone: 'muted' | 'ok' | 'system';
}) {
  const classes = {
    ok: 'bg-success-soft text-foreground',
    muted: 'bg-muted text-muted-foreground',
    system: 'border border-border bg-surface text-foreground',
  } as const;
  return (
    <span
      className={`inline-flex rounded-control px-2 py-0.5 text-xs font-medium ${classes[tone]}`}
    >
      {children}
    </span>
  );
}

export interface CatalogItemTableProps {
  readonly caption: string;
  readonly items: readonly CatalogItemDto[];
  readonly busy: boolean;
  readonly onEdit: (item: CatalogItemDto) => void;
  readonly onDeactivate: (item: CatalogItemDto) => void;
  readonly onActivate: (item: CatalogItemDto) => void;
  /** Move o item de uma posição para outra (arrastar ou "Mover para cima/baixo"). */
  readonly onMove: (from: number, to: number) => void;
}

/**
 * `CatalogItemTable` (SCR-109 · US-104 · passo 2): código, rótulo, selo "Padrão do sistema" e
 * situação. Não existe "Excluir" para nenhum item (RN-TEN-64). Com `CATALOG_MANAGE`, as linhas
 * são arrastáveis para reordenar e cada uma tem "Mover para cima/baixo" (alternativa por teclado).
 */
export function CatalogItemTable({
  caption,
  items,
  busy,
  onEdit,
  onDeactivate,
  onActivate,
  onMove,
}: CatalogItemTableProps) {
  const t = useTranslations('catalogs');
  const canManage = usePermission('CATALOG_MANAGE').allowed;
  const [dragging, setDragging] = useState<number | null>(null);

  return (
    <div className="relative overflow-x-auto rounded-card border border-border bg-surface shadow-card">
      <table className="w-full min-w-[44rem] text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-muted text-xs text-muted-foreground uppercase">
          <tr>
            <th scope="col" className="w-16 px-3 py-2">
              {t('table.order')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.code')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.label')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.status')}
            </th>
            <Can permission="CATALOG_MANAGE">
              <th scope="col" className="px-3 py-2">
                {t('table.actions')}
              </th>
            </Can>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr
              key={item.id}
              draggable={canManage && !busy}
              onDragStart={(event) => {
                setDragging(index);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(event) => {
                if (dragging !== null) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging !== null && dragging !== index) onMove(dragging, index);
                setDragging(null);
              }}
              onDragEnd={() => {
                setDragging(null);
              }}
              className={`border-t border-border align-top ${
                dragging === index ? 'opacity-60' : ''
              } ${item.isActive ? '' : 'text-muted-foreground'}`}
            >
              <td className="px-3 py-2 tabular-nums">{index + 1}</td>
              <td className="px-3 py-2 font-mono text-xs">{item.code}</td>
              <th scope="row" className="px-3 py-2 font-medium">
                {item.label}
              </th>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  <Badge tone={item.isActive ? 'ok' : 'muted'}>
                    {item.isActive ? t('badges.active') : t('badges.inactive')}
                  </Badge>
                  {item.isSystem ? <Badge tone="system">{t('badges.system')}</Badge> : null}
                </div>
              </td>
              <Can permission="CATALOG_MANAGE">
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={t('actions.edit', { name: item.label })}
                      onClick={() => {
                        onEdit(item);
                      }}
                    >
                      {t('actions.editLabel')}
                    </Button>
                    {item.isActive ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t('actions.deactivate', { name: item.label })}
                        onClick={() => {
                          onDeactivate(item);
                        }}
                      >
                        {t('actions.deactivateLabel')}
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t('actions.activate', { name: item.label })}
                        disabled={busy}
                        onClick={() => {
                          onActivate(item);
                        }}
                      >
                        {t('actions.activateLabel')}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('actions.moveUp', { name: item.label })}
                      disabled={busy || index === 0}
                      onClick={() => {
                        onMove(index, index - 1);
                      }}
                    >
                      {t('actions.moveUpLabel')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('actions.moveDown', { name: item.label })}
                      disabled={busy || index === items.length - 1}
                      onClick={() => {
                        onMove(index, index + 1);
                      }}
                    >
                      {t('actions.moveDownLabel')}
                    </Button>
                  </div>
                </td>
              </Can>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
