'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  toast,
} from '@contrataflow/ui';
import { templateCreateSchema } from '@contrataflow/validation';
import type { DocumentTypeDto, TemplateDto, TemplateUpdate } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { SyntheticEvent } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';
import { useTenantId } from '@/lib/session/session-context';

import {
  activeDocumentTypesKey,
  createTemplate,
  fetchActiveDocumentTypes,
  templateEditorHref,
  templateKeys,
  TEMPLATES_STALE_TIME_MS,
  updateTemplate,
} from './templates.api';

const INPUT = 'h-10 rounded-control border border-border bg-surface px-3 text-sm';

export interface TemplateFormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Template em edição (TPL-04); ausente = criação (TPL-02). */
  readonly template?: TemplateDto | undefined;
  /** Templates já carregados: o front antecipa o nome repetido no tipo (passo 2). */
  readonly existing: readonly TemplateDto[];
}

/** Nome comparável (RN-TPL-01): sem maiúsculas nem espaços nas pontas. */
function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase('pt-BR');
}

/**
 * `TemplateFormDialog` (SCR-033 · US-107 · passos 1–4 e FA-03): cria o template (nome, tipo e
 * descrição, com `Idempotency-Key`) e leva ao editor da versão 1; na edição, só nome, descrição e
 * situação — o tipo é imutável. Valida com o schema da API e antecipa o nome repetido no tipo.
 */
