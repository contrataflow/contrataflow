'use client';

import { ITEM_KINDS } from '@contrataflow/types';
import type { ItemKind } from '@contrataflow/types';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  SheetContent,
  toast,
} from '@contrataflow/ui';
import {
  ITEM_CATALOG_SYSTEMS,
  ITEM_KIND_LABELS,
  PROCESS_ITEM_MESSAGES,
} from '@contrataflow/validation';
import type {
  CatalogItemDto,
  ItemCatalogSystem,
  ProcessItemDto,
  ProcessItemReference,
  UpdateProcessItemInput,
} from '@contrataflow/validation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { newIdempotencyKey } from '@/lib/api/client';
import { useShellSession } from '@/lib/session/session-context';

import {
  completedReferencesAffected,
  createBodyOf,
  formValuesOf,
  isUnitLocked,
  isUnusualKind,
  patchOf,
  validateItem,
} from './process-items-model';
import type { FieldMessages, ItemFormValues } from './process-items-model';
import { createProcessItem, updateProcessItem } from './process-items.api';
import { FormField, INPUT_CLASS, SelectField, TEXTAREA_CLASS } from '../processes/form-field';
import type { SelectOption } from '../processes/form-field';
import {
  WIZARD_CATALOG_STALE_TIME_MS,
  fetchActiveCatalog,
  processKeys,
} from '../processes/processes.api';

type Problem =
  | { readonly kind: 'formErrors' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'blocked'; readonly message: string }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

export interface ProcessItemFormProps {
  readonly processId: string;
  /** `null` = novo item; o item em edição vem sempre da lista mais recente (versão atual). */
  readonly item: ProcessItemDto | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** `metadata.itemKinds` do tipo de contratação (FA-05) e o rótulo do tipo. */
  readonly itemKinds: readonly ItemKind[] | null;
  readonly contractingTypeLabel: string;
  /** Recarrega a lista e o painel (sucesso, 412 e recusas por estado — FA-08). */
  readonly onChanged: () => Promise<void> | void;
}

function useUnits() {
  const session = useShellSession();
  return useQuery({
    queryKey: processKeys.activeCatalog(session.activeTenant.id, 'UNIT_OF_MEASURE'),
    queryFn: ({ signal }) => fetchActiveCatalog('UNIT_OF_MEASURE', signal),
    staleTime: WIZARD_CATALOG_STALE_TIME_MS,
    throwOnError: false,
  });
}

/** Unidades ativas + a atual do item (mesmo inativa: segue exibida — RN-TEN-61). */
function unitOptions(
  units: readonly CatalogItemDto[] | undefined,
  item: ProcessItemDto | null,
): SelectOption[] {
  const options = (units ?? []).map((unit) => ({ value: unit.id, label: unit.label }));
  if (item !== null && !options.some((option) => option.value === item.unitOfMeasure.id)) {
    options.unshift({ value: item.unitOfMeasure.id, label: item.unitOfMeasure.label });
  }
  return options;
}

/**
 * `ProcessItemForm` (US-006 · SCR-006): painel lateral de inclusão/edição de item, validado com o
 * MESMO schema da API (`createProcessItemSchema`). Inclusão com `Idempotency-Key` estável entre
 * reenvios; edição só com os campos alterados e `If-Match` da versão do item. 412 recarrega a lista
 * mantendo o formulário (FA-08); unidade travada em item com quantidades em documentos (FA-04);
 * confirmação quando documentos concluídos manterão os dados anteriores (FA-03).
 */
export function ProcessItemForm(props: ProcessItemFormProps) {
  const t = useTranslations('processItems.form');
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent closeLabel={t('close')} aria-describedby={undefined}>
        <div className="border-b border-border p-4 pr-12">
          <DialogTitle>
            {props.item === null
              ? t('addTitle')
              : t('editTitle', { sequence: props.item.sequence })}
          </DialogTitle>
        </div>
        {props.open ? <ItemForm key={props.item?.id ?? 'new'} {...props} /> : null}
      </SheetContent>
    </Dialog>
  );
}

