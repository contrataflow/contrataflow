import { Skeleton } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

/** Estado de carregamento do conteúdo do shell (skeleton decorativo + anúncio acessível). */
export default function AppLoading() {
  const t = useTranslations('shell');
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-4">
      <span className="sr-only">{t('loading')}</span>
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-full max-w-2xl" />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    </div>
  );
}
