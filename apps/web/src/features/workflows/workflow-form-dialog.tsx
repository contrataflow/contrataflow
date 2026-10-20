'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  toast,
} from '@contrataflow/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { SyntheticEvent } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';
import { useTenantId } from '@/lib/session/session-context';

import { keyFromName, workflowKeyProblems, workflowNameProblems } from './workflow-editor-model';
import type { FieldProblem } from './workflow-editor-model';
import { createWorkflow, workflowEditorHref, workflowKeys } from './workflows.api';
import type { WorkflowCreateInput } from './workflows.api';

const INPUT = 'h-10 w-full rounded-control border border-border bg-surface px-3 text-sm';

type Field = 'name' | 'key' | 'description';

/**
 * "Novo workflow" (SCR-034 · US-043 passo 2): nome, chave técnica (sugerida pelo nome e editável
 * até salvar — imutável depois, RN-WF-45) e descrição; WF-02 cria o workflow com a v1 em rascunho
 * e a tela segue para o editor.
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('form.cancel')}>
        <DialogTitle>{t('form.title')}</DialogTitle>
        <DialogDescription>{t('form.description')}</DialogDescription>
        {open ? (
          <WorkflowForm
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function WorkflowForm({ onClose }: { readonly onClose: () => void }) {
  const t = useTranslations('workflows');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const router = useRouter();
  const ids = useId();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const create = useIdempotentMutation({
    mutationFn: (body: WorkflowCreateInput, context) => createWorkflow(body, context),
  });

  const label = (field: Field) => t(`form.fields.${field}`);
  const messageOf = (problem: FieldProblem) => {
    if (problem.code === 'REQUIRED')
      return t('form.required', { field: label(problem.field as Field) });
    if (problem.code === 'KEY_PATTERN') return t('form.keyPattern');
    return t('form.nameLength');
  };

  const validate = () => {
    const found: Partial<Record<Field, string>> = {};
    for (const problem of [...workflowNameProblems(name), ...workflowKeyProblems(key)]) {
      found[problem.field as Field] = messageOf(problem);
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
        const next: Partial<Record<Field, string>> = {};
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

  const errorId = (field: Field) => `${ids}-${field}-error`;
  const describedBy = (field: Field, hint?: string) =>
    [hint, errors[field] ? errorId(field) : undefined].filter(Boolean).join(' ') || undefined;

  return (
    <form noValidate onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor={`${ids}-name`} className="text-sm font-medium">
          {label('name')}
        </label>
        <input
          id={`${ids}-name`}
          value={name}
          maxLength={150}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={describedBy('name')}
          className={INPUT}
          onChange={(event) => {
            setName(event.target.value);
            if (!keyTouched) setKey(keyFromName(event.target.value));
          }}
        />
        {errors.name ? (
          <p id={errorId('name')} className="text-sm text-destructive">
            {errors.name}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${ids}-key`} className="text-sm font-medium">
          {label('key')}
        </label>
        <input
          id={`${ids}-key`}
          value={key}
          maxLength={60}
          aria-invalid={errors.key ? true : undefined}
          aria-describedby={describedBy('key', `${ids}-key-hint`)}
          className={`${INPUT} font-mono`}
          onChange={(event) => {
            setKeyTouched(true);
            setKey(event.target.value.toUpperCase());
          }}
        />
        <p id={`${ids}-key-hint`} className="text-xs text-muted-foreground">
          {t('form.keyHint')}
        </p>
        {errors.key ? (
          <p id={errorId('key')} className="text-sm text-destructive">
            {errors.key}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${ids}-description`} className="text-sm font-medium">
          {label('description')}
        </label>
        <textarea
          id={`${ids}-description`}
          value={description}
          maxLength={2000}
          aria-invalid={errors.description ? true : undefined}
          aria-describedby={describedBy('description')}
          className="min-h-20 w-full rounded-control border border-border bg-surface px-3 py-2 text-sm"
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
      <div aria-live="assertive">{formError ? <Alert tone="error" title={formError} /> : null}</div>
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t('form.cancel')}
        </Button>
        <Button type="submit" disabled={create.isPending} aria-busy={create.isPending}>
          {t('form.submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}