function ItemForm({
  processId,
  item,
  onOpenChange,
  itemKinds,
  contractingTypeLabel,
  onChanged,
}: ProcessItemFormProps) {
  const t = useTranslations('processItems');
  const idPrefix = useId();
  const units = useUnits();
  const [values, setValues] = useState<ItemFormValues>(() =>
    formValuesOf(item, itemKinds?.[0] ?? null),
  );
  const [messages, setMessages] = useState<FieldMessages>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  const [confirming, setConfirming] = useState<readonly ProcessItemReference[] | null>(null);
  const idempotencyKey = useRef(newIdempotencyKey());
  const unitLocked = isUnitLocked(item);

  const set = <K extends keyof ItemFormValues>(field: K, value: ItemFormValues[K]) => {
    setValues((current) => ({ ...current, [field]: value }));
  };
  const fieldId = (name: string) => `${idPrefix}-${name}`;

  const save = useMutation({
    mutationFn: async (patch: UpdateProcessItemInput | null) => {
      if (item === null) {
        return createProcessItem(processId, createBodyOf(values), idempotencyKey.current);
      }
      return updateProcessItem(item.id, patch ?? {}, item.version);
    },
    onSuccess: async () => {
      toast({ title: item === null ? t('toast.added') : t('toast.updated'), tone: 'success' });
      idempotencyKey.current = newIdempotencyKey();
      await onChanged();
      onOpenChange(false);
    },
    onError: (error: unknown) => {
      if (!isApiError(error)) {
        setProblem({ kind: 'unexpected', correlationId: '—' });
        return;
      }
      if (error.status === 412) {
        // FA-08: recarrega a lista e mantém o formulário (a próxima gravação usa a versão nova).
        setProblem({ kind: 'stale' });
        void onChanged();
        return;
      }
      if (error.code === 'ITEM_IN_USE') {
        setMessages({ unitOfMeasureId: PROCESS_ITEM_MESSAGES.unitLocked });
        setProblem({ kind: 'formErrors' });
        void onChanged();
        return;
      }
      if (error.code === 'IDEMPOTENCY_KEY_REUSED') {
        idempotencyKey.current = newIdempotencyKey();
      }
      if (error.status === 422) {
        const next: FieldMessages = {};
        for (const entry of error.errors) {
          if (entry.field in values) next[entry.field as keyof FieldMessages] ??= entry.message;
        }
        setMessages(next);
        setProblem(
          Object.keys(next).length > 0
            ? { kind: 'formErrors' }
            : { kind: 'blocked', message: error.problem?.detail ?? t('errors.formErrors') },
        );
        return;
      }
      if (error.status === 403 || error.status === 409) {
        setProblem({
          kind: 'blocked',
          message:
            error.code === 'PERMISSION_DENIED'
              ? t('errors.permission')
              : (error.problem?.detail ?? error.message),
        });
        void onChanged();
        return;
      }
      if (error.status === 404) {
        toast({ title: t('errors.notFound'), tone: 'error' });
        void onChanged();
        onOpenChange(false);
        return;
      }
      if (error.status === 503 || error.status === 429) {
        setProblem({ kind: 'unavailable' });
        return;
      }
      setProblem({ kind: 'unexpected', correlationId: error.correlationId ?? '—' });
    },
  });

  const submit = () => {
    const found = validateItem(values);
    setMessages(found);
    if (Object.keys(found).length > 0) {
      setProblem({ kind: 'formErrors' });
      return;
    }
    setProblem(null);
    if (item === null) {
      save.mutate(null);
      return;
    }
    const patch = patchOf(item, values);
    if (Object.keys(patch).length === 0) {
      onOpenChange(false);
      return;
    }
    const affected = completedReferencesAffected(item, patch);
    if (affected.length > 0) {
      setConfirming(affected);
      return;
    }
    save.mutate(patch);
  };

  const kindOptions = ITEM_KINDS.map((kind) => ({ value: kind, label: ITEM_KIND_LABELS[kind] }));
  const systemOptions = ITEM_CATALOG_SYSTEMS.map((system) => ({
    value: system,
    label: t(`form.systems.${system}`),
  }));
  const unusual = isUnusualKind(values.kind, itemKinds);

  return (
    <form
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div aria-live="polite">
          {problem?.kind === 'formErrors' ? (
            <Alert tone="error" title={t('errors.formErrors')} />
          ) : null}
          {problem?.kind === 'stale' ? (
            <Alert tone="warning" title={PROCESS_ITEM_MESSAGES.stale} />
          ) : null}
          {problem?.kind === 'blocked' ? <Alert tone="error" title={problem.message} /> : null}
          {problem?.kind === 'unavailable' ? (
            <Alert tone="error" title={t('errors.unavailable')} />
          ) : null}
          {problem?.kind === 'unexpected' ? (
            <Alert
              tone="error"
              title={t('errors.unexpected', { correlationId: problem.correlationId })}
            />
          ) : null}
        </div>
        <FormField
          id={fieldId('description')}
          label={t('form.fields.description')}
          error={messages.description}
          required
        >
          {(control) => (
            <textarea
              {...control}
              className={TEXTAREA_CLASS}
              value={values.description}
              maxLength={2000}
              onChange={(event) => {
                set('description', event.target.value);
              }}
            />
          )}
        </FormField>
        <FormField
          id={fieldId('kind')}
          label={t('form.fields.kind')}
          error={messages.kind}
          required
          hint={unusual ? t('form.unusualKind', { type: contractingTypeLabel }) : undefined}
        >
          {(control) => (
            <select
              {...control}
              className={INPUT_CLASS}
              value={values.kind}
              onChange={(event) => {
                set('kind', event.target.value as ItemKind | '');
              }}
            >
              <option value="">{t('form.select')}</option>
              {kindOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </FormField>
        {unitLocked && item !== null ? (
          <FormField
            id={fieldId('unitOfMeasureId')}
            label={t('form.fields.unitOfMeasureId')}
            hint={PROCESS_ITEM_MESSAGES.unitLocked}
            error={messages.unitOfMeasureId}
          >
            {(control) => (
              <input
                {...control}
                className={INPUT_CLASS}
                value={item.unitOfMeasure.label}
                readOnly
                aria-readonly
              />
            )}
          </FormField>
        ) : (
          <SelectField
            id={fieldId('unitOfMeasureId')}
            label={t('form.fields.unitOfMeasureId')}
            value={values.unitOfMeasureId}
            onChange={(value) => {
              set('unitOfMeasureId', value);
            }}
            options={unitOptions(units.data, item)}
            placeholder={t('form.select')}
            status={units.data !== undefined ? 'ready' : units.isError ? 'error' : 'pending'}
            emptyMessage={t('form.noUnits')}
            loadingLabel={t('form.loadingOptions')}
            errorLabel={t('form.loadError')}
            retryLabel={t('form.retry')}
            onRetry={() => {
              void units.refetch();
            }}
            error={messages.unitOfMeasureId}
            required
          />
        )}
        <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
          <FormField
            id={fieldId('lotNumber')}
            label={t('form.fields.lotNumber')}
            error={messages.lotNumber}
          >
            {(control) => (
              <input
                {...control}
                className={INPUT_CLASS}
                inputMode="numeric"
                value={values.lotNumber}
                onChange={(event) => {
                  set('lotNumber', event.target.value);
                }}
              />
            )}
          </FormField>
          <FormField
            id={fieldId('lotName')}
            label={t('form.fields.lotName')}
            hint={t('form.lotNameHint')}
            error={messages.lotName}
          >
            {(control) => (
              <input
                {...control}
                className={INPUT_CLASS}
                maxLength={150}
                value={values.lotName}
                onChange={(event) => {
                  set('lotName', event.target.value);
                }}
              />
            )}
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
          <FormField
            id={fieldId('catalogSystem')}
            label={t('form.fields.catalogSystem')}
            error={messages.catalogSystem}
          >
            {(control) => (
              <select
                {...control}
                className={INPUT_CLASS}
                value={values.catalogSystem}
                onChange={(event) => {
                  set('catalogSystem', event.target.value as ItemCatalogSystem | '');
                }}
              >
                <option value="">{t('form.noSystem')}</option>
                {systemOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField
            id={fieldId('catalogCode')}
            label={t('form.fields.catalogCode')}
            error={messages.catalogCode}
          >
            {(control) => (
              <input
                {...control}
                className={INPUT_CLASS}
                maxLength={30}
                value={values.catalogCode}
                onChange={(event) => {
                  set('catalogCode', event.target.value);
                }}
              />
            )}
          </FormField>
        </div>
        <FormField id={fieldId('notes')} label={t('form.fields.notes')} error={messages.notes}>
          {(control) => (
            <textarea
              {...control}
              className={TEXTAREA_CLASS}
              maxLength={2000}
              value={values.notes}
              onChange={(event) => {
                set('notes', event.target.value);
              }}
            />
          )}
        </FormField>
      </div>
      <div className="flex flex-col-reverse gap-2 border-t border-border p-4 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            onOpenChange(false);
          }}
        >
          {t('form.cancel')}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? t('form.saving') : t('form.save')}
        </Button>
      </div>
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <DialogContent closeLabel={null}>
          <DialogTitle>{t('snapshot.title')}</DialogTitle>
          <DialogDescription>
            {t('snapshot.description', {
              documents: (confirming ?? [])
                .map(
                  (reference) =>
                    `${reference.code} (${t(`documentStatuses.${reference.status}` as 'documentStatuses.DRAFT')})`,
                )
                .join(', '),
            })}
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirming(null);
              }}
            >
              {t('snapshot.cancel')}
            </Button>
            <Button
              onClick={() => {
                setConfirming(null);
                if (item !== null) save.mutate(patchOf(item, values));
              }}
            >
              {t('snapshot.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}
