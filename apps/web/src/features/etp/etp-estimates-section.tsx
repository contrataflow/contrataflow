'use client';

import {
  Alert,
  Button,
  Field,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableContainer,
  TableHead,
  Td,
  Textarea,
  Th,
  Tr,
} from '@contrataflow/ui';
import { ETP_ESTIMATE_MESSAGES } from '@contrataflow/validation';
import type { DocumentItemDto, EtpDetailDto } from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { CorrelationCode } from '@/components/errors/correlation-code';
import { useTenantId } from '@/lib/session/session-context';

import {
  estimateConflictRows,
  estimateDraftsOf,
  estimateFieldErrorsOf,
  estimateItemsBody,
  estimateProblemOf,
  estimateRowProblems,
  estimatesDirty,
  estimateValueBody,
  estimateValueFormOf,
  estimateValueStatus,
  memoFits,
} from './etp-estimates-model';
import type {
  EstimateProblem,
  EstimateRowDraft,
  EstimateValueForm,
  EstimateValueStatus,
} from './etp-estimates-model';
import { etpKeys, patchEtp, useEtp } from './etp.api';
import {
  dfdKeys,
  fetchDocumentItems,
  replaceDocumentItems,
  useDocumentItems,
} from '../dfd/dfd.api';
import type { DocumentItemList } from '../dfd/dfd.api';
import { priceResearchHref, useProcessPriceResearch } from '../price-research/price-research.api';
import { formatMoneyText } from '../processes/money';
import { MoneyInput } from '../processes/money-input';

/*
 * Seção "Estimativas" do ETP (US-022 · SCR-008): `ItemsEstimateTable` — quantidade e memória de
 * cálculo por item, salvos pelo DOC-07 com `If-Match` da versão do documento (V-01/V-02 na tela,
 * FA-06: a memória para de aceitar texto em 1 MB; 412 oferece "Ver diferenças" e "Recarregar") — e
 * `EstimatedValuePanel` — origem do valor (manual ou vinculado à pesquisa de preços do processo,
 * PRS-01) pelo ETP-04 com `If-Match` da versão do ETP; vinculado, o valor é somente leitura, com
 * "Ver pesquisa de preços", e é revalidado a cada 5 s para refletir a sincronização do worker
 * (RN-ETP-29 — anúncio em `aria-live`). FA-03 "Aguardando cálculo…", FA-04 "Valor desatualizado…",
 * FA-05 valor sigiloso. Sem `editable` (sem ETP_UPDATE + POL-02 ou fora de DRAFT/RETURNED): tudo
 * somente leitura. Em telas < 768 px cada item vira um cartão empilhado.
 */

/** Revalidação do ETP com o valor vinculado (meta de 5 s da story · "Acessibilidade/performance"). */
const LINKED_REFRESH_MS = 5_000;

const BRL = (decimal: string) => `R$ ${formatMoneyText(decimal)}`;

const timeOf = (date: Date) =>
  new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(date);

function ProblemAlert({
  problem,
  onRetry,
}: {
  readonly problem: EstimateProblem | null;
  readonly onRetry?: () => void;
}) {
  const t = useTranslations('etp.estimates.errors');
  const tErrors = useTranslations('errors.correlation');
  if (problem === null || problem.kind === 'conflict') return null;
  if (problem.kind === 'unexpected') {
    return (
      <Alert tone="error" title={t('unexpected')}>
        <CorrelationCode
          correlationId={problem.correlationId}
          labels={{
            code: tErrors('label', { correlationId: problem.correlationId }),
            copy: tErrors('copy'),
            copied: tErrors('copied'),
          }}
        />
      </Alert>
    );
  }
  const title = problem.kind === 'detail' ? problem.message : t(problem.key);
  return (
    <Alert tone="error" title={title}>
      {problem.kind === 'message' && problem.key === 'unavailable' && onRetry ? (
        <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={onRetry}>
          {t('retry')}
        </Button>
      ) : null}
    </Alert>
  );
}

// --- Itens --------------------------------------------------------------------------------------

