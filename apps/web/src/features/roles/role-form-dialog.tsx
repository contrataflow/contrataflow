'use client';

import {
  Alert,
  Button,
  Checkbox,
  Field,
  Input,
  Label,
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
import { createRoleSchema, updateRoleSchema } from '@contrataflow/validation';
import type { RoleDto, UpdateRoleInput } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { SyntheticEvent } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { stepUpHref } from '@/lib/api/error-policy';
import { useTenantId } from '@/lib/session/session-context';

import { createRole, roleKeys, updateRole } from './roles.api';

export interface RoleFormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Perfil em edição (ROL-05); ausente = criação (ROL-03). */
  readonly role?: RoleDto | undefined;
  /** Chamado depois de criar (a lista leva ao detalhe do perfil — passo 4). */
  readonly onCreated?: (role: RoleDto) => void;
  /** Rota de retorno do *step-up* de MFA. */
  readonly returnTo: string;
}

/**
 * `RoleForm` (SCR-030/031 · US-095 · passos 2–3 e 8) no painel lateral do kit (`Sheet`): nome, descrição e
 * `allowExternalAssignment`, validados pelos mesmos schemas Zod da API. A edição envia só o que
 * mudou, com `If-Match`; 409 vai para o campo "Nome"; 412 pede recarga; `MFA_REQUIRED` oferece o
 * *step-up* (RN-IAM-83).
 */
export function RoleFormDialog(props: RoleFormDialogProps) {
  const t = useTranslations('roles');
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent closeLabel={t('form.close')}>
        {props.open ? <RoleFormBody key={props.role?.id ?? 'novo'} {...props} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function RoleFormBody({ role, onOpenChange, onCreated, returnTo }: RoleFormDialogProps) {
  const t = useTranslations('roles');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const ids = useId();
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [external, setExternal] = useState(role?.allowExternalAssignment ?? false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [needsMfa, setNeedsMfa] = useState(false);

  const save = useMutation({
    mutationFn: async () => {
      if (!role) {
        return createRole({
          name,
          ...(description.trim() === '' ? {} : { description }),
          ...(external ? { allowExternalAssignment: true } : {}),
        });
      }
      const patch: UpdateRoleInput = {
        ...(name.trim() !== role.name ? { name } : {}),
        ...(description.trim() !== (role.description ?? '')
          ? { description: description.trim() === '' ? null : description }
          : {}),
        ...(external !== role.allowExternalAssignment ? { allowExternalAssignment: external } : {}),
      };
      return updateRole(role.id, patch, role.version);
    },
    onSuccess: (result) => {
      toast({
        title: t(role ? 'toast.updated' : 'toast.created', { name: result.data.name }),
        tone: 'success',
      });
      void queryClient.invalidateQueries({ queryKey: roleKeys.all(tenantId) });
      onOpenChange(false);
      if (!role) onCreated?.(result.data);
    },
    onError: (error) => {
      if (!isApiError(error)) {
        setFormError(t('errors.generic'));
      } else if (error.code === 'ROLE_ALREADY_EXISTS') {
        setNameError(error.message);
      } else if (error.code === 'MFA_REQUIRED') {
        setNeedsMfa(true);
        setFormError(t('errors.mfa'));
      } else if (error.status === 412) {
        setFormError(t('errors.conflict'));
        void queryClient.invalidateQueries({ queryKey: roleKeys.all(tenantId) });
      } else if (error.status === 403) {
        setFormError(t('errors.permission'));
      } else if (error.status === 503) {
        setFormError(t('errors.unavailable'));
      } else {
        const field = error.errors.find((item) => item.field === 'name');
        if (field) setNameError(field.message);
        else setFormError(error.message || t('errors.generic'));
      }
    },
  });

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNameError(null);
    setFormError(null);
    setNeedsMfa(false);
    const schema = role ? updateRoleSchema : createRoleSchema;
    const parsed = schema.safeParse({ name, description: description.trim() || null });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      if (issue?.path[0] === 'name') setNameError(issue.message);
      else setFormError(issue?.message ?? t('errors.generic'));
      return;
    }
    save.mutate();
  };

  const externalId = `${ids}-external`;
  const externalHintId = `${ids}-external-hint`;

  return (
    <form noValidate onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
      <SheetHeader>
        <SheetTitle>{t(role ? 'form.editTitle' : 'form.createTitle')}</SheetTitle>
        <SheetDescription>{t('form.description')}</SheetDescription>
      </SheetHeader>

      <SheetBody>
        <div aria-live="polite" className="empty:hidden">
          {formError ? (
            <Alert tone="error" title={formError}>
              {needsMfa ? (
                <a className="font-medium underline" href={stepUpHref(returnTo)}>
                  {t('errors.stepUp')}
                </a>
              ) : null}
            </Alert>
          ) : null}
        </div>

        <Field label={t('form.name')} required error={nameError ?? undefined}>
          <Input
            // eslint-disable-next-line jsx-a11y/no-autofocus -- foco no primeiro campo ao abrir o painel
            autoFocus
            value={name}
            maxLength={200}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>

        <Field label={t('form.descriptionField')}>
          <Textarea
            rows={3}
            maxLength={500}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </Field>

        <div className="flex items-start gap-3">
          <Checkbox
            id={externalId}
            checked={external}
            aria-describedby={externalHintId}
            onCheckedChange={(checked) => {
              setExternal(checked === true);
            }}
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor={externalId}>{t('form.allowExternalAssignment')}</Label>
            <p id={externalHintId} className="text-[0.8125rem] text-muted-foreground">
              {t('form.allowExternalAssignmentHint')}
            </p>
          </div>
        </div>
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
        <Button type="submit" disabled={save.isPending} aria-busy={save.isPending}>
          {t(role ? 'form.save' : 'form.create')}
        </Button>
      </SheetFooter>
    </form>
  );
}
