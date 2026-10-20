'use client';

import { Button } from '@contrataflow/ui';
import type { SupplierDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

import { Can } from '@/lib/permissions/can';

import { displayDocument } from './supplier-form-model';

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

export interface SupplierListProps {
  readonly suppliers: readonly SupplierDto[];
  readonly onEdit: (supplier: SupplierDto) => void;
  readonly onDeactivate: (supplier: SupplierDto) => void;
  readonly onReactivate: (supplier: SupplierDto) => void;
  readonly onDelete: (supplier: SupplierDto) => void;
}

/**
 * `SupplierList` (SCR-107 · US-025): razão social (e nome fantasia), tipo e número do documento
 * (CPF mascarado), contato e situação; "Editar", "Inativar"/"Reativar" e "Excluir" só aparecem com
 * `SUPPLIER_MANAGE` (a API decide cada requisição). Abaixo de 768 px cada linha vira um cartão
 * (mesma tabela, cabeçalho só para leitores de tela).
 */
export function SupplierList({
  suppliers,
  onEdit,
  onDeactivate,
  onReactivate,
  onDelete,
}: SupplierListProps) {
  const t = useTranslations('suppliers');
  return (
    <div className="rounded-card border border-border bg-surface shadow-card md:overflow-x-auto">
      <table className="w-full text-left text-sm md:min-w-[52rem]">
        <caption className="sr-only">{t('table.caption')}</caption>
        <thead className="bg-muted text-xs text-muted-foreground uppercase max-md:sr-only">
          <tr>
            <th scope="col" className="px-3 py-2">
              {t('table.legalName')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.document')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.contact')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.status')}
            </th>
            <Can permission="SUPPLIER_MANAGE">
              <th scope="col" className="px-3 py-2">
                {t('table.actions')}
              </th>
            </Can>
          </tr>
        </thead>
        <tbody>
          {suppliers.map((supplier) => (
            <tr
              key={supplier.id}
              className="border-t border-border align-top max-md:block max-md:py-2"
            >
              <th scope="row" className="px-3 py-2 font-medium max-md:block">
                {supplier.legalName}
                {supplier.tradeName ? (
                  <span className="block text-xs font-normal text-muted-foreground">
                    {supplier.tradeName}
                  </span>
                ) : null}
              </th>
              <td className="px-3 py-2 max-md:block max-md:py-1">
                <span className="text-xs text-muted-foreground">
                  {t(`documentTypes.${supplier.documentType}`)}
                </span>
                <span className="block font-mono text-xs">{displayDocument(supplier)}</span>
              </td>
              <td className="px-3 py-2 break-all max-md:block max-md:py-1">
                {supplier.email ?? supplier.phone ?? '—'}
              </td>
              <td className="px-3 py-2 max-md:block max-md:py-1">
                <Badge tone={supplier.isActive ? 'ok' : 'muted'}>
                  {supplier.isActive ? t('badges.active') : t('badges.inactive')}
                </Badge>
              </td>
              <Can permission="SUPPLIER_MANAGE">
                <td className="px-3 py-2 max-md:block">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={t('actions.edit', { name: supplier.legalName })}
                      onClick={() => {
                        onEdit(supplier);
                      }}
                    >
                      {t('actions.editLabel')}
                    </Button>
                    {supplier.isActive ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t('actions.deactivate', { name: supplier.legalName })}
                        onClick={() => {
                          onDeactivate(supplier);
                        }}
                      >
                        {t('actions.deactivateLabel')}
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t('actions.reactivate', { name: supplier.legalName })}
                        onClick={() => {
                          onReactivate(supplier);
                        }}
                      >
                        {t('actions.reactivateLabel')}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('actions.delete', { name: supplier.legalName })}
                      onClick={() => {
                        onDelete(supplier);
                      }}
                    >
                      {t('actions.deleteLabel')}
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
