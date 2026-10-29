'use client';

import {
  Alert,
  Button,
  Field,
  InfoTooltip,
  Input,
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
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SyntheticEvent } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';
import { useTenantId } from '@/lib/session/session-context';

import { keyFromName, workflowKeyProblems, workflowNameProblems } from './workflow-editor-model';
import type { FieldProblem } from './workflow-editor-model';
import { createWorkflow, workflowEditorHref, workflowKeys } from './workflows.api';
import type { WorkflowCreateInput } from './workflows.api';

type FieldName = 'name' | 'key' | 'description';

/**
 * "Novo workflow" (SCR-034 · US-043 passo 2) no painel lateral do kit (`Sheet`): nome, chave técnica
 * (sugerida pelo nome e editável até salvar — imutável depois, RN-WF-45) e descrição; WF-02 cria o
 * workflow com a v1 em rascunho e a tela segue para o editor.
 */
export function WorkflowFormDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('workflows');
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent closeLabel={t('form.close')}>
        {open ? (
          <WorkflowForm
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function WorkflowForm({ onClose }: { readonly onClose: () => void }) {
  const t = useTranslations('workflows');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const create = useIdempotentMutation({
    mutationFn: (body: WorkflowCreateInput, context) => createWorkflow(body, context),
  });

  const label = (field: FieldName) => t(`form.fields.${field}`);
  const messageOf = (problem: FieldProblem) => {
    if (problem.code === 'REQUIRED')
      return t('form.required', { field: label(problem.field as FieldName) });
    if (problem.code === 'KEY_PATTERN') return t('form.keyPattern');
    return t('form.nameLength');
  };

  const validate = () => {
    const found: Partial<Record<FieldName, string>> = {};
    for (const problem of [...workflowNameProblems(name), ...workflowKeyProblems(key)]) {
      found[problem.field as FieldName] = messageOf(problem);
    }
    if (description.trim().length > 2000) found.description = t('form.descriptionLength');
    return found;
  };

  const onSubmit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setFormError(null);
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    try {
      const result = await create.submit({
        key: key.trim(),
        name: name.trim(),
        ...(description.trim() === '' ? {} : { description: description.trim() }),
      });
      toast({ title: t('form.created', { name: result.data.name }), tone: 'success' });
      void queryClient.invalidateQueries({ queryKey: workflowKeys.all(tenantId) });
      onClose();
      router.push(workflowEditorHref(result.data.id));
    } catch (error) {
      if (!isApiError(error)) setFormError(t('errors.generic'));
      else if (error.code === 'CONFLICT') setErrors({ key: t('form.keyTaken') });
      else if (error.code === 'VALIDATION_ERROR' && error.errors.length > 0) {
        const next: Partial<Record<FieldName, string>> = {};
        for (const fieldError of error.errors) {
          if (
            fieldError.field === 'name' ||
            fieldError.field === 'key' ||
            fieldError.field === 'description'
          ) {
            next[fieldError.field] = fieldError.message;
          }
        }
        setErrors(next);
      } else if (error.code === 'MFA_REQUIRED') setFormError(t('errors.mfaManage'));
      else if (error.status === 403) setFormError(t('errors.permissionManage'));
      else if (error.status === 503) setFormError(t('errors.unavailableSave'));
      else setFormError(error.message || t('errors.generic'));
    }
  };

  return (
    <form
      noValidate
      onSubmit={(event) => void onSubmit(event)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <SheetHeader>
        <SheetTitle>{t('form.title')}</SheetTitle>
        <SheetDescription>{t('form.description')}</SheetDescription>
      </SheetHeader>

      <SheetBody>
        <div aria-live="assertive" className="empty:hidden">
          {formError ? <Alert tone="error" title={formError} /> : null}
        </div>

        <Field label={label('name')} required error={errors.name}>
          <Input
            // eslint-disable-next-line jsx-a11y/no-autofocus -- foco no primeiro campo ao abrir o painel
            autoFocus
            value={name}
            maxLength={150}
            onChange={(event) => {
              setName(event.target.value);
              if (!keyTouched) setKey(keyFromName(event.target.value));
            }}
          />
        </Field>

        <Field
          label={label('key')}
          required
          error={errors.key}
          labelAddon={<InfoTooltip label={t('form.keyHelpLabel')}>{t('form.keyHint')}</InfoTooltip>}
        >
          <Input
            value={key}
            maxLength={60}
            className="font-mono"
            onChange={(event) => {
              setKeyTouched(true);
              setKey(event.target.value.toUpperCase());
            }}
          />
        </Field>

        <Field label={label('description')} error={errors.description}>
          <Textarea
            rows={3}
            value={description}
            maxLength={2000}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </Field>
      </SheetBody>

      <SheetFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t('form.cancel')}
        </Button>
        <Button type="submit" disabled={create.isPending} aria-busy={create.isPending}>
          {t('form.submit')}
        </Button>
      </SheetFooter>
    </form>
  );
}
