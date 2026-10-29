'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Label,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  toast,
} from '@contrataflow/ui';
import { PARTICIPANT_ROLES } from '@contrataflow/validation';
import type {
  DepartmentLookupItem,
  ParticipantRole,
  UserLookupItem,
} from '@contrataflow/validation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { newIdempotencyKey } from '@/lib/api/client';
import { useTenantId } from '@/lib/session/session-context';

import {
  EMPTY_PARTICIPANT_FORM,
  participantBodyOf,
  participantProblemOf,
  validateParticipant,
  withTargetType,
  withUser,
} from './process-participants-model';
import type { ParticipantFieldMessages, ParticipantFormValues } from './process-participants-model';
import {
  addParticipant,
  lookupUnits,
  lookupUsers,
  participantKeys,
} from './process-participants.api';
import { FormField, INPUT_CLASS, TEXTAREA_CLASS } from '../processes/form-field';

/** Espera curta entre teclas antes de buscar (USR-02/DEP-02). */
const SEARCH_DEBOUNCE_MS = 250;

function useDebounced(value: string): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [value]);
  return debounced;
}

type Target =
  | { readonly kind: 'USER'; readonly item: UserLookupItem }
  | { readonly kind: 'DEPARTMENT'; readonly item: DepartmentLookupItem };

/**
 * Busca de usuário (USR-02) ou unidade (DEP-02) com os resultados como botões (teclado e leitor de
 * tela); a seleção troca o campo pelo nome escolhido e o botão "Trocar".
 */
