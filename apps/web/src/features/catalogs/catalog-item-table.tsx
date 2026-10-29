'use client';

import {
  ChevronDown,
  ChevronUp,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Ellipsis,
  Lock,
  StatusChip,
  Table,
  TableBody,
  TableHead,
  Td,
  Th,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Tr,
} from '@contrataflow/ui';
import type { CatalogItemDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { usePermission } from '@/lib/permissions/use-permission';

const ICON_BUTTON =
  'inline-grid size-9 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40';

export interface CatalogItemTableProps {
  readonly caption: string;
  readonly items: readonly CatalogItemDto[];
  readonly busy: boolean;
  readonly onEdit: (item: CatalogItemDto) => void;
  readonly onDeactivate: (item: CatalogItemDto) => void;
  readonly onActivate: (item: CatalogItemDto) => void;
  /** Move o item de uma posição para outra (arrastar ou setas "Mover para cima/baixo"). */
  readonly onMove: (from: number, to: number) => void;
}

/**
 * `CatalogItemTable` (SCR-109 · US-104 · passo 2 · prd-5): rótulo em negrito com o código estável
 * na linha secundária, situação e selo "Padrão do sistema" (cadeado com a explicação de que o item
 * é imutável). Não existe "Excluir" para nenhum item (RN-TEN-64). Com `CATALOG_MANAGE`, as linhas
 * são arrastáveis, cada uma tem as setas "Mover para cima/baixo" (alternativa por teclado) e o
 * menu ⋯ com "Editar" e "Desativar/Ativar".
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
    <Table>
      <caption className="sr-only">{caption}</caption>
      <TableHead>
        <Tr>
          <Th className="w-28">{t('table.order')}</Th>
          <Th>{t('table.label')}</Th>
          <Th>{t('table.status')}</Th>
          {canManage ? (
            <Th className="w-12">
              <span className="sr-only">{t('table.actions')}</span>
            </Th>
          ) : null}
        </Tr>
      </TableHead>
      <TableBody>
        {items.map((item, index) => (
          <Tr
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
            className={dragging === index ? 'opacity-60' : undefined}
          >
            <Td className="tabular-nums">
              <div className="flex items-center gap-1">
                <span className="w-6 text-muted-foreground">{index + 1}</span>
                {canManage ? (
                  <>
                    <button
                      type="button"
                      className={ICON_BUTTON}
                      aria-label={t('actions.moveUp', { name: item.label })}
                      disabled={busy || index === 0}
                      onClick={() => {
                        onMove(index, index - 1);
                      }}
                    >
                      <ChevronUp aria-hidden="true" className="size-4" />
                    </button>
                    <button
                      type="button"
                      className={ICON_BUTTON}
                      aria-label={t('actions.moveDown', { name: item.label })}
                      disabled={busy || index === items.length - 1}
                      onClick={() => {
                        onMove(index, index + 1);
                      }}
                    >
                      <ChevronDown aria-hidden="true" className="size-4" />
                    </button>
                  </>
                ) : null}
              </div>
            </Td>
            <th scope="row" className="px-3.5 py-3 text-left font-normal">
              <span className={item.isActive ? 'font-bold' : 'font-bold text-muted-foreground'}>
                {item.label}
              </span>
              <span className="block font-mono text-xs text-muted-foreground">{item.code}</span>
            </th>
            <Td>
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusChip tone={item.isActive ? 'success' : 'neutral'}>
                  {item.isActive ? t('badges.active') : t('badges.inactive')}
                </StatusChip>
                {item.isSystem ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={t('system.tooltipLabel', { name: item.label })}
                        className="rounded-full"
                      >
                        <StatusChip tone="info" icon={<Lock />}>
                          {t('badges.system')}
                        </StatusChip>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t('system.tooltip')}</TooltipContent>
                  </Tooltip>
                ) : null}
              </div>
            </Td>
            {canManage ? (
              <Td className="w-12 py-1.5 text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t('actions.menu', { name: item.label })}
                      className="inline-grid size-11 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground md:size-9"
                    >
                      <Ellipsis aria-hidden="true" className="size-[1.125rem]" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => {
                        onEdit(item);
                      }}
                    >
                      {t('actions.editLabel')}
                    </DropdownMenuItem>
                    {item.isActive ? (
                      <DropdownMenuItem
                        onSelect={() => {
                          onDeactivate(item);
                        }}
                      >
                        {t('actions.deactivateLabel')}
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        disabled={busy}
                        onSelect={() => {
                          onActivate(item);
                        }}
                      >
                        {t('actions.activateLabel')}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </Td>
            ) : null}
          </Tr>
        ))}
      </TableBody>
    </Table>
  );
}
