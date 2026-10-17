'use client';

import type { CatalogType } from '@contrataflow/types';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Skeleton,
  cx,
  toast,
} from '@contrataflow/ui';
import { ITEM_KIND_LABELS, PROCESS_ITEM_MESSAGES } from '@contrataflow/validation';
import type { ProcessItemDto, ProcessItemReference } from '@contrataflow/validation';
import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { DragEvent } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useShellSession } from '@/lib/session/session-context';

import { ProcessItemForm } from './process-item-form';
import {
  groupByLot,
  hasItemsWithoutLot,
  inUseReferencesOf,
  itemKindsOf,
  moveItem,
  moveTo,
  sequenceGaps,
} from './process-items-model';
import { deleteProcessItem, reorderProcessItems, useProcessItems } from './process-items.api';
import { useAvailableActions } from '../process-actions/process-actions.api';
import { useInvalidateProcess } from '../process-panel/process-panel.api';
import {
  WIZARD_CATALOG_STALE_TIME_MS,
  fetchActiveCatalog,
  fetchProcess,
  processKeys,
} from '../processes/processes.api';

type FormTarget = { readonly mode: 'add' } | { readonly mode: 'edit'; readonly itemId: string };

function useActiveCatalog(type: CatalogType) {
  const session = useShellSession();
  return useQuery({
    queryKey: processKeys.activeCatalog(session.activeTenant.id, type),
    queryFn: ({ signal }) => fetchActiveCatalog(type, signal),
    staleTime: WIZARD_CATALOG_STALE_TIME_MS,
    throwOnError: false,
  });
}

const quantityFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 4 });
const priceFormat = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** `ReferenceValueCell`: valor do documento de origem (somente leitura) ou "Sigiloso" (POL-09). */
function ReferenceValueCell({
  value,
  masked,
  sourceDocumentId,
  format,
}: {
  readonly value: string | null;
  readonly masked: boolean;
  readonly sourceDocumentId: string | null;
  readonly format: Intl.NumberFormat;
}) {
  const t = useTranslations('processItems.reference');
  if (masked) {
    return (
      <span title={t('confidentialHint')} className="text-muted-foreground">
        {t('confidential')}
      </span>
    );
  }
  if (value === null) return <span className="text-muted-foreground">{t('none')}</span>;
  return (
    <span title={sourceDocumentId === null ? undefined : t('fromDocument')}>
      {format.format(Number(value))}
    </span>
  );
}

/** Documento com link (FA-01): "DFD 0005/2026 (Rascunho)". */
function ReferenceLink({
  processId,
  reference,
}: {
  readonly processId: string;
  readonly reference: ProcessItemReference;
}) {
  const t = useTranslations('processItems');
  return (
    <Link
      href={`/processos/${processId}/documentos/${reference.documentId}`}
      className="text-primary underline"
    >
      {reference.code} ({t(`documentStatuses.${reference.status}` as 'documentStatuses.DRAFT')})
    </Link>
  );
}

/**
 * SCR-006 · aba "Itens" (US-006): lista canônica de itens agrupada por lote, com inclusão, edição,
 * exclusão (FA-01 com os documentos que usam o item), reordenação acessível ("Mover para cima/
 * baixo", arrastar e soltar, anúncio por `aria-live`) e "Renumerar" das lacunas (FA-02). Em modo
 * leitura com o motivo do motor (PRC-08 `MANAGE_ITEMS` — FA-07); 412 recarrega a lista (FA-08).
 * Abaixo de 768 px, cada item vira um cartão e a reordenação é por botões.
 */
