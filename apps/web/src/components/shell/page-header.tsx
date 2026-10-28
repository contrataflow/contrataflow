import { PageHeader } from '@contrataflow/ui';
import type { BreadcrumbItem, PageHeaderProps } from '@contrataflow/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

export type AppPageHeaderProps = Omit<PageHeaderProps, 'linkComponent' | 'breadcrumbLabel'> & {
  /** Área do menu: `admin` monta a trilha "Administração / <título>". */
  readonly section?: 'admin' | undefined;
};

/**
 * Cabeçalho padrão das páginas do app (prd-4 · padrão 3): o `PageHeader` do design system com o
 * `Link` do Next e a trilha rotulada. Serve a Server e Client Components.
 */
export function AppPageHeader({ section, breadcrumbs, title, ...props }: AppPageHeaderProps) {
  const t = useTranslations('shell');
  const trail: readonly BreadcrumbItem[] | undefined =
    breadcrumbs ??
    (section === 'admin'
      ? [{ label: t('admin.title'), href: '/admin' }, { label: title }]
      : undefined);
  return (
    <PageHeader
      linkComponent={Link}
      breadcrumbLabel={t('pageHeader.breadcrumb')}
      breadcrumbs={trail}
      title={title}
      {...props}
    />
  );
}