function ItemsEstimateTable({
  documentId,
  list,
  savedAt,
  onSaved,
}: {
  readonly documentId: string;
  readonly list: DocumentItemList;
  /** Fora da tabela: a nova versão do documento a remonta (o rascunho parte da coleção salva). */
  readonly savedAt: Date | null;
  readonly onSaved: (at: Date) => void;
}) {
  const t = useTranslations('etp.estimates.items');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const id = useId();
  const [drafts, setDrafts] = useState<Record<string, EstimateRowDraft>>(() =>
    estimateDraftsOf(list.items),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [memoFull, setMemoFull] = useState<string | null>(null);
  const [problem, setProblem] = useState<EstimateProblem | null>(null);
  const [conflict, setConflict] = useState<readonly DocumentItemDto[] | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      replaceDocumentItems(documentId, estimateItemsBody(list.items, drafts), list.documentVersion),
    onSuccess: (saved) => {
      queryClient.setQueryData(dfdKeys.items(tenantId, documentId), saved);
      setDrafts(estimateDraftsOf(saved.items));
      onSaved(new Date());
      setProblem(null);
      setConflict(null);
    },
    onError: async (error) => {
      const next = estimateProblemOf(error);
      setProblem(next);
      setErrors(estimateFieldErrorsOf(list.items, error));
      if (next.kind === 'conflict') {
        setShowDiff(false);
        setConflict((await fetchDocumentItems(documentId).catch(() => null))?.items ?? []);
      }
    },
  });

  const reload = () => {
    setConflict(null);
    setProblem(null);
    void queryClient
      .invalidateQueries({ queryKey: dfdKeys.items(tenantId, documentId) })
      .then(() => {
        const fresh = queryClient.getQueryData<DocumentItemList>(
          dfdKeys.items(tenantId, documentId),
        );
        if (fresh) setDrafts(estimateDraftsOf(fresh.items));
      });
  };

  const submit = () => {
    const problems = estimateRowProblems(list.items, drafts);
    setErrors(problems);
    const first = list.items.find((item) => problems[item.processItemId] !== undefined);
    if (first !== undefined) {
      document.getElementById(`${id}-${first.processItemId}-quantity`)?.focus();
      return;
    }
    save.mutate();
  };

  const set = (processItemId: string, patch: Partial<EstimateRowDraft>) => {
    setDrafts((current) => {
      const base = current[processItemId] ?? { quantity: '', memo: '' };
      return { ...current, [processItemId]: { ...base, ...patch } };
    });
  };

  if (list.items.length === 0) return <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  const dirty = estimatesDirty(list.items, drafts);
  const diff = conflict === null ? [] : estimateConflictRows(list.items, drafts, conflict);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ul aria-label={t('caption')} className="flex flex-col gap-3">
        {list.items.map((item) => {
          const draft = drafts[item.processItemId] ?? { quantity: '', memo: '' };
          const quantityId = `${id}-${item.processItemId}-quantity`;
          const memoId = `${id}-${item.processItemId}-memo`;
          const error = errors[item.processItemId];
          return (
            <li
              key={item.processItemId}
              className="grid min-w-0 gap-3 rounded-card bg-muted p-4 md:grid-cols-[minmax(0,1fr)_10rem]"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-sm font-medium break-words">
                  {t('sequence', { sequence: item.sequence })} — {item.description}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('unit', { unit: item.unit.label })}
                </span>
              </div>
              <Field
                id={quantityId}
                label={t('quantity')}
                required
                requiredMark=""
                error={error === undefined ? undefined : <span role="alert">{error}</span>}
              >
                <Input
                  inputMode="decimal"
                  autoComplete="off"
                  className="text-right tabular-nums"
                  value={draft.quantity}
                  onChange={(event) => {
                    set(item.processItemId, { quantity: event.target.value });
                  }}
                />
              </Field>
              <div className="flex min-w-0 flex-col gap-1 md:col-span-2">
                <Field
                  id={memoId}
                  label={t('memo')}
                  description={memoFull === item.processItemId ? t('memoTooLarge') : t('memoHint')}
                >
                  <Textarea
                    value={draft.memo}
                    onChange={(event) => {
                      const text = event.target.value;
                      // FA-06: acima de 1 MB, novos caracteres não entram.
                      if (text.length > draft.memo.length && !memoFits(text)) {
                        setMemoFull(item.processItemId);
                        return;
                      }
                      setMemoFull(null);
                      set(item.processItemId, { memo: text });
                    }}
                  />
                </Field>
              </div>
            </li>
          );
        })}
      </ul>

      {problem?.kind === 'conflict' ? (
        <Alert tone="warning" title={t('conflict')}>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              aria-expanded={showDiff}
              onClick={() => {
                setShowDiff((current) => !current);
              }}
            >
              {showDiff ? t('hideDiff') : t('showDiff')}
            </Button>
            <Button type="button" size="sm" onClick={reload}>
              {t('reload')}
            </Button>
          </div>
          {showDiff ? (
            diff.length === 0 ? (
              <p className="mt-2 text-sm">{t('diffEmpty')}</p>
            ) : (
              <TableContainer label={t('showDiff')} className="mt-2">
                <Table>
                  <caption className="sr-only">{t('showDiff')}</caption>
                  <TableHead>
                    <Tr>
                      <Th>{t('diffItem')}</Th>
                      <Th>{t('diffMine')}</Th>
                      <Th>{t('diffServer')}</Th>
                    </Tr>
                  </TableHead>
                  <TableBody>
                    {diff.map((row) => (
                      <Tr key={row.sequence}>
                        <Td>{row.sequence}</Td>
                        <Td className="tabular-nums">{row.mine}</Td>
                        <Td className="tabular-nums">{row.server}</Td>
                      </Tr>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )
          ) : null}
        </Alert>
      ) : null}
      <ProblemAlert
        problem={problem}
        onRetry={() => {
          save.mutate();
        }}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={submit} disabled={save.isPending}>
          {save.isPending ? t('saving') : t('save')}
        </Button>
        <span role="status" className="text-xs text-muted-foreground">
          {save.isPending
            ? t('saving')
            : dirty
              ? t('dirty')
              : savedAt === null
                ? ''
                : t('saved', { time: timeOf(savedAt) })}
        </span>
      </div>
    </div>
  );
}

function EstimateItems({
  documentId,
  editable,
  readOnlyItems,
}: {
  readonly documentId: string;
  readonly editable: boolean;
  readonly readOnlyItems: ReactNode;
}) {
  const t = useTranslations('etp.estimates.items');
  const items = useDocumentItems(documentId);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  if (!editable) return readOnlyItems;
  if (items.isPending) return <Skeleton className="h-24 w-full" />;
  if (items.isError) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
        <span>{t('loadError')}</span>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            void items.refetch();
          }}
        >
          {t('retry')}
        </Button>
      </div>
    );
  }
  // A versão do documento remonta a tabela: o rascunho parte sempre da coleção salva.
  return (
    <ItemsEstimateTable
      key={String(items.data.documentVersion)}
      documentId={documentId}
      list={items.data}
      savedAt={savedAt}
      onSaved={setSavedAt}
    />
  );
}