export function TemplateFormDialog(props: TemplateFormDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent style={{ maxWidth: '36rem' }}>
        {props.open ? <TemplateFormBody key={props.template?.id ?? 'novo'} {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}

type FieldErrors = Partial<Record<'name' | 'documentTypeId' | 'description', string>>;

function TemplateFormBody({ template, onOpenChange, existing }: TemplateFormDialogProps) {
  const t = useTranslations('templates');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const router = useRouter();
  const ids = useId();
  const isEdit = template !== undefined;
  const [name, setName] = useState(template?.name ?? '');
  const [documentTypeId, setDocumentTypeId] = useState(template?.documentTypeId ?? '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [isActive, setIsActive] = useState(template?.isActive ?? true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const types = useQuery({
    queryKey: activeDocumentTypesKey(tenantId),
    queryFn: async ({ signal }) => (await fetchActiveDocumentTypes(signal)).data,
    staleTime: TEMPLATES_STALE_TIME_MS,
    enabled: !isEdit,
    throwOnError: false,
  });
  const selectableTypes: readonly DocumentTypeDto[] = (types.data ?? []).filter(
    (type) => type.kind !== 'UPLOADED',
  );

  const create = useIdempotentMutation({
    mutationFn: (body: { name: string; documentTypeId: string; description?: string }, context) =>
      createTemplate(body, context),
  });
  const update = useMutation({
    mutationFn: ({ id, patch, version }: { id: string; patch: TemplateUpdate; version: number }) =>
      updateTemplate(id, patch, version),
  });

  const fieldLabel = (field: 'name' | 'documentTypeId') =>
    field === 'name' ? t('form.fieldName') : t('form.fieldType');

  const validate = (): FieldErrors => {
    const found: FieldErrors = {};
    if (name.trim() === '') found.name = t('form.required', { field: fieldLabel('name') });
    else if (name.trim().length < 3 || name.trim().length > 150) found.name = t('form.nameLength');
    if (!isEdit && documentTypeId === '') {
      found.documentTypeId = t('form.required', { field: fieldLabel('documentTypeId') });
    }
    if (description.trim().length > 2000) found.description = t('form.descriptionLength');
    if (Object.keys(found).length > 0) return found;
    if (!isEdit) {
      const parsed = templateCreateSchema.safeParse({ name, documentTypeId });
      if (!parsed.success) found.documentTypeId = t('form.invalidType');
    }
    const typeId = template?.documentTypeId ?? documentTypeId;
    const homonym = existing.find(
      (other) =>
        other.id !== template?.id &&
        other.documentTypeId === typeId &&
        nameKey(other.name) === nameKey(name),
    );
    if (homonym) found.name = t('form.duplicate', { name: name.trim() });
    return found;
  };

  const handleError = (error: unknown) => {
    if (!isApiError(error)) {
      setFormError(t('form.generic'));
      return;
    }
    if (error.code === 'TEMPLATE_NAME_TAKEN') {
      setErrors({ name: error.message });
      return;
    }
    if (error.code === 'VERSION_CONFLICT') {
      setConflict(true);
      return;
    }
    if (error.code === 'VALIDATION_ERROR' && error.errors.length > 0) {
      const next: FieldErrors = {};
      for (const fieldError of error.errors) {
        if (fieldError.field === 'documentTypeId') next.documentTypeId = t('form.invalidType');
        else if (fieldError.field === 'name' || fieldError.field === 'description') {
          next[fieldError.field] = fieldError.message;
        }
      }
      setErrors(next);
      // Tipo inexistente/inativo: as opções são recarregadas (Casos de erro).
      if (next.documentTypeId) void types.refetch();
      return;
    }
    setFormError(error.message);
  };

  const onSubmit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setFormError(null);
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    try {
      if (!template) {
        const result = await create.submit({
          name: name.trim(),
          documentTypeId,
          ...(description.trim() === '' ? {} : { description: description.trim() }),
        });
        toast({ title: t('toast.created', { name: result.data.name }), tone: 'success' });
        void queryClient.invalidateQueries({ queryKey: templateKeys.all(tenantId) });
        onOpenChange(false);
        const draftId = result.data.draftVersion?.id;
        if (draftId) router.push(templateEditorHref(result.data.id, draftId));
        return;
      }
      const patch: TemplateUpdate = {
        ...(name.trim() !== template.name ? { name: name.trim() } : {}),
        ...(description.trim() !== (template.description ?? '')
          ? { description: description.trim() === '' ? null : description.trim() }
          : {}),
        ...(isActive !== template.isActive ? { isActive } : {}),
      };
      if (Object.keys(patch).length > 0) {
        await update.mutateAsync({ id: template.id, patch, version: template.version });
        toast({ title: t('toast.updated'), tone: 'success' });
        void queryClient.invalidateQueries({ queryKey: templateKeys.all(tenantId) });
      }
      onOpenChange(false);
    } catch (error) {
      handleError(error);
    }
  };

  const pending = create.isPending || update.isPending;
  const errorId = (field: keyof FieldErrors) => `${ids}-${field}-error`;

  return (
    <form noValidate onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      <DialogTitle>{isEdit ? t('form.editTitle') : t('form.createTitle')}</DialogTitle>
      <DialogDescription>
        {isEdit ? t('form.editDescription') : t('form.createDescription')}
      </DialogDescription>
      {conflict ? (
        <Alert tone="error" title={t('form.conflict')}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: templateKeys.all(tenantId) });
              onOpenChange(false);
            }}
          >
            {t('form.reload')}
          </Button>
        </Alert>
      ) : null}
      {formError ? <Alert tone="error" title={formError} /> : null}

      <div className="flex flex-col gap-1">
        <label htmlFor={`${ids}-name`} className="text-sm font-medium">
          {t('form.name')}
        </label>
        <input
          id={`${ids}-name`}
          className={INPUT}
          value={name}
          maxLength={150}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? errorId('name') : undefined}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        {errors.name ? (
          <p id={errorId('name')} className="text-sm text-destructive">
            {errors.name}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${ids}-type`} className="text-sm font-medium">
          {t('form.type')}
        </label>
        {isEdit ? (
          <p id={`${ids}-type`} className="text-sm">
            {template.documentType.name}{' '}
            <span className="text-muted-foreground">— {t('form.typeLocked')}</span>
          </p>
        ) : (
          <select
            id={`${ids}-type`}
            className={INPUT}
            value={documentTypeId}
            aria-invalid={errors.documentTypeId ? true : undefined}
            aria-describedby={errors.documentTypeId ? errorId('documentTypeId') : undefined}
            onChange={(event) => {
              setDocumentTypeId(event.target.value);
            }}
          >
            <option value="">{t('form.typePlaceholder')}</option>
            {selectableTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        )}
        {errors.documentTypeId ? (
          <p id={errorId('documentTypeId')} className="text-sm text-destructive">
            {errors.documentTypeId}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${ids}-description`} className="text-sm font-medium">
          {t('form.description')}
        </label>
        <textarea
          id={`${ids}-description`}
          className="min-h-20 rounded-control border border-border bg-surface px-3 py-2 text-sm"
          value={description}
          maxLength={2000}
          aria-invalid={errors.description ? true : undefined}
          aria-describedby={errors.description ? errorId('description') : undefined}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
        {errors.description ? (
          <p id={errorId('description')} className="text-sm text-destructive">
            {errors.description}
          </p>
        ) : null}
      </div>

      {isEdit ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(event) => {
              setIsActive(event.target.checked);
            }}
          />
          {t('form.isActive')}
        </label>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            onOpenChange(false);
          }}
        >
          {t('form.cancel')}
        </Button>
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? t('form.saving') : isEdit ? t('form.save') : t('form.create')}
        </Button>
      </div>
    </form>
  );
}
