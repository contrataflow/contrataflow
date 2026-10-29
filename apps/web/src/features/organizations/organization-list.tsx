'use client';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import type { OrganizationDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

import { usePermission } from '@/lib/permissions/use-permission';

import { formatCnpj } from './organization-form-model';

export interface OrganizationListProps {
  readonly organizations: readonly OrganizationDto[];
  readonly onEdit: (organization: OrganizationDto) => void;
  readonly onDeactivate: (organization: OrganizationDto) => void;
  readonly onReactivate: (organization: OrganizationDto) => void;
}

/**
 * `OrganizationList` (SCR-032 · US-101 · prd-5): nome em negrito com sigla e CNPJ na linha
 * secundária, tipo e situação (com o selo "Principal"); "Editar" e "Inativar"/"Reativar" no menu
 * ⋯ da linha, só com `ORGANIZATION_MANAGE` (a API decide cada requisição). A caixa da tabela
 * (`TableContainer`) rola na horizontal só se faltar espaço.
 */
export function OrganizationList({
  organizations,
  onEdit,
  onDeactivate,
  onReactivate,
}: OrganizationListProps) {
  const t = useTranslations('organizations');
  const canManage = usePermission('ORGANIZATION_MANAGE').allowed;
  return (
    <Table>
      <caption className="sr-only">{t('table.caption')}</caption>
      <TableHead>
        <Tr>
          <Th>{t('table.name')}</Th>
          <Th className="hidden md:table-cell">{t('table.type')}</Th>
          <Th>{t('table.status')}</Th>
          {canManage ? (
            <Th className="w-12">
              <span className="sr-only">{t('table.actions')}</span>
            </Th>
          ) : null}
        </Tr>
      </TableHead>
      <TableBody>
        {organizations.map((organization) => (
          <Tr key={organization.id}>
            <th scope="row" className="px-3.5 py-3 text-left font-normal">
              <span className="block font-bold text-foreground">{organization.name}</span>
              <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                <span className="font-mono">{organization.shortName}</span>
                <span className="font-mono">{formatCnpj(organization.cnpj)}</span>
              </span>
            </th>
            <Td className="hidden md:table-cell">{t(`types.${organization.type}`)}</Td>
            <Td>
              <span className="flex flex-wrap gap-1">
                <StatusChip tone={organization.isActive ? 'success' : 'neutral'}>
                  {organization.isActive ? t('badges.active') : t('badges.inactive')}
                </StatusChip>
                {organization.isPrimary ? (
                  <StatusChip tone="info">{t('badges.primary')}</StatusChip>
                ) : null}
              </span>
            </Td>
            {canManage ? (
              <Td className="w-12 py-1.5 text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t('actions.menu', { name: organization.name })}
                      className="inline-grid size-11 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground md:size-9"
                    >
                      <Ellipsis aria-hidden="true" className="size-[1.125rem]" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => {
                        onEdit(organization);
                      }}
                    >
                      {t('actions.editLabel')}
                    </DropdownMenuItem>
                    {organization.isActive ? (
                      <DropdownMenuItem
                        onSelect={() => {
                          onDeactivate(organization);
                        }}
                      >
                        {t('actions.deactivateLabel')}
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        onSelect={() => {
                          onReactivate(organization);
                        }}
                      >
                        {t('actions.reactivateLabel')}
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