// --- Valor estimado -----------------------------------------------------------------------------

function ValueStatus({
  status,
  processId,
  priceResearchId,
}: {
  readonly status: EstimateValueStatus;
  readonly processId: string;
  readonly priceResearchId: string | null;
}) {
  const t = useTranslations('etp.estimates.value');
  return (
    <div aria-live="polite" className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-muted-foreground">{t('current')}</span>
      {status.kind === 'masked' ? <span className="font-semibold">{t('masked')}</span> : null}
      {status.kind === 'undefined' ? (
        <span className="text-sm text-muted-foreground">{t('notDefined')}</span>
      ) : null}
      {status.kind === 'awaiting' ? (
        <span className="text-sm font-medium">{ETP_ESTIMATE_MESSAGES.awaitingCalculation}</span>
      ) : null}
      {status.kind === 'manual' || status.kind === 'linked' || status.kind === 'stale' ? (
        <span className="text-lg font-semibold tabular-nums">{BRL(status.value)}</span>
      ) : null}
      {status.kind === 'stale' ? (
        <Alert tone="warning" title={ETP_ESTIMATE_MESSAGES.stale} live={false} />
      ) : null}
      {status.kind === 'linked' || status.kind === 'awaiting' ? (
        <span className="text-xs text-muted-foreground">{t('linked')}</span>
      ) : null}
      {priceResearchId !== null ? (
        <Link
          href={priceResearchHref(processId, priceResearchId)}
          className="text-sm text-primary underline"
        >
          {t('viewResearch')}
        </Link>
      ) : null}
    </div>
  );
}