function TargetSearch({
  targetType,
  selectedName,
  onSelect,
  inputRef,
  error,
}: {
  readonly targetType: 'USER' | 'DEPARTMENT';
  readonly selectedName: string | null;
  readonly onSelect: (target: Target | null) => void;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly error: string | undefined;
}) {
  const t = useTranslations('processParticipants.dialog');
  const tenantId = useTenantId();
  const id = useId();
  const [text, setText] = useState('');
  const q = useDebounced(text.trim());
  const enabled = q.length >= 2 && selectedName === null;
  const results = useQuery({
    queryKey:
      targetType === 'USER'
        ? participantKeys.users(tenantId, q)
        : participantKeys.departments(tenantId, q),
    queryFn: async ({ signal }): Promise<Target[]> =>
      targetType === 'USER'
        ? (await lookupUsers(q, signal)).map((item) => ({ kind: 'USER' as const, item }))
        : (await lookupUnits(q, signal)).map((item) => ({ kind: 'DEPARTMENT' as const, item })),
    enabled,
    throwOnError: false,
  });
  const label = targetType === 'USER' ? t('searchUser') : t('searchDepartment');

  if (selectedName !== null) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">{label}</span>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm" aria-live="polite">
            {t('selected', { name: selectedName })}
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              onSelect(null);
              setText('');
            }}
          >
            {t('change')}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <FormField id={`${id}-search`} label={label} hint={t('searchHint')} error={error} required>
      {(control) => (
        <div className="flex flex-col gap-1">
          <input
            {...control}
            ref={inputRef}
            type="search"
            autoComplete="off"
            className={INPUT_CLASS}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
          {enabled ? (
            <div aria-live="polite" className="text-sm">
              {results.isFetching ? (
                <p className="text-muted-foreground">{t('searching')}</p>
              ) : results.isError ? (
                <p className="text-destructive">{t('searchFailed')}</p>
              ) : (results.data ?? []).length === 0 ? (
                <p className="text-muted-foreground">{t('noResults')}</p>
              ) : (
                <ul aria-label={label} className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                  {(results.data ?? []).map((target) => (
                    <li key={target.item.id}>
                      <button
                        type="button"
                        className="w-full rounded-control px-2 py-1 text-left hover:bg-muted focus-visible:bg-muted"
                        onClick={() => {
                          onSelect(target);
                        }}
                      >
                        <span className="block">{target.item.name}</span>
                        {target.kind === 'USER' ? (
                          <span className="block text-xs text-muted-foreground">
                            {target.item.membershipType === 'EXTERNAL'
                              ? `${target.item.email} · ${t('external')}`
                              : target.item.email}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      )}
    </FormField>
  );
}

export interface AddParticipantDialogProps {
  readonly processId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Recarrega a lista e o painel depois da inclusão. */
  readonly onAdded: () => Promise<void> | void;
}

/**
 * `AddParticipantDialog` (SCR-112 · fluxo principal, passos 1–6): alvo (usuário ou unidade),
 * papel — Consultor sugerido para vínculo externo —, validade (só Consultor), "Notificar" e motivo.
 * Uma `Idempotency-Key` por abertura do diálogo (reenvios após falha reaproveitam a chave).
 */
export function AddParticipantDialog({
  processId,
  open,
  onOpenChange,
  onAdded,
}: AddParticipantDialogProps) {
  const t = useTranslations('processParticipants');
  const id = useId();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [values, setValues] = useState<ParticipantFormValues>(EMPTY_PARTICIPANT_FORM);
  const [errors, setErrors] = useState<ParticipantFieldMessages>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [key, setKey] = useState(() => newIdempotencyKey());

  const reset = () => {
    setValues(EMPTY_PARTICIPANT_FORM);
    setErrors({});
    setNotice(null);
    setKey(newIdempotencyKey());
  };
  const close = () => {
    reset();
    onOpenChange(false);
  };

  const submit = useMutation({
    mutationFn: () => addParticipant(processId, participantBodyOf(values), key),
    onSuccess: async () => {
      toast({ title: t('toast.added'), tone: 'success' });
      close();
      await onAdded();
    },
    onError: (error: unknown) => {
      const problem = participantProblemOf(error);
      if (problem.kind === 'fields') {
        setErrors(problem.fields);
        return;
      }
      if (problem.kind === 'exists') {
        setNotice(
          problem.currentRole === null
            ? t('dialog.existsUnknown')
            : t('dialog.exists', { role: t(`roles.${problem.currentRole}`) }),
        );
        return;
      }
      setNotice(problem.kind === 'message' ? problem.message : t('dialog.unavailable'));
    },
  });

  const selectedName =
    values.targetType === 'USER' ? (values.user?.name ?? null) : (values.department?.name ?? null);
  const consultant = values.role === 'CONSULTANT';
  const roleHint = t(`dialog.roleHints.${values.role}`);
  const membershipExpiresAt = values.user?.membershipExpiresAt ?? null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent
        onOpenAutoFocus={(event) => {
          // Foco no campo de busca ao abrir (story · "Acessibilidade").
          event.preventDefault();
          searchRef.current?.focus();
        }}
      >
        <DialogTitle>{t('dialog.title')}</DialogTitle>
        <DialogDescription>{t('dialog.description')}</DialogDescription>
        {notice ? <Alert tone="warning" title={notice} /> : null}
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const found = validateParticipant(values, new Date());
            setErrors(found);
            setNotice(null);
            if (Object.keys(found).length === 0) submit.mutate();
          }}
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{t('dialog.targetType')}</legend>
            <RadioGroup
              orientation="horizontal"
              className="flex flex-wrap gap-4"
              value={values.targetType}
              onValueChange={(type) => {
                setValues((current) => withTargetType(current, type as 'USER' | 'DEPARTMENT'));
                setErrors({});
              }}
            >
              {(['USER', 'DEPARTMENT'] as const).map((type) => (
                <div key={type} className="flex items-center gap-2">
                  <RadioGroupItem id={`${id}-target-${type}`} value={type} />
                  <Label htmlFor={`${id}-target-${type}`} className="font-normal">
                    {type === 'USER' ? t('dialog.targetUser') : t('dialog.targetDepartment')}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </fieldset>
          <TargetSearch
            key={values.targetType}
            targetType={values.targetType}
            selectedName={selectedName}
            onSelect={(target) => {
              setValues((current) => {
                if (target === null) return { ...withUser(current, null), department: null };
                return target.kind === 'USER'
                  ? withUser(current, target.item)
                  : { ...current, department: target.item };
              });
              setErrors((current) => {
                const { target: _cleared, ...rest } = current;
                return rest;
              });
            }}
            inputRef={searchRef}
            error={errors.target}
          />
          <FormField
            id={`${id}-role`}
            label={t('dialog.role')}
            hint={
              values.user?.membershipType === 'EXTERNAL' && consultant
                ? `${t('dialog.consultantSuggested')} ${roleHint}`
                : roleHint
            }
            error={errors.role}
            required
          >
            {(control) => (
              <Select
                value={values.role}
                onValueChange={(role) => {
                  setValues((current) => ({ ...current, role: role as ParticipantRole }));
                }}
              >
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PARTICIPANT_ROLES.filter(
                    (role) => role !== 'CONSULTANT' || values.targetType === 'USER',
                  ).map((role) => (
                    <SelectItem key={role} value={role}>
                      {t(`roles.${role}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          {consultant ? (
            <FormField
              id={`${id}-expires`}
              label={t('dialog.expiresAt')}
              hint={
                membershipExpiresAt === null
                  ? undefined
                  : t('dialog.expiresAtHint', {
                      date: new Date(membershipExpiresAt).toLocaleDateString('pt-BR'),
                    })
              }
              error={errors.expiresAt}
              required
            >
              {(control) => (
                <input
                  {...control}
                  type="datetime-local"
                  className={INPUT_CLASS}
                  value={values.expiresAt}
                  onChange={(event) => {
                    setValues((current) => ({ ...current, expiresAt: event.target.value }));
                  }}
                />
              )}
            </FormField>
          ) : null}
          <div className="flex items-center gap-3">
            <Switch
              id={`${id}-notify`}
              checked={values.notify}
              onCheckedChange={(notify) => {
                setValues((current) => ({ ...current, notify }));
              }}
            />
            <Label htmlFor={`${id}-notify`} className="font-normal">
              {t('dialog.notify')}
            </Label>
          </div>
          <FormField id={`${id}-reason`} label={t('dialog.reason')} error={errors.reason}>
            {(control) => (
              <textarea
                {...control}
                className={TEXTAREA_CLASS}
                maxLength={500}
                value={values.reason}
                onChange={(event) => {
                  setValues((current) => ({ ...current, reason: event.target.value }));
                }}
              />
            )}
          </FormField>
          <DialogFooter>
            <Button variant="secondary" onClick={close}>
              {t('dialog.cancel')}
            </Button>
            <Button type="submit" disabled={submit.isPending}>
              {t('dialog.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
