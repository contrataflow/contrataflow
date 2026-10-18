'use client';

import type { CatalogType } from '@contrataflow/types';
import { Alert, Button, Skeleton } from '@contrataflow/ui';
import type {
  DfdHeaderField,
  DfdHeaderValues,
  DfdTemplateSectionDto,
  ProcessDto,
} from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useShellSession, useTenantId } from '@/lib/session/session-context';

import { DfdSectionField } from './dfd-justification-step';
import { itemRows, itemsPayload, mergeItemEdits, rowQuantityError } from './dfd-model';
import type { ItemEdit, ItemRow } from './dfd-model';
import { dfdKeys, fetchDocumentItems, replaceDocumentItems, useDocumentItems } from './dfd.api';
import { documentKeys } from '../documents/documents.api';
import { useAvailableActions } from '../process-actions/process-actions.api';
import { ProcessItemForm } from '../process-items/process-item-form';
import { itemKindsOf } from '../process-items/process-items-model';
import { itemKeys, useProcessItems } from '../process-items/process-items.api';
import { FormField, INPUT_CLASS } from '../processes/form-field';
import { formatMoneyText, toDecimalMoney } from '../processes/money';
import { MoneyInput } from '../processes/money-input';
import { PcaFieldset } from '../processes/pca-fieldset';
import {
  WIZARD_CATALOG_STALE_TIME_MS,
  fetchActiveCatalog,
  processKeys,
} from '../processes/processes.api';

function useActiveCatalog(type: CatalogType) {
  const session = useShellSession();
  return useQuery({
    queryKey: processKeys.activeCatalog(session.activeTenant.id, type),
    queryFn: ({ signal }) => fetchActiveCatalog(type, signal),
    staleTime: WIZARD_CATALOG_STALE_TIME_MS,
    throwOnError: false,
  });
}

const moneyFormat = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export interface DocumentItemsGridProps {
  readonly processId: string;
  readonly documentId: string;
  readonly editable: boolean;
  readonly process: ProcessDto | undefined;
}

/**
 * `DocumentItemsGrid` (SCR-007 · passo 3 · RN-DFD-14/15): os itens do processo com "Incluir neste
 * DFD" e a quantidade; cada alteração substitui a coleção pelo DOC-07 com o `If-Match` da versão do
 * documento. 412 (outra pessoa salvou antes) recarrega os itens, reaplica só as alterações locais
 * por `processItemId` e salva de novo, preservando as do outro editor. "Adicionar item ao processo"
 * só aparece quando o PRC-08 libera `MANAGE_ITEMS` (`PROCESS_UPDATE` + custódia). Abaixo de 768 px
 * a tabela vira lista de cartões.
 */
