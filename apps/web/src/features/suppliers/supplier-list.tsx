'use client';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Ellipsis,
  StatusChip,
  Table,
  TableBody,
  TableHead,
  Td,
  Th,
  Tr,
} from '@contrataflow/ui';
import type { SupplierDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

import { formatDate } from '@/lib/i18n/format';
import { usePermission } from '@/lib/permissions/use-permission';
import { useShellSession } from '@/lib/session/session-context';

import { displayDocument } from './supplier-form-model';

export interface SupplierListProps {
  readonly suppliers: readonly SupplierDto[];
  readonly onEdit: (supplier: SupplierDto) => void;
  readonly onDeactivate: (supplier: SupplierDto) => void;
  readonly onReactivate: (supplier: SupplierDto) => void;
  readonly onDelete: (supplier: SupplierDto) => void;
}

/**
 * `SupplierList` (SCR-107 · US-025 · prd-5): razão social em negrito com nome fantasia e documento
 * (CPF mascarado) na linha secundária, contato, situação e última atualização; "Editar",
 * "Inativar"/"Reativar" e "Excluir" no menu ⋯ da linha, só com `SUPPLIER_MANAGE` (a API decide
 * cada requisição). Em tela estreita contato e atualização saem; a caixa do `ListPage` rola na
 * horizontal só se ainda faltar espaço.
 */
export function SupplierList({
  suppliers,
  onEdit,
  onDeactivate,
  onReactivate,
  onDelete,
}: SupplierListProps) {
  const t = useTranslations('suppliers');
  const canManage = usePermission('SUPPLIER_MANAGE').allowed;
  const timeZone = useShellSession().activeTenant.timezone;
  return (
    <Table>
      <caption className="sr-only">{t('table.caption')}</caption>
      <TableHead>
        <Tr>
          <Th>{t('table.legalName')}</Th>
          <Th className="hidden md:table-cell">{t('table.contact')}</Th>
          <Th>{t('table.status')}</Th>
          <Th className="hidden lg:table-cell">{t('table.updated')}</Th>
          {canManage ? (
            <Th className="w-12">
              <span className="sr-only">{t('table.actions')}</span>
            </Th>
          ) : null}
        </Tr>
      </TableHead>
      <TableBody>
        {suppliers.map((supplier) => (
          <Tr key={supplier.id}>
            <th scope="row" className="px-3.5 py-3 text-left font-normal">
              <span className="block font-bold text-foreground">{supplier.legalName}</span>
              <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                {supplier.tradeName ? <span>{supplier.tradeName}</span> : null}
                <span>{t(`documentTypes.${supplier.documentType}`)}</span>
                <span className="font-mono">{displayDocument(supplier)}</span>
              </span>
            </th>
            <Td className="hidden break-all md:table-cell">
              {supplier.email ?? supplier.phone ?? '—'}
            </Td>
            <Td>
              <StatusChip tone={supplier.isActive ? 'success' : 'neutral'}>
                {supplier.isActive ? t('badges.active') : t('badges.inactive')}
              </StatusChip>
            </Td>
            <Td className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">
              {formatDate(supplier.updatedAt, timeZone)}
            </Td>
            {canManage ? (
              <Td className="w-12 py-1.5 text-right">
                <RowMenu
                  supplier={supplier}
                  onEdit={onEdit}
                  onDeactivate={onDeactivate}
                  onReactivate={onReactivate}
                  onDelete={onDelete}
                />
              </Td>
            ) : null}
          </Tr>
        ))}
      </TableBody>
    </Table>
  );
}

function RowMenu({
  supplier,
  onEdit,
  onDeactivate,
  onReactivate,
  onDelete,
}: Omit<SupplierListProps, 'suppliers'> & { readonly supplier: SupplierDto }) {
  const t = useTranslations('suppliers');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('actions.menu', { name: supplier.legalName })}
          className="inline-grid size-11 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground md:size-9"
        >
          <Ellipsis aria-hidden="true" className="size-[1.125rem]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() => {
            onEdit(supplier);
          }}
        >
          {t('actions.editLabel')}
        </DropdownMenuItem>
        {supplier.isActive ? (
          <DropdownMenuItem
            onSelect={() => {
              onDeactivate(supplier);
            }}
          >
            {t('actions.deactivateLabel')}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onSelect={() => {
              onReactivate(supplier);
            }}
          >
            {t('actions.reactivateLabel')}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            onDelete(supplier);
          }}
        >
          {t('actions.deleteLabel')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
