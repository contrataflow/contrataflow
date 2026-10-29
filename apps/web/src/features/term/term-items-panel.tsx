'use client';

import {
  Alert,
  Button,
  Checkbox,
  ChevronDown,
  ChevronUp,
  Field,
  Input,
  Label,
  Skeleton,
  Textarea,
} from '@contrataflow/ui';
import type { DocumentItemDto, ProcessItemDto, TermDetailDto } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useShellSession, useTenantId } from '@/lib/session/session-context';

import { TermCollapsiblePanel } from './term-collapsible-panel';
import {
  includedIds,
  moveItem,
  termItemFieldErrorsOf,
  termItemProblems,
  termItemRows,
  termItemsBody,
  termItemsDirty,
  termItemsStateOf,
} from './term-items-model';
import type { ItemRowDraft, TermItemsState } from './term-items-model';
import { termKeys } from './term.api';
import { dfdKeys, replaceDocumentItems, useDocumentItems } from '../dfd/dfd.api';
import type { DocumentItemList } from '../dfd/dfd.api';
import { itemKeys, useProcessItems } from '../process-items/process-items.api';

/*
 * `TermItemsPanel` (SCR-012 · US-038 · fluxo principal 1–4 · FA-01/03): o painel "Itens" do TR. Ao
 * abrir, combina os itens ativos do processo (PRC-13) com as linhas do TR (DOC-06), indicando as já
 * incluídas; cada linha tem "Incluir no TR", quantidade (pré-preenchida pela linha importada do ETP
 * ou pela quantidade de referência do item), especificação, critérios de aceitação e observações, e
 * a ordem muda por arrastar ou pelos botões (alternativa de teclado). "Salvar itens" substitui a
 * coleção pelo DOC-07 com o `If-Match` da versão do documento — sem versão nova (RN-TR-33). Somente
 * leitura sem permissão de edição. 412 oferece recarregar (a edição local fica para reaplicar).
 */

type Problem =
  { readonly kind: 'conflict' } | { readonly kind: 'message'; readonly message: string } | null;

export interface TermItemsPanelProps {
  readonly processId: string;
  readonly term: Pick<TermDetailDto, 'id' | 'documentId'>;
  readonly editable: boolean;
}

export function TermItemsPanel({ processId, term, editable }: TermItemsPanelProps) {
  const t = useTranslations('term.items');
  return (
    <TermCollapsiblePanel panel="items" title={t('title')}>
      <TermItemsContent processId={processId} term={term} editable={editable} />
    </TermCollapsiblePanel>
  );
}

function TermItemsContent({ processId, term, editable }: TermItemsPanelProps) {
  const t = useTranslations('term.items');
  const processItems = useProcessItems(processId);
  const documentItems = useDocumentItems(term.documentId);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  if (processItems.data === undefined || documentItems.data === undefined) {
    if (processItems.isPending || documentItems.isPending) {
      return (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      );
    }
    return (
      <Alert tone="error" title={t('loadError')}>
        <div className="mt-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void processItems.refetch();
              void documentItems.refetch();
            }}
          >
            {t('retry')}
          </Button>
        </div>
      </Alert>
    );
  }
  if (processItems.data.items.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  }
  return (
    <TermItemsEditor
      // A coleção salva (nova versão do documento) remonta o editor com o rascunho do servidor.
      key={documentItems.data.documentVersion}
      processId={processId}
      term={term}
      editable={editable}
      processItems={processItems.data.items}
      list={documentItems.data}
      savedAt={savedAt}
      onSaved={setSavedAt}
      onReload={() => {
        void processItems.refetch();
        void documentItems.refetch();
      }}
    />
  );
}

interface TermItemsEditorProps extends TermItemsPanelProps {
  readonly processItems: readonly ProcessItemDto[];
  readonly list: DocumentItemList;
  readonly savedAt: Date | null;
  readonly onSaved: (at: Date) => void;
  readonly onReload: () => void;
}