function EstimatedValuePanel({
  etp,
  processId,
  editable,
  savedAt,
  onSaved,
}: {
  readonly etp: EtpDetailDto;
  readonly processId: string;
  readonly editable: boolean;
  /** Fora do painel: a nova versão do ETP o remonta (o formulário parte do valor salvo). */
  readonly savedAt: Date | null;
  readonly onSaved: (at: Date) => void;
}) {
  const t = useTranslations('etp.estimates.value');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const id = useId();
  const researches = useProcessPriceResearch(processId, editable);
  const options = (researches.data ?? []).filter((research) => research.status !== 'CANCELED');
  const [form, setForm] = useState<EstimateValueForm>(() =>
    estimateValueFormOf(etp, options[0]?.id ?? null),
  );
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [problem, setProblem] = useState<EstimateProblem | null>(null);

  // A lista de pesquisas chega depois: sem escolha, a única não cancelada é a sugestão do vínculo.
  const suggested = options[0]?.id ?? '';
  const researchId = form.priceResearchId === '' ? suggested : form.priceResearchId;

  const save = useMutation({
    mutationFn: (body: Parameters<typeof patchEtp>[1]) => patchEtp(etp.id, body, etp.version),
    onSuccess: (result) => {
      queryClient.setQueryData(etpKeys.detail(tenantId, etp.id), result);
      onSaved(new Date());
      setProblem(null);
      setFieldError(null);
    },
    onError: (error) => {
      setProblem(estimateProblemOf(error));
    },
  });

  const submit = () => {
    const check = estimateValueBody({ ...form, priceResearchId: researchId });
    if (!check.ok) {
      setFieldError({ field: check.field, message: check.message });
      document.getElementById(`${id}-${check.field}`)?.focus();
      return;
    }
    setFieldError(null);
    save.mutate(check.body);
  };

  const status = estimateValueStatus(etp);
  const view = (
    <ValueStatus
      status={status}
      processId={processId}
      priceResearchId={etp.estimatedValueSource === 'PRICE_RESEARCH' ? etp.priceResearchId : null}
    />
  );
  if (!editable) return view;

  const errorOf = (field: string) => (fieldError?.field === field ? fieldError.message : undefined);
  const sourceError = errorOf('source');
  const moneyError = errorOf('money');
  const researchError = errorOf('priceResearchId');

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {view}
      <Field
        group
        id={`${id}-source`}
        label={t('sourceLegend')}
        error={sourceError === undefined ? undefined : <span role="alert">{sourceError}</span>}
      >
        <RadioGroup
          id={`${id}-source`}
          value={form.source}
          onValueChange={(value) => {
            const source = value === 'PRICE_RESEARCH' ? 'PRICE_RESEARCH' : 'MANUAL';
            setFieldError(null);
            // FA-02: ao voltar ao manual, o último valor fica como ponto de partida.
            setForm((current) => ({
              ...current,
              source,
              money:
                current.money === '' && etp.estimatedTotalValue !== null
                  ? formatMoneyText(etp.estimatedTotalValue)
                  : current.money,
            }));
          }}
        >
          {(['MANUAL', 'PRICE_RESEARCH'] as const).map((source) => (
            <div key={source} className="flex items-center gap-2">
              <RadioGroupItem id={`${id}-source-${source}`} value={source} />
              <Label htmlFor={`${id}-source-${source}`} className="font-normal">
                {source === 'MANUAL' ? t('manual') : t('research')}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </Field>

      {form.source === 'MANUAL' ? (
        <div className="flex min-w-0 flex-col gap-1 md:max-w-xs">
          <label htmlFor={`${id}-money`} className="text-sm font-medium">
            {t('valueLabel')}
          </label>
          <MoneyInput
            id={`${id}-money`}
            value={form.money}
            aria-invalid={moneyError === undefined ? undefined : true}
            aria-describedby={moneyError === undefined ? undefined : `${id}-money-error`}
            onValueChange={(money) => {
              setForm((current) => ({ ...current, money }));
            }}
          />
          {moneyError === undefined ? null : (
            <p id={`${id}-money-error`} role="alert" className="text-xs text-destructive">
              {moneyError}
            </p>
          )}
        </div>
      ) : null}

      {form.source === 'PRICE_RESEARCH' ? (
        options.length === 0 && !researches.isPending ? (
          <p className="text-sm text-muted-foreground">{t('noResearch')}</p>
        ) : (
          <Field
            id={`${id}-priceResearchId`}
            label={t('researchLabel')}
            className="md:max-w-sm"
            error={
              researchError === undefined ? undefined : <span role="alert">{researchError}</span>
            }
          >
            <Select
              value={researchId}
              onValueChange={(value) => {
                setForm((current) => ({ ...current, priceResearchId: value }));
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('researchPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {options.map((research) => (
                  <SelectItem key={research.id} value={research.id}>
                    {t('researchOption', {
                      code: research.code ?? research.title,
                      status: research.status,
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )
      ) : null}

      {problem?.kind === 'conflict' ? (
        <Alert tone="warning" title={ETP_ESTIMATE_MESSAGES.versionConflict}>
          <Button
            type="button"
            size="sm"
            className="mt-2"
            onClick={() => {
              setProblem(null);
              void queryClient.invalidateQueries({ queryKey: etpKeys.detail(tenantId, etp.id) });
            }}
          >
            {t('reload')}
          </Button>
        </Alert>
      ) : null}
      <ProblemAlert problem={problem} />

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={submit} disabled={save.isPending}>
          {save.isPending ? t('saving') : t('save')}
        </Button>
        <span role="status" className="text-xs text-muted-foreground">
          {savedAt === null ? '' : t('saved', { time: timeOf(savedAt) })}
        </span>
      </div>
    </div>
  );
}

/**
 * Seção "Estimativas" (o id do ETP é o do documento — CHECK `etps_id_is_document`). Sem `editable`,
 * os itens vêm no quadro somente leitura recebido em `readOnlyItems`.
 */
export function EtpEstimatesSection({
  processId,
  documentId,
  editable,
  readOnlyItems,
}: {
  readonly processId: string;
  readonly documentId: string;
  readonly editable: boolean;
  readonly readOnlyItems: ReactNode;
}) {
  const t = useTranslations('etp.estimates');
  const linked = useEtp(documentId).data?.etp.estimatedValueSource === 'PRICE_RESEARCH';
  const etp = useEtp(documentId, { refetchInterval: linked ? LINKED_REFRESH_MS : false });
  const [valueSavedAt, setValueSavedAt] = useState<Date | null>(null);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section aria-label={t('items.title')} className="flex min-w-0 flex-col gap-2">
        <h4 className="text-sm font-semibold">{t('items.title')}</h4>
        <EstimateItems documentId={documentId} editable={editable} readOnlyItems={readOnlyItems} />
      </section>
      <section aria-label={t('value.title')} className="flex min-w-0 flex-col gap-2">
        <h4 className="text-sm font-semibold">{t('value.title')}</h4>
        {etp.data === undefined ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <EstimatedValuePanel
            key={String(etp.data.etp.version)}
            etp={etp.data.etp}
            processId={processId}
            editable={editable}
            savedAt={valueSavedAt}
            onSaved={setValueSavedAt}
          />
        )}
      </section>
    </div>
  );
}
