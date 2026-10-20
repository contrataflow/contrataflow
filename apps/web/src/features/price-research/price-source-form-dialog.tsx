'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@contrataflow/ui';
import { PRICE_SOURCE_FIELD_LABELS, PRICE_SOURCE_MESSAGES } from '@contrataflow/validation';
import type {
  PriceSourceDto,
  PriceSourceRequiredField,
  SupplierDto,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { newIdempotencyKey } from '@/lib/api/client';
import { useTenantId } from '@/lib/session/session-context';

import {
  EMPTY_SOURCE_FORM,
  createSourceBody,
  formFromSource,
  updateSourceBody,
  validateSourceForm,
} from './price-source-model';
import type { SourceFormErrors, SourceFormValues, SourceTypeOption } from './price-source-model';
import { createPriceSource, updatePriceSource } from './price-sources.api';
import { FormField, INPUT_CLASS, TEXTAREA_CLASS } from '../processes/form-field';
import { fetchSuppliers, supplierKeys } from '../suppliers/suppliers.api';

/** Campos exigíveis exibidos no formulário, na ordem do catálogo (o anexo vem depois de salvar). */
const FIELDS = [
  'supplierId',
  'quoteDate',
  'accessedAt',
  'url',
  'referenceOrganization',
  'referenceDocument',
  'supplierChoiceJustification',
] as const satisfies readonly (keyof SourceFormValues & PriceSourceRequiredField)[];

/**
 * `PriceSourceForm` (US-026 · SCR-009 · fluxo principal 1–4, FA-01, FA-06): o tipo de fonte decide
 * quais campos são obrigatórios (os demais aparecem como opcionais e a troca do tipo é anunciada);
 * validação local (V-01/V-04/V-05) antes de enviar e os erros por campo da API no retorno. Criação com
 * `Idempotency-Key` (o mesmo valor ao reenviar os mesmos dados); edição com o `If-Match` da fonte.
 */
export function PriceSourceFormDialog({
  open,
  researchId,
  source,
  types,
  clock,
  onClose,
  onSaved,
}: {
  readonly open: boolean;
  readonly researchId: string;
  /** `null` = nova fonte. */
  readonly source: PriceSourceDto | null;
  readonly types: readonly SourceTypeOption[];
  readonly clock: { readonly now: () => Date; readonly today: string };
  readonly onClose: () => void;
  readonly onSaved: (source: PriceSourceDto, created: boolean) => void;
}) {
  const t = useTranslations('priceResearch.sources.form');
  const formId = useId();
  const [values, setValues] = useState<SourceFormValues>(
    source === null ? EMPTY_SOURCE_FORM : formFromSource(source),
  );
  const [errors, setErrors] = useState<SourceFormErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const attempt = useRef<{ readonly json: string; readonly key: string } | null>(null);

  const type = types.find((option) => option.id === values.sourceTypeId);
  const required = new Set<PriceSourceRequiredField>(type?.requiredFields ?? []);
  const set = <K extends keyof SourceFormValues>(key: K, value: SourceFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const save = async () => {
    const local = validateSourceForm(values, type, { now: clock.now(), today: clock.today });
    if (Object.values(local).some(Boolean)) {
      setErrors(local);
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      if (source === null) {
        const body = createSourceBody(values);
        const json = JSON.stringify(body);
        if (attempt.current?.json !== json) attempt.current = { json, key: newIdempotencyKey() };
        onSaved(await createPriceSource(researchId, body, attempt.current.key), true);
      } else {
        const patch = updateSourceBody(values, source);
        onSaved(
          patch === null ? source : await updatePriceSource(source.id, patch, source.version),
          false,
        );
      }
    } catch (error) {
      if (isApiError(error) && error.errors.length > 0) {
        setErrors(Object.fromEntries(error.errors.map((item) => [item.field, item.message])));
        setFailure(error.problem?.detail ?? null);
      } else if (isApiError(error) && error.status === 412) {
        setFailure(PRICE_SOURCE_MESSAGES.versionConflict);
      } else if (isApiError(error) && error.code === 'DOCUMENT_NOT_EDITABLE') {
        setFailure(PRICE_SOURCE_MESSAGES.notEditable);
      } else if (isApiError(error) && error.status === 403) {
        setFailure(PRICE_SOURCE_MESSAGES.permissionDenied);
      } else {
        setFailure(t('saveFailed'));
      }
    } finally {
      setSaving(false);
    }
  };

  const label = (field: keyof SourceFormValues, always = false) => (
    <>
      {t(`fields.${field}` as 'fields.description')}{' '}
      <span className="text-xs font-normal text-muted-foreground">
        {always || required.has(field as PriceSourceRequiredField) ? t('required') : t('optional')}
      </span>
    </>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogTitle>{source === null ? t('createTitle') : t('editTitle')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
        <form
          id={formId}
          noValidate
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {failure === null ? null : <Alert tone="error" title={failure} />}
          <FormField
            id={`${formId}-type`}
            label={label('sourceTypeId', true)}
            error={errors.sourceTypeId}
            required
            hint={
              type === undefined ? undefined : (
                // Rótulos condicionais anunciados ao trocar o tipo ("Acessibilidade").
                <span aria-live="polite">
                  {type.requiredFields.length === 0
                    ? t('noRequired')
                    : t('sourceTypeChanged', {
                        type: type.label,
                        fields: type.requiredFields
                          .map((field) => PRICE_SOURCE_FIELD_LABELS[field])
                          .join(', '),
                      })}
                </span>
              )
            }
          >
            {(control) => (
              <select
                {...control}
                className={INPUT_CLASS}
                value={values.sourceTypeId}
                onChange={(event) => {
                  set('sourceTypeId', event.target.value);
                }}
              >
                <option value="">{t('sourceTypePlaceholder')}</option>
                {types.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField
            id={`${formId}-description`}
            label={label('description', true)}
            error={errors.description}
            required
          >
            {(control) => (
              <input
                {...control}
                className={INPUT_CLASS}
                maxLength={300}
                value={values.description}
                onChange={(event) => {
                  set('description', event.target.value);
                }}
              />
            )}
          </FormField>
          {FIELDS.map((field) =>
            field === 'supplierId' ? (
              <SupplierPicker
                key={field}
                id={`${formId}-supplier`}
                label={label('supplierId')}
                required={required.has('supplierId')}
                error={errors.supplierId}
                value={{ id: values.supplierId, label: values.supplierLabel }}
                onChange={(supplier) => {
                  setValues((current) => ({
                    ...current,
                    supplierId: supplier?.id ?? '',
                    supplierLabel: supplier?.legalName ?? '',
                  }));
                  setErrors((current) => ({ ...current, supplierId: undefined }));
                }}
              />
            ) : (
              <FormField
                key={field}
                id={`${formId}-${field}`}
                label={label(field)}
                error={errors[field]}
                required={required.has(field)}
                hint={field === 'url' ? t('urlHint') : undefined}
              >
                {(control) =>
                  field === 'supplierChoiceJustification' ? (
                    <textarea
                      {...control}
                      className={TEXTAREA_CLASS}
                      value={values[field]}
                      onChange={(event) => {
                        set(field, event.target.value);
                      }}
                    />
                  ) : (
                    <input
                      {...control}
                      className={INPUT_CLASS}
                      type={
                        field === 'quoteDate'
                          ? 'date'
                          : field === 'accessedAt'
                            ? 'datetime-local'
                            : field === 'url'
                              ? 'url'
                              : 'text'
                      }
                      max={field === 'quoteDate' ? clock.today : undefined}
                      value={values[field]}
                      onChange={(event) => {
                        set(field, event.target.value);
                      }}
                    />
                  )
                }
              </FormField>
            ),
          )}
          <FormField id={`${formId}-notes`} label={label('notes')} error={errors.notes}>
            {(control) => (
              <textarea
                {...control}
                className={TEXTAREA_CLASS}
                value={values.notes}
                onChange={(event) => {
                  set('notes', event.target.value);
                }}
              />
            )}
          </FormField>
        </form>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form={formId} disabled={saving}>
            {saving ? t('saving') : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * `SupplierCombobox` simplificado (US-025 · SUP-01): busca por nome/documento (≥ 2 caracteres) entre
 * os fornecedores ativos e lista os resultados como botões; o escolhido fica no campo com "Trocar".
 */
function SupplierPicker({
  id,
  label,
  required,
  error,
  value,
  onChange,
}: {
  readonly id: string;
  readonly label: ReactNode;
  readonly required: boolean;
  readonly error: string | undefined;
  readonly value: { readonly id: string; readonly label: string };
  readonly onChange: (supplier: SupplierDto | null) => void;
}) {
  const t = useTranslations('priceResearch.sources.form');
  const tenantId = useTenantId();
  const [query, setQuery] = useState('');
  const term = query.trim();
  const filters = { q: term, isActive: 'true' as const };
  const results = useQuery({
    queryKey: supplierKeys.list(tenantId, filters, 1),
    queryFn: ({ signal }) => fetchSuppliers(filters, 1, signal),
    enabled: value.id === '' && term.length >= 2,
    throwOnError: false,
  });
  const resultsId = `${id}-results`;

  return (
    <FormField id={id} label={label} error={error} required={required}>
      {(control) =>
        value.id === '' ? (
          <div className="flex min-w-0 flex-col gap-2">
            <input
              {...control}
              type="search"
              className={INPUT_CLASS}
              placeholder={t('supplierSearch')}
              // Só aponta para a lista quando ela existe; um id ausente reprova no axe.
              aria-controls={term.length < 2 ? undefined : resultsId}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
            {term.length < 2 ? null : (
              <div id={resultsId} role="group" aria-label={t('supplierResults')}>
                {results.isPending ? (
                  <p className="text-sm text-muted-foreground">{t('supplierSearching')}</p>
                ) : (results.data?.items.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('supplierNone')}</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {results.data?.items.map((supplier) => (
                      <li key={supplier.id}>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="w-full justify-start text-left"
                          onClick={() => {
                            onChange(supplier);
                            setQuery('');
                          }}
                        >
                          {supplier.legalName} — {supplier.documentNumber}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <input {...control} readOnly className={INPUT_CLASS} value={value.label} />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                onChange(null);
              }}
            >
              {t('supplierClear')}
            </Button>
          </div>
        )
      }
    </FormField>
  );
}
