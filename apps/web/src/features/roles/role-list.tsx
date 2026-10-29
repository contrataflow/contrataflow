'use client';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Ellipsis,
  Table,
  TableBody,
  TableHead,
  Td,
  Th,
  Tr,
} from '@contrataflow/ui';
import type { RoleDto } from '@contrataflow/validation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { usePermission } from '@/lib/permissions/use-permission';

import { ROLES_PATH, RoleKindChips, RoleStatusChip, canDeactivate } from './role-chips';

export interface RoleListProps {
  readonly roles: readonly RoleDto[];
  readonly onDuplicate: (role: RoleDto) => void;
  readonly onDeactivate: (role: RoleDto) => void;
}

/**
 * `RoleList` (SCR-030 · US-095 · prd-5): nome em negrito (link para o detalhe) com a chave e o
 * aviso de vínculo externo na linha secundária, tipo, situação e vínculos ativos; "Duplicar" e
 * "Desativar" no menu ⋯ da linha, só com `ROLE_MANAGE` (a API decide cada requisição).
 */
export function RoleList({ roles, onDuplicate, onDeactivate }: RoleListProps) {
  const t = useTranslations('roles');
  const canManage = usePermission('ROLE_MANAGE').allowed;
  return (
    <Table>
      <caption className="sr-only">{t('list.caption')}</caption>
      <TableHead>
        <Tr>
          <Th>{t('list.name')}</Th>
          <Th>{t('list.kind')}</Th>
          <Th>{t('list.status')}</Th>
          <Th className="hidden md:table-cell">{t('list.assignments')}</Th>
          {canManage ? (
            <Th className="w-12">
              <span className="sr-only">{t('list.actions')}</span>
            </Th>
          ) : null}
        </Tr>
      </TableHead>
      <TableBody>
        {roles.map((role) => (
          <Tr key={role.id}>
            <th scope="row" className="px-3.5 py-3 text-left font-normal">
              <Link
                href={`${ROLES_PATH}/${role.id}`}
                aria-label={t('actions.open', { name: role.name })}
                className="block font-bold text-foreground underline-offset-2 hover:underline"
              >
                {role.name}
              </Link>
              <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                <span className="font-mono">{role.key}</span>
                {role.allowExternalAssignment ? <span>{t('badges.external')}</span> : null}
              </span>
            </th>
            <Td>
              <RoleKindChips role={role} />
            </Td>
            <Td>
              <RoleStatusChip role={role} />
            </Td>
            <Td className="hidden whitespace-nowrap md:table-cell">
              {t('list.assignmentsCount', { count: role.activeAssignmentsCount })}
            </Td>
            {canManage ? (
              <Td className="w-12 py-1.5 text-right">
                <RowMenu role={role} onDuplicate={onDuplicate} onDeactivate={onDeactivate} />
              </Td>
            ) : null}
          </Tr>
        ))}
      </TableBody>
    </Table>
  );
}

function RowMenu({
  role,
  onDuplicate,
  onDeactivate,
}: Omit<RoleListProps, 'roles'> & { readonly role: RoleDto }) {
  const t = useTranslations('roles');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('actions.menu', { name: role.name })}
          className="inline-grid size-11 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground md:size-9"
        >
          <Ellipsis aria-hidden="true" className="size-[1.125rem]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() => {
            onDuplicate(role);
          }}
        >
          {t('actions.duplicateLabel')}
        </DropdownMenuItem>
        {canDeactivate(role) ? (
          <DropdownMenuItem
            onSelect={() => {
              onDeactivate(role);
            }}
          >
            {t('actions.deactivateLabel')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
