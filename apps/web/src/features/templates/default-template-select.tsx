'use client';

import { toast } from '@contrataflow/ui';
import type { DocumentTypeDto, TemplateDto } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

import { setDefaultTemplate, templateKeys } from './templates.api';

const SELECT = 'h-9 max-w-64 rounded-control border border-border bg-surface px-2 text-sm';

/** Pode ser o padrão do tipo (RN-TPL-19): ativo e com versão publicada. */
export function isSelectableDefault(template: TemplateDto): boolean {
  return template.isActive && template.currentPublishedVersion !== null;
}

/**
 * `DefaultTemplateSelect` (SCR-108 · US-108 · passo 7 e FA-04): templates do tipo; os ativos com
 * versão publicada podem ser escolhidos como padrão (DTY-04 com a versão do tipo em `If-Match`) e
 * os demais aparecem desabilitados. Trocar o padrão não desativa o anterior (RN-TPL-20).
 */
export function DefaultTemplateSelect({
  type,
  templates,
}: {
  readonly type: DocumentTypeDto;
  readonly templates: readonly TemplateDto[];
}) {
  const t = useTranslations('documentTypes');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const ids = useId();
  const [error, setError] = useState<string | null>(null);
  const own = templates.filter((template) => template.documentTypeId === type.id);

  const save = useMutation({
    mutationFn: (templateId: string) => setDefaultTemplate(type.id, templateId, type.version),
    onSuccess: (result) => {
      setError(null);
      toast({
        title: t('defaultTemplate.saved', {
          type: result.data.name,
          template: result.data.defaultTemplate?.name ?? '',
        }),
        tone: 'success',
      });
    },
    onError: (failure) => {
      setError(
        isApiError(failure) && failure.code === 'VERSION_CONFLICT'
          ? t('defaultTemplate.conflict')
          : isApiError(failure)
            ? failure.message
            : t('defaultTemplate.generic'),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: tenantKey(tenantId, 'document-types') });
      void queryClient.invalidateQueries({ queryKey: templateKeys.all(tenantId) });
    },
  });

  const optionLabel = (template: TemplateDto) => {
    if (!template.isActive) return t('defaultTemplate.inactive', { name: template.name });
    if (!template.currentPublishedVersion) {
      return t('defaultTemplate.notPublished', { name: template.name });
    }
    return t('defaultTemplate.version', {
      name: template.name,
      number: template.currentPublishedVersion.versionNumber,
    });
  };

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${ids}-select`} className="sr-only">
        {t('defaultTemplate.label', { name: type.name })}
      </label>
      <select
        id={`${ids}-select`}
        className={SELECT}
        value={type.defaultTemplate?.id ?? ''}
        disabled={save.isPending}
        aria-busy={save.isPending}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${ids}-error` : undefined}
        onChange={(event) => {
          if (event.target.value !== '') save.mutate(event.target.value);
        }}
      >
        {type.defaultTemplate ? null : (
          <option value="" disabled>
            {t('defaultTemplate.placeholder')}
          </option>
        )}
        {own.map((template) => (
          <option key={template.id} value={template.id} disabled={!isSelectableDefault(template)}>
            {optionLabel(template)}
          </option>
        ))}
      </select>
      {error ? (
        <p id={`${ids}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
