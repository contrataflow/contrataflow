'use client';

import {
  Alert,
  Button,
  Checkbox,
  Field,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Textarea,
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
  const t = useTranslations('templates');
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent closeLabel={t('form.close')}>
        {props.open ? <TemplateFormBody key={props.template?.id ?? 'novo'} {...props} /> : null}
      </SheetContent>
    </Sheet>
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
  const activeId = `${ids}-active`;

  return (
    <form
      noValidate
      onSubmit={(event) => void onSubmit(event)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <SheetHeader>
        <SheetTitle>{isEdit ? t('form.editTitle') : t('form.createTitle')}</SheetTitle>
        <SheetDescription>
          {isEdit ? t('form.editDescription') : t('form.createDescription')}
        </SheetDescription>
      </SheetHeader>

      <SheetBody>
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

        <Field label={t('form.name')} error={errors.name}>
          <Input
            // eslint-disable-next-line jsx-a11y/no-autofocus -- foco no primeiro campo ao abrir o painel
            autoFocus
            value={name}
            maxLength={150}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>

        {isEdit ? (
          <div className="flex flex-col gap-1">
            <span className="text-sm font-semibold">{t('form.type')}</span>
            <p className="text-sm">
              {template.documentType.name}{' '}
              <span className="text-muted-foreground">— {t('form.typeLocked')}</span>
            </p>
          </div>
        ) : (
          <Field label={t('form.type')} error={errors.documentTypeId}>
            <Select value={documentTypeId} onValueChange={setDocumentTypeId}>
              <SelectTrigger>
                <SelectValue placeholder={t('form.typePlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {selectableTypes.map((type) => (
                  <SelectItem key={type.id} value={type.id}>
                    {type.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}

        <Field label={t('form.description')} error={errors.description}>
          <Textarea
            rows={3}
            value={description}
            maxLength={2000}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </Field>

        {isEdit ? (
          <div className="flex items-center gap-3">
            <Checkbox
              id={activeId}
              checked={isActive}
              onCheckedChange={(checked) => {
                setIsActive(checked === true);
              }}
            />
            <Label htmlFor={activeId}>{t('form.isActive')}</Label>
          </div>
        ) : null}
      </SheetBody>

      <SheetFooter>
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
      </SheetFooter>
    </form>
  );
}