function TermItemsEditor({
  processId,
  term,
  editable,
  processItems,
  list,
  savedAt,
  onSaved,
  onReload,
}: TermItemsEditorProps) {
  const t = useTranslations('term.items');
  const tenantId = useTenantId();
  const session = useShellSession();
  const queryClient = useQueryClient();
  const id = useId();
  const [state, setState] = useState<TermItemsState>(() =>
    termItemsStateOf(processItems, list.items),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<Problem>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  // A mensagem do painel para o erro do DOC-07 (Casos de erro da story).
  const problemOf = (error: unknown): Problem => {
    if (!isApiError(error)) return { kind: 'message', message: t('errors.unexpected') };
    if (error.code === 'VERSION_CONFLICT') return { kind: 'conflict' };
    if (error.code === 'DOCUMENT_NOT_EDITABLE') {
      return { kind: 'message', message: t('errors.notEditable') };
    }
    if (error.code === 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE') {
      return { kind: 'message', message: t('errors.stage') };
    }
    if (error.status === 403) return { kind: 'message', message: t('errors.permission') };
    if (error.code === 'RICH_TEXT_INVALID' || error.code === 'PAYLOAD_TOO_LARGE') {
      return { kind: 'message', message: t('errors.richText') };
    }
    if (error.status === 422) return { kind: 'message', message: t('errors.invalid') };
    if (error.code === 'DEPENDENCY_UNAVAILABLE' || error.status === 503) {
      return { kind: 'message', message: t('errors.unavailable') };
    }
    return {
      kind: 'message',
      message:
        error.correlationId === null
          ? t('errors.unexpected')
          : t('errors.unexpectedWithCode', { correlationId: error.correlationId }),
    };
  };

  const save = useMutation({
    mutationFn: () =>
      replaceDocumentItems(term.documentId, termItemsBody(state, list.items), list.documentVersion),
    onSuccess: (saved) => {
      setProblem(null);
      setErrors({});
      onSaved(new Date());
      queryClient.setQueryData(dfdKeys.items(tenantId, term.documentId), saved);
      // A versão do documento mudou (o `If-Match` dos itens) e o item passa a ter referência.
      void queryClient.invalidateQueries({ queryKey: termKeys.detail(tenantId, term.id) });
      void queryClient.invalidateQueries({ queryKey: itemKeys.list(tenantId, processId) });
    },
    onError: (error: unknown) => {
      setErrors(termItemFieldErrorsOf(state, error));
      setProblem(problemOf(error));
    },
  });

  const rows = termItemRows(state, processItems, list.items);
  const dirty = termItemsDirty(state, processItems, list.items);
  const count = includedIds(state).length;

  const set = (itemId: string, patch: Partial<ItemRowDraft>) => {
    setState((current) => {
      const base = current.drafts[itemId];
      if (base === undefined) return current;
      return { ...current, drafts: { ...current.drafts, [itemId]: { ...base, ...patch } } };
    });
    setErrors((current) => {
      if (current[itemId] === undefined) return current;
      const { [itemId]: _removed, ...rest } = current;
      return rest;
    });
  };
  const move = (itemId: string, delta: -1 | 1) => {
    setState((current) => ({ ...current, order: moveItem(current.order, itemId, delta) }));
  };
  const dropOn = (targetId: string) => {
    if (dragging === null || dragging === targetId) return;
    setState((current) => {
      const order = current.order.filter((candidate) => candidate !== dragging);
      order.splice(order.indexOf(targetId), 0, dragging);
      return { ...current, order };
    });
    setDragging(null);
  };
  const submit = () => {
    const problems = termItemProblems(state, list.items);
    setErrors(problems);
    const first = includedIds(state).find((itemId) => problems[itemId] !== undefined);
    if (first !== undefined) {
      setProblem({ kind: 'message', message: t('errors.invalid') });
      document.getElementById(`${id}-${first}-quantity`)?.focus();
      return;
    }
    setProblem(null);
    save.mutate();
  };

  const timeZone = session.activeTenant.timezone;
  const status = save.isPending
    ? t('saving')
    : dirty
      ? t('dirty')
      : savedAt === null
        ? ''
        : t('saved', {
            time: new Intl.DateTimeFormat('pt-BR', {
              hour: '2-digit',
              minute: '2-digit',
              timeZone,
            }).format(savedAt),
          });

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-sm text-muted-foreground">{editable ? t('hint') : t('readOnly')}</p>
      <p className="text-sm font-medium">{t('includedCount', { count })}</p>
      <ul aria-label={t('caption')} className="flex flex-col divide-y divide-border">
        {rows.map(({ item }, index) => {
          const draft = state.drafts[item.id];
          if (draft === undefined) return null;
          const rowId = `${id}-${item.id}`;
          const error = errors[item.id];
          const saved: DocumentItemDto | undefined = list.items.find(
            (line) => line.processItemId === item.id,
          );
          return (
            // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- arrastar é atalho de mouse; a alternativa de teclado são os botões ↑/↓ (FA-03)
            <li
              key={item.id}
              draggable={editable && draft.included}
              onDragStart={() => {
                setDragging(item.id);
              }}
              onDragOver={(event) => {
                if (dragging !== null) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                dropOn(item.id);
              }}
              onDragEnd={() => {
                setDragging(null);
              }}
              className="flex min-w-0 flex-col gap-3 py-4 first:pt-0 last:pb-0"
              data-testid={`term-item-${String(item.sequence)}`}
            >
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2 text-sm">
                  <Checkbox
                    id={`${rowId}-include`}
                    className="mt-0.5"
                    checked={draft.included}
                    disabled={!editable}
                    aria-describedby={`${rowId}-unit`}
                    onCheckedChange={(checked) => {
                      set(item.id, { included: checked === true });
                    }}
                  />
                  <Label htmlFor={`${rowId}-include`} className="min-w-0 break-words">
                    <span className="font-medium">
                      {t('item', { sequence: item.sequence, description: item.description })}
                    </span>
                    <span className="sr-only"> — {t('include')}</span>
                  </Label>
                </div>
                {editable && draft.included ? (
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      aria-label={t('moveUp', { sequence: item.sequence })}
                      disabled={index === 0}
                      onClick={() => {
                        move(item.id, -1);
                      }}
                    >
                      <ChevronUp className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      aria-label={t('moveDown', { sequence: item.sequence })}
                      disabled={index === rows.length - 1}
                      onClick={() => {
                        move(item.id, 1);
                      }}
                    >
                      <ChevronDown className="size-4" />
                    </Button>
                  </div>
                ) : null}
              </div>
              <span id={`${rowId}-unit`} className="text-xs text-muted-foreground">
                {t('unit', { unit: saved?.unit.label ?? item.unitOfMeasure.label })}
              </span>
              {draft.included ? (
                <div className="grid min-w-0 gap-3 md:grid-cols-[10rem_minmax(0,1fr)]">
                  <Field
                    id={`${rowId}-quantity`}
                    label={t('quantity')}
                    required
                    requiredMark=""
                    error={error}
                  >
                    <Input
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      className="text-right tabular-nums"
                      value={draft.quantity}
                      readOnly={!editable}
                      onChange={(event) => {
                        set(item.id, { quantity: event.target.value });
                      }}
                    />
                  </Field>
                  <TextField
                    id={`${rowId}-specification`}
                    label={t('specification')}
                    value={draft.specification}
                    editable={editable}
                    onChange={(value) => {
                      set(item.id, { specification: value });
                    }}
                  />
                  <TextField
                    id={`${rowId}-criteria`}
                    label={t('acceptanceCriteria')}
                    value={draft.acceptanceCriteria}
                    editable={editable}
                    className="md:col-start-2"
                    onChange={(value) => {
                      set(item.id, { acceptanceCriteria: value });
                    }}
                  />
                  <TextField
                    id={`${rowId}-notes`}
                    label={t('notes')}
                    value={draft.notes}
                    editable={editable}
                    className="md:col-start-2"
                    onChange={(value) => {
                      set(item.id, { notes: value });
                    }}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {problem === null ? null : problem.kind === 'conflict' ? (
        <Alert tone="warning" title={t('errors.conflict')}>
          <div className="mt-2">
            <Button type="button" size="sm" onClick={onReload}>
              {t('errors.reload')}
            </Button>
          </div>
        </Alert>
      ) : (
        <Alert tone="error" title={problem.message} />
      )}

      {editable ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={submit} disabled={save.isPending || !dirty}>
            {save.isPending ? t('saving') : t('save')}
          </Button>
          <span role="status" className="text-xs text-muted-foreground">
            {status}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  editable,
  className,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly editable: boolean;
  readonly className?: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Field id={id} label={label} className={className}>
      <Textarea
        value={value}
        readOnly={!editable}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </Field>
  );
}