export function DocumentItemsGrid({
  processId,
  documentId,
  editable,
  process,
}: DocumentItemsGridProps) {
  const t = useTranslations('dfd.planning');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const items = useDocumentItems(documentId);
  const processItems = useProcessItems(processId);
  const units = useActiveCatalog('UNIT_OF_MEASURE');
  const contractingTypes = useActiveCatalog('CONTRACTING_TYPE');
  const actions = useAvailableActions(processId);
  const [edits, setEdits] = useState<Readonly<Record<string, ItemEdit>>>({});
  const [announcement, setAnnouncement] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const canAddItem =
    editable && actions.data?.some((entry) => entry.action === 'MANAGE_ITEMS' && entry.enabled);
  const contractingType = contractingTypes.data?.find(
    (type) => type.id === process?.contractingType.id,
  );
  const allowsDecimal = new Map(
    (units.data ?? []).map((unit) => [unit.id, unit.metadata.allowsDecimal !== false]),
  );

  const save = useMutation({
    mutationFn: async (pending: Readonly<Record<string, ItemEdit>>) => {
      const current = items.data ?? (await fetchDocumentItems(documentId));
      const baseRows = applyEdits(
        itemRows(processItems.data?.items ?? [], current.items, allowsDecimal),
        pending,
      );
      try {
        return await replaceDocumentItems(
          documentId,
          itemsPayload(baseRows),
          current.documentVersion,
        );
      } catch (error) {
        if (!(isApiError(error) && error.status === 412)) throw error;
        // V-11: recarrega e reaplica só o que este usuário alterou.
        setAnnouncement(t('conflict'));
        const fresh = await fetchDocumentItems(documentId);
        return replaceDocumentItems(
          documentId,
          mergeItemEdits(fresh.items, Object.values(pending)),
          fresh.documentVersion,
        );
      }
    },
    onSuccess: async (saved, pending) => {
      setFailure(null);
      queryClient.setQueryData(dfdKeys.items(tenantId, documentId), saved);
      // Só descarta as edições já gravadas (as feitas durante a gravação continuam pendentes).
      setEdits((current) =>
        Object.fromEntries(Object.entries(current).filter(([id, edit]) => pending[id] !== edit)),
      );
      setAnnouncement((current) => (current === t('conflict') ? current : t('saved')));
      await queryClient.invalidateQueries({
        queryKey: documentKeys.validation(tenantId, documentId),
      });
    },
    onError: () => {
      setFailure(t('saveError'));
      void items.refetch();
    },
  });

  if (items.data === undefined || processItems.data === undefined) {
    return (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">{t('saving')}</span>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  const rows = applyEdits(
    itemRows(processItems.data.items, items.data.items, allowsDecimal),
    edits,
  );

  const change = (
    row: ItemRow,
    next: Partial<Pick<ItemRow, 'included' | 'quantity'>>,
    commit: boolean,
  ) => {
    const edit: ItemEdit = {
      processItemId: row.processItemId,
      included: next.included ?? row.included,
      quantity: next.quantity ?? row.quantity,
    };
    const pending = { ...edits, [row.processItemId]: edit };
    setEdits(pending);
    if (!commit) return;
    const after = applyEdits(rows, pending);
    if (after.some((candidate) => rowQuantityError(candidate) !== null)) return;
    save.mutate(pending);
  };

  return (
    <section
      id="dfd-field-items"
      tabIndex={-1}
      aria-labelledby="dfd-items-title"
      className="flex min-w-0 flex-col gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h3 id="dfd-items-title" className="text-base font-semibold">
            {t('itemsTitle')}
          </h3>
          <p className="text-sm text-muted-foreground">{t('itemsHint')}</p>
        </div>
        {canAddItem ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setAdding(true);
            }}
          >
            {t('addItem')}
          </Button>
        ) : null}
      </div>
      <p aria-live="polite" className="sr-only">
        {save.isPending ? t('saving') : announcement}
      </p>
      {failure ? <Alert tone="error" title={failure} /> : null}
      {rows.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-card border border-dashed border-border p-6">
          <p className="text-sm font-medium">{t('emptyItems')}</p>
          {canAddItem ? null : (
            <p className="text-sm text-muted-foreground">{t('emptyItemsGuidance')}</p>
          )}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const error = rowQuantityError(row);
            const quantityId = `dfd-item-quantity-${row.processItemId}`;
            return (
              <li
                key={row.processItemId}
                className="grid grid-cols-1 items-start gap-2 rounded-card border border-border p-3 md:grid-cols-[auto_3rem_1fr_8rem_10rem]"
              >
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={row.included}
                    disabled={!editable || save.isPending}
                    aria-label={t('includeItem', { number: row.sequence })}
                    onChange={(event) => {
                      change(row, { included: event.target.checked }, true);
                    }}
                  />
                  <span className="md:sr-only">{t('include')}</span>
                </label>
                <span className="text-sm font-medium">
                  <span className="sr-only">{t('number')} </span>
                  {row.sequence}
                </span>
                <span className="text-sm">{row.description}</span>
                <span className="text-sm text-muted-foreground">
                  <span className="sr-only">{t('unit')}: </span>
                  {row.unitLabel}
                </span>
                <div className="flex flex-col gap-1">
                  <label htmlFor={quantityId} className="sr-only">
                    {t('quantityOf', { number: row.sequence })}
                  </label>
                  <input
                    id={quantityId}
                    className={INPUT_CLASS}
                    inputMode={row.allowsDecimal ? 'decimal' : 'numeric'}
                    placeholder={t('quantity')}
                    value={row.quantity}
                    disabled={!editable || !row.included}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${quantityId}-error` : undefined}
                    onChange={(event) => {
                      change(row, { quantity: event.target.value.replace(',', '.') }, false);
                    }}
                    onBlur={() => {
                      if (edits[row.processItemId] !== undefined) change(row, {}, true);
                    }}
                  />
                  {error ? (
                    <p
                      id={`${quantityId}-error`}
                      className="text-sm text-destructive"
                      aria-live="polite"
                    >
                      {error}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {adding ? (
        <ProcessItemForm
          processId={processId}
          item={null}
          open={adding}
          onOpenChange={setAdding}
          itemKinds={itemKindsOf(contractingType?.metadata)}
          contractingTypeLabel={contractingType?.label ?? ''}
          onChanged={async () => {
            await queryClient.invalidateQueries({ queryKey: itemKeys.list(tenantId, processId) });
          }}
        />
      ) : null}
    </section>
  );
}

function applyEdits(
  rows: readonly ItemRow[],
  edits: Readonly<Record<string, ItemEdit>>,
): ItemRow[] {
  return rows.map((row) => {
    const edit = edits[row.processItemId];
    return edit === undefined ? row : { ...row, included: edit.included, quantity: edit.quantity };
  });
}

export interface DfdPlanningStepProps {
  readonly processId: string;
  readonly documentId: string;
  readonly header: DfdHeaderValues;
  readonly errors: Partial<Record<DfdHeaderField, string>>;
  readonly editable: boolean;
  readonly process: ProcessDto | undefined;
  readonly currentYear: number;
  readonly notesSection: DfdTemplateSectionDto | null;
  readonly notes: string;
  readonly estimatedValueText: string;
  readonly onChange: (field: DfdHeaderField, value: string | number | null) => void;
  readonly onEstimatedValueText: (text: string) => void;
  readonly onSectionChange: (key: string, value: string) => void;
}

/**
 * `DfdPlanningStep` (SCR-007 · passo 3 · Decreto 10.947/2022, art. 8º, III/IV/V/VII): itens e
 * quantidades, previsão, estimativa preliminar (POL-09: "Valor sigiloso" sem edição; atalho do
 * valor manual da abertura), vínculo com o PCA e observações.
 */
export function DfdPlanningStep({
  processId,
  documentId,
  header,
  errors,
  editable,
  process,
  currentYear,
  notesSection,
  notes,
  estimatedValueText,
  onChange,
  onEstimatedValueText,
  onSectionChange,
}: DfdPlanningStepProps) {
  const t = useTranslations('dfd.planning');
  const masked = header.estimatedValueMasked === true;
  const processValue =
    !masked &&
    process?.estimatedValueMasked === false &&
    process.estimatedValueSource === 'MANUAL' &&
    process.estimatedValue !== null
      ? process.estimatedValue
      : null;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <DocumentItemsGrid
        processId={processId}
        documentId={documentId}
        editable={editable}
        process={process}
      />
      <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
        <FormField
          id="dfd-field-expectedDate"
          label={t('expectedDate')}
          error={errors.expectedDate}
          required
        >
          {(control) => (
            <input
              {...control}
              type="date"
              className={INPUT_CLASS}
              value={header.expectedDate ?? ''}
              readOnly={!editable}
              onChange={(event) => {
                onChange('expectedDate', event.target.value || null);
              }}
            />
          )}
        </FormField>
        <FormField
          id="dfd-field-estimatedValue"
          label={t('estimatedValue')}
          hint={masked ? undefined : t('estimatedValueHint')}
          error={errors.estimatedValue}
        >
          {(control) =>
            masked ? (
              <input
                {...control}
                className={INPUT_CLASS}
                value={t('confidentialValue')}
                readOnly
                aria-readonly
              />
            ) : (
              <div className="flex flex-col gap-2">
                <MoneyInput
                  {...control}
                  value={estimatedValueText}
                  readOnly={!editable}
                  onValueChange={onEstimatedValueText}
                />
                {editable && processValue !== null ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      onEstimatedValueText(formatMoneyText(processValue));
                    }}
                  >
                    {t('useProcessValue', { value: moneyFormat.format(Number(processValue)) })}
                  </Button>
                ) : null}
              </div>
            )
          }
        </FormField>
        <fieldset disabled={!editable} className="min-w-0 md:col-span-2">
          <PcaFieldset
            idPrefix="dfd-field"
            values={{
              pcaStatus: header.pcaStatus ?? '',
              pcaYear: header.pcaYear === null ? '' : String(header.pcaYear),
              pcaItemCode: header.pcaItemCode ?? '',
              pcaJustification: header.pcaJustification ?? '',
            }}
            errors={errors}
            currentYear={currentYear}
            onChange={(field, value) => {
              if (field === 'pcaYear') onChange('pcaYear', value === '' ? null : Number(value));
              else onChange(field, value === '' ? null : value);
            }}
          />
        </fieldset>
      </div>
      {notesSection === null ? null : (
        <DfdSectionField
          section={notesSection}
          value={notes}
          editable={editable}
          onChange={onSectionChange}
        />
      )}
    </div>
  );
}

/** Texto em reais → decimal com ponto (ou o texto, para o erro V-13 aparecer na validação). */
export function estimatedValueOf(text: string): string | null {
  if (text.trim() === '') return null;
  return toDecimalMoney(text) ?? text;
}
