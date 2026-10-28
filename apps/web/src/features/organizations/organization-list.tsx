'use client';

import { Button } from '@contrataflow/ui';
import type { OrganizationDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

import { Can } from '@/lib/permissions/can';

import { formatCnpj } from './organization-form-model';

function Badge({ children, tone }: { readonly children: string; readonly tone: 'muted' | 'ok' }) {
  return (
    <span
      className={`inline-flex rounded-control px-2 py-0.5 text-xs font-medium ${
        tone === 'ok' ? 'bg-success-soft text-foreground' : 'bg-muted text-muted-foreground'
      }`}
    >
      {children}
    </span>
  );
}

export interface OrganizationListProps {
  readonly organizations: readonly OrganizationDto[];
  readonly onEdit: (organization: OrganizationDto) => void;
  readonly onDeactivate: (organization: OrganizationDto) => void;
  readonly onReactivate: (organization: OrganizationDto) => void;
}

/**
 * `OrganizationList` (SCR-032 · US-101 · passo 2): nome, sigla, CNPJ, tipo e situação; "Editar",
 * "Inativar" e "Reativar" só aparecem com `ORGANIZATION_MANAGE` (a API decide cada requisição).
 */
export function OrganizationList({
  organizations,
  onEdit,
  onDeactivate,
  onReactivate,
}: OrganizationListProps) {
  const t = useTranslations('organizations');
  return (
    <div className="relative overflow-x-auto rounded-card border border-border bg-surface shadow-card">
      <table className="w-full min-w-[48rem] text-left text-sm">
        <caption className="sr-only">{t('table.caption')}</caption>
        <thead className="bg-muted text-xs text-muted-foreground uppercase">
          <tr>
            <th scope="col" className="px-3 py-2">
              {t('table.name')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.shortName')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.cnpj')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.type')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.status')}
            </th>
            <Can permission="ORGANIZATION_MANAGE">
              <th scope="col" className="px-3 py-2">
                {t('table.actions')}
              </th>
            </Can>
          </tr>
        </thead>
        <tbody>
          {organizations.map((organization) => (
            <tr key={organization.id} className="border-t border-border align-top">
              <th scope="row" className="px-3 py-2 font-medium">
                {organization.name}
              </th>
              <td className="px-3 py-2 font-mono text-xs">{organization.shortName}</td>
              <td className="px-3 py-2 font-mono text-xs">{formatCnpj(organization.cnpj)}</td>
              <td className="px-3 py-2">{t(`types.${organization.type}`)}</td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  <Badge tone={organization.isActive ? 'ok' : 'muted'}>
                    {organization.isActive ? t('badges.active') : t('badges.inactive')}
                  </Badge>
                  {organization.isPrimary ? (
                    <Badge tone="muted">{t('badges.primary')}</Badge>
                  ) : null}
                </div>
              </td>
              <Can permission="ORGANIZATION_MANAGE">
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={t('actions.edit', { name: organization.name })}
                      onClick={() => {
                        onEdit(organization);
                      }}
                    >
                      {t('actions.editLabel')}
                    </Button>
                    {organization.isActive ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t('actions.deactivate', { name: organization.name })}
                        onClick={() => {
                          onDeactivate(organization);
                        }}
                      >
                        {t('actions.deactivateLabel')}
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t('actions.reactivate', { name: organization.name })}
                        onClick={() => {
                          onReactivate(organization);
                        }}
                      >
                        {t('actions.reactivateLabel')}
                      </Button>
                    )}
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
