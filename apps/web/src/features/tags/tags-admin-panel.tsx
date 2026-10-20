'use client';

import { Alert, Button, Skeleton, toast } from '@contrataflow/ui';
import type { TagDto } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

import { TagChip } from './tag-chip';
import { TagFormDialog } from './tag-form-dialog';
import { tagKeys, updateTag, useTags } from './tags.api';

/**
 * `TagAdminTable` + `TagForm` (US-007 · SCR-109 aba "Etiquetas", exige `TAG_MANAGE`): cadastro,
 * edição (nome e cor) e ativação/desativação das etiquetas do órgão — nunca exclusão (RN-PROC-86).
 * A mudança reflete em todos os processos (associação por id): a lista do cadastro e as consultas de
 * processos são invalidadas. 412/404 recarregam a lista com aviso; banco fora oferece "Tentar de novo".
 */
export function TagsAdminPanel() {
  const t = useTranslations('tags.admin');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const tags = useTags(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<TagDto | null>(null);
  const [banner, setBanner] = useState<'conflict' | 'unavailable' | 'generic' | null>(null);

  /** RN-PROC-90: renomear, recolorir ou desativar aparece em todos os processos. */
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: tagKeys.all(tenantId) });
    void queryClient.invalidateQueries({ queryKey: tenantKey(tenantId, 'processes') });
  };

  const setActive = useMutation({
    mutationFn: ({ tag, isActive }: { tag: TagDto; isActive: boolean }) =>
      updateTag(tag.id, { isActive }, tag.version),
    onSuccess: (saved, { isActive }) => {
      setBanner(null);
      toast({
        title: t(isActive ? 'toast.activated' : 'toast.deactivated', { name: saved.name }),
        tone: 'success',
      });
      refresh();
    },
    onError: (error) => {
      if (isApiError(error) && (error.status === 412 || error.status === 404)) {
        setBanner('conflict');
      } else {
        setBanner(isApiError(error) && error.status === 503 ? 'unavailable' : 'generic');
      }
      refresh();
    },
  });

  const forbidden = tags.error && isApiError(tags.error) && tags.error.status === 403;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex max-w-3xl flex-col gap-1">
          <h2 className="text-lg font-semibold">{t('title')}</h2>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex items-center gap-3">
          <p role="status" className="text-sm text-muted-foreground">
            {setActive.isPending ? t('saving') : ''}
          </p>
          {tags.data ? (
            <Button
              onClick={() => {
                setCreating(true);
              }}
            >
              {t('new')}
            </Button>
          ) : null}
        </div>
      </div>

      {forbidden ? <Alert tone="error" title={t('permission')} /> : null}

      {banner ? (
        <Alert
          tone={banner === 'conflict' ? 'warning' : 'error'}
          title={
            banner === 'conflict'
              ? t('conflict.title')
              : banner === 'unavailable'
                ? t('errors.unavailable')
                : t('errors.generic')
          }
        >
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setBanner(null);
              refresh();
            }}
          >
            {banner === 'conflict' ? t('conflict.reload') : t('retry')}
          </Button>
        </Alert>
      ) : null}

      {tags.isPending ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : null}

      {tags.isError && !forbidden ? (
        <Alert tone="error" title={t('loadFailed')}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void tags.refetch();
            }}
          >
            {t('retry')}
          </Button>
        </Alert>
      ) : null}

      {tags.data?.length === 0 ? (
        <div className="rounded-card border border-dashed border-border p-6 text-center">
          <p className="font-medium">{t('empty')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('emptyHint')}</p>
        </div>
      ) : null}

      {tags.data && tags.data.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">{t('table.caption')}</caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('table.name')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('table.color')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('table.status')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('table.actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {tags.data.map((tag) => (
                <tr key={tag.id} className="border-b border-border">
                  <th scope="row" className="px-3 py-2 font-normal">
                    <TagChip name={tag.name} color={tag.color} isActive={tag.isActive} />
                  </th>
                  <td className="px-3 py-2 text-muted-foreground">{tag.color}</td>
                  <td className="px-3 py-2">
                    {tag.isActive ? t('status.active') : t('status.inactive')}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={t('editLabel', { name: tag.name })}
                        disabled={setActive.isPending}
                        onClick={() => {
                          setEditing(tag);
                        }}
                      >
                        {t('edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={t(tag.isActive ? 'deactivateLabel' : 'activateLabel', {
                          name: tag.name,
                        })}
                        disabled={setActive.isPending}
                        onClick={() => {
                          setActive.mutate({ tag, isActive: !tag.isActive });
                        }}
                      >
                        {tag.isActive ? t('deactivate') : t('activate')}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <TagFormDialog
        open={creating}
        onOpenChange={setCreating}
        onConflict={() => {
          setBanner('conflict');
          refresh();
        }}
        onSaved={refresh}
      />
      <TagFormDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        tag={editing ?? undefined}
        onConflict={() => {
          setBanner('conflict');
          refresh();
        }}
        onSaved={refresh}
      />
    </div>
  );
}