export function ProcessItemsTab({ processId }: { readonly processId: string }) {
  const t = useTranslations('processItems');
  const list = useProcessItems(processId);
  const actions = useAvailableActions(processId);
  const invalidate = useInvalidateProcess(processId);
  const session = useShellSession();
  const detail = useQuery({
    queryKey: processKeys.detail(session.activeTenant.id, processId),
    queryFn: ({ signal }) => fetchProcess(processId, signal),
    throwOnError: false,
  });
  const contractingTypes = useActiveCatalog('CONTRACTING_TYPE');
  const [form, setForm] = useState<FormTarget | null>(null);
  const [order, setOrder] = useState<readonly string[] | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [removing, setRemoving] = useState<ProcessItemDto | null>(null);
  const [inUse, setInUse] = useState<{
    readonly item: ProcessItemDto;
    readonly references: readonly ProcessItemReference[];
  } | null>(null);
  const [stale, setStale] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);

  const manage = actions.data?.find((entry) => entry.action === 'MANAGE_ITEMS');
  const canEdit = manage?.enabled === true;
  const readOnlyReason =
    manage !== undefined && !manage.enabled ? manage.reasons[0]?.message : null;
  const contractingType = contractingTypes.data?.find(
    (type) => type.id === detail.data?.contractingType.id,
  );
  const itemKinds = itemKindsOf(contractingType?.metadata);

  const handleError = (error: unknown) => {
    if (isApiError(error) && error.status === 412) {
      setStale(true);
      setOrder(null);
      void invalidate();
      return;
    }
    if (isApiError(error) && (error.status === 403 || error.status === 409)) {
      toast({ title: error.problem?.detail ?? error.message, tone: 'error' });
      void invalidate();
      return;
    }
    if (isApiError(error) && error.status === 422) {
      // Ordem que não corresponde aos itens atuais (V-08): recarrega a lista.
      toast({ title: PROCESS_ITEM_MESSAGES.invalidOrder, tone: 'error' });
      setOrder(null);
      void invalidate();
      return;
    }
    toast({ title: t('errors.unavailable'), tone: 'error' });
  };

  const remove = useMutation({
    mutationFn: (item: ProcessItemDto) => deleteProcessItem(item.id, item.version),
    onSuccess: async () => {
      setRemoving(null);
      toast({ title: t('toast.removed'), tone: 'success' });
      await invalidate();
    },
    onError: (error: unknown, item) => {
      setRemoving(null);
      if (isApiError(error) && error.code === 'ITEM_IN_USE') {
        setInUse({ item, references: inUseReferencesOf(error) });
        return;
      }
      handleError(error);
    },
  });

  const reorder = useMutation({
    mutationFn: (input: { readonly itemIds: readonly string[]; readonly version: number }) =>
      reorderProcessItems(processId, input.itemIds, input.version),
    onSuccess: async () => {
      setOrder(null);
      toast({ title: t('toast.reordered'), tone: 'success' });
      await invalidate();
    },
    onError: handleError,
  });

  if (list.data === undefined) {
    if (list.isPending) {
      return (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      );
    }
    return (
      <Alert tone="error" title={t('errors.load')}>
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={() => {
            void list.refetch();
          }}
        >
          {t('errors.retry')}
        </Button>
      </Alert>
    );
  }

  const { items, processVersion } = list.data;
  const byId = new Map(items.map((item) => [item.id, item]));
  const serverOrder = items.map((item) => item.id);
  const currentOrder = (order ?? serverOrder).filter((id) => byId.has(id));
  const ordered = currentOrder.flatMap((id) => byId.get(id) ?? []);
  const gaps = sequenceGaps(items);
  const editing = form?.mode === 'edit' ? (byId.get(form.itemId) ?? null) : null;

  const move = (id: string, delta: number) => {
    const index = currentOrder.indexOf(id);
    const next = moveItem(currentOrder, index, delta);
    setOrder(next);
    const item = byId.get(id);
    if (item) {
      setAnnouncement(
        t('announce.moved', { sequence: item.sequence, position: next.indexOf(id) + 1 }),
      );
    }
  };
  const onDrop = (event: DragEvent, overId: string) => {
    event.preventDefault();
    if (dragging === null) return;
    const next = moveTo(currentOrder, dragging, overId);
    setOrder(next);
    const item = byId.get(dragging);
    if (item) {
      setAnnouncement(
        t('announce.moved', { sequence: item.sequence, position: next.indexOf(dragging) + 1 }),
      );
    }
    setDragging(null);
  };

  const renderRow = (item: ProcessItemDto) => {
    const position = currentOrder.indexOf(item.id);
    return (
      <tr
        key={item.id}
        className={cx(
          'grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-b border-border p-3 md:table-row md:p-0',
          dragging === item.id && 'opacity-50',
        )}
        draggable={canEdit}
        onDragStart={() => {
          setDragging(item.id);
        }}
        onDragOver={(event) => {
          if (canEdit) event.preventDefault();
        }}
        onDrop={(event) => {
          onDrop(event, item.id);
        }}
      >
        <td className="row-span-2 font-medium md:table-cell md:px-3 md:py-2">{item.sequence}</td>
        <td className="min-w-0 md:table-cell md:px-3 md:py-2">
          <span className="block break-words">{item.description}</span>
          {item.catalogCode !== null ? (
            <span className="text-xs text-muted-foreground md:hidden">
              {item.catalogSystem} {item.catalogCode}
            </span>
          ) : null}
        </td>
        <td className="col-start-2 text-sm text-muted-foreground md:table-cell md:px-3 md:py-2 md:text-foreground">
          {ITEM_KIND_LABELS[item.kind]} · {item.unitOfMeasure.label}
        </td>
        <td className="hidden md:table-cell md:px-3 md:py-2">
          {item.catalogCode === null ? '—' : `${item.catalogSystem ?? ''} ${item.catalogCode}`}
        </td>
        <td className="col-start-2 text-sm md:table-cell md:px-3 md:py-2">
          <span className="md:hidden">{t('columns.quantity')}: </span>
          <ReferenceValueCell
            value={item.referenceQuantity}
            masked={false}
            sourceDocumentId={item.referenceQuantitySourceDocumentId}
            format={quantityFormat}
          />
        </td>
        <td className="col-start-2 text-sm md:table-cell md:px-3 md:py-2">
          <span className="md:hidden">{t('columns.price')}: </span>
          <ReferenceValueCell
            value={item.referenceUnitPrice}
            masked={item.referenceUnitPriceMasked}
            sourceDocumentId={item.referenceUnitPriceSourceDocumentId}
            format={priceFormat}
          />
        </td>
        {canEdit ? (
          <td className="col-span-2 md:table-cell md:px-3 md:py-2">
            <div
              role="group"
              aria-label={t('actions.itemActions', { sequence: item.sequence })}
              className="flex flex-wrap gap-1"
            >
              <Button
                size="sm"
                variant="ghost"
                aria-label={`${t('actions.moveUp')} — ${String(item.sequence)}`}
                disabled={position <= 0}
                onClick={() => {
                  move(item.id, -1);
                }}
              >
                ↑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`${t('actions.moveDown')} — ${String(item.sequence)}`}
                disabled={position >= currentOrder.length - 1}
                onClick={() => {
                  move(item.id, 1);
                }}
              >
                ↓
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setForm({ mode: 'edit', itemId: item.id });
                }}
              >
                {t('actions.edit')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setRemoving(item);
                }}
              >
                {t('actions.remove')}
              </Button>
            </div>
          </td>
        ) : null}
      </tr>
    );
  };

  const head = (
    <thead className="hidden text-left text-sm text-muted-foreground md:table-header-group">
      <tr>
        <th scope="col" className="px-3 py-2">
          {t('columns.sequence')}
        </th>
        <th scope="col" className="px-3 py-2">
          {t('columns.description')}
        </th>
        <th scope="col" className="px-3 py-2">
          {t('columns.kind')} · {t('columns.unit')}
        </th>
        <th scope="col" className="px-3 py-2">
          {t('columns.catalog')}
        </th>
        <th scope="col" className="px-3 py-2">
          {t('columns.quantity')}
        </th>
        <th scope="col" className="px-3 py-2">
          {t('columns.price')}
        </th>
        {canEdit ? (
          <th scope="col" className="px-3 py-2">
            {t('columns.actions')}
          </th>
        ) : null}
      </tr>
    </thead>
  );
  const columns = canEdit ? 7 : 6;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      {readOnlyReason ? <Alert tone="info" title={readOnlyReason} /> : null}
      {stale ? (
        <Alert tone="warning" title={PROCESS_ITEM_MESSAGES.stale}>
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() => {
              setStale(false);
            }}
          >
            OK
          </Button>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('count', { count: items.length })}</p>
        {canEdit ? (
          <Button
            onClick={() => {
              setForm({ mode: 'add' });
            }}
          >
            {t('add')}
          </Button>
        ) : null}
      </div>
      {gaps !== null && order === null ? (
        <Alert tone="info" title={t('gaps.message', { sequences: gaps.join(', ') })}>
          {canEdit ? (
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              disabled={reorder.isPending}
              onClick={() => {
                reorder.mutate({ itemIds: serverOrder, version: processVersion });
              }}
            >
              {t('gaps.renumber')}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {hasItemsWithoutLot(items) ? (
        <p className="text-sm text-muted-foreground">{t('itemsWithoutLot')}</p>
      ) : null}
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : order !== null ? (
        <>
          {/* SortableItemsList: ordem local até "Salvar ordem" (PRC-17 com o ETag da lista). */}
          <table className="block w-full md:table">
            {head}
            <tbody className="block md:table-row-group">{ordered.map(renderRow)}</tbody>
          </table>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={reorder.isPending}
              onClick={() => {
                reorder.mutate({ itemIds: currentOrder, version: processVersion });
              }}
            >
              {t('actions.saveOrder')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setOrder(null);
              }}
            >
              {t('actions.cancelOrder')}
            </Button>
          </div>
        </>
      ) : (
        <table className="block w-full md:table">
          {head}
          {groupByLot(items).map((group) => (
            <tbody key={group.lotNumber ?? 'none'} className="block md:table-row-group">
              <tr className="block md:table-row">
                <th
                  scope="colgroup"
                  colSpan={columns}
                  className="block bg-muted px-3 py-2 text-left text-sm font-medium md:table-cell"
                >
                  {group.lotNumber === null
                    ? t('noLot')
                    : group.lotName === null
                      ? t('lot', { number: group.lotNumber })
                      : t('lotNamed', { number: group.lotNumber, name: group.lotName })}
                </th>
              </tr>
              {group.items.map(renderRow)}
            </tbody>
          ))}
        </table>
      )}
      <ProcessItemForm
        processId={processId}
        item={editing}
        open={form !== null}
        onOpenChange={(open) => {
          if (!open) setForm(null);
        }}
        itemKinds={itemKinds}
        contractingTypeLabel={contractingType?.label ?? ''}
        onChanged={invalidate}
      />
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <DialogContent closeLabel={null}>
          <DialogTitle>{t('remove.title', { sequence: removing?.sequence ?? 0 })}</DialogTitle>
          <DialogDescription>{t('remove.description')}</DialogDescription>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setRemoving(null);
              }}
            >
              {t('remove.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => {
                if (removing) remove.mutate(removing);
              }}
            >
              {t('remove.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={inUse !== null}
        onOpenChange={(open) => {
          if (!open) setInUse(null);
        }}
      >
        <DialogContent closeLabel={null}>
          {/* ItemInUseDialog (FA-01). */}
          <DialogTitle>{t('inUse.title')}</DialogTitle>
          <DialogDescription>{PROCESS_ITEM_MESSAGES.inUse}</DialogDescription>
          <ul className="flex flex-col gap-1 text-sm">
            {(inUse?.references ?? []).map((reference) => (
              <li key={reference.documentId}>
                <ReferenceLink processId={processId} reference={reference} />
                {reference.editable ? null : (
                  <span className="block text-muted-foreground">
                    {t('inUse.reopen', {
                      document: reference.code,
                      status: t(
                        `documentStatusesInline.${reference.status}` as 'documentStatusesInline.APPROVED',
                      ),
                    })}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button
              onClick={() => {
                setInUse(null);
              }}
            >
              {t('inUse.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
