'use client';

import {
  Alert,
  BadgeCheck,
  Button,
  ChevronDown,
  ChevronUp,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Ellipsis,
  Input,
  Pencil,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SheetContent,
  Skeleton,
  Table,
  TableBody,
  TableContainer,
  TableHead,
  Td,
  Textarea,
  Th,
  Tr,
  Trash2,
  buttonClassName,
  toast,
} from '@contrataflow/ui';
import {
  ALTERNATIVE_DECISION_LABELS,
  alternativesComparison,
  ETP_ALTERNATIVE_LIMITS,
  ETP_ALTERNATIVE_MESSAGES,
  RISK_LEVEL_LABELS,
  RISK_LEVELS,
} from '@contrataflow/validation';
import type {
  AlternativeComparisonRow,
  AlternativeDecision,
  EtpAlternativeDto,
  RiskLevel,
} from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';

import { CorrelationCode } from '@/components/errors/correlation-code';
import { useTenantId } from '@/lib/session/session-context';

import {
  alternativeFormValuesOf,
  alternativePatchOf,
  alternativeProblemMessage,
  alternativeProblemOf,
  createAlternativeBodyOf,
  decisionMessageOf,
  movedOrder,
  validateAlternative,
} from './etp-alternatives-model';
import type {
  AlternativeFieldMessages,
  AlternativeFormValues,
  AlternativeProblem,
} from './etp-alternatives-model';
import {
  createEtpAlternative,
  decideEtpAlternative,
  deleteEtpAlternative,
  etpAlternativeKeys,
  updateEtpAlternative,
  useEtpAlternatives,
} from './etp-alternatives.api';
import { etpKeys } from './etp.api';
import { FormField } from '../processes/form-field';
import { formatMoneyText } from '../processes/money';
import { MoneyInput } from '../processes/money-input';

/*
 * Seção "Alternativas" do ETP (US-021 · SCR-008): o quadro comparativo (`AlternativesComparisonTable`
 * — nome, decisão, custo mascarado conforme POL-09 e risco; tabela com cabeçalhos associados e, em
 * telas < 768 px, lista de cartões), o `AlternativeFormDrawer` (criar/editar), o
 * `DecideAlternativeDialog` (recomendar/descartar/voltar à análise com justificativa, e o
 * `ReplaceRecommendedConfirm` quando já existe outra recomendada — FA-01) e a exclusão (a
 * recomendada pede antes a mudança da decisão — FA-03). Sem `meta.canManage` (sem ETP_UPDATE + POL-02
 * ou ETP fora de DRAFT/RETURNED — FA-05), a seção é somente leitura. A reordenação usa "Mover para
 * cima/baixo" (ETP-07 `sortOrder`), operável por teclado.
 */

const BRL = (decimal: string) => `R$ ${formatMoneyText(decimal)}`;

interface Decide {
  readonly alternative: EtpAlternativeDto;
  readonly decision: AlternativeDecision;
}

export function EtpAlternativesSection({ etpId }: { readonly etpId: string }) {
  const t = useTranslations('etp.alternatives');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const query = useEtpAlternatives(etpId);
  const [editing, setEditing] = useState<EtpAlternativeDto | 'new' | null>(null);
  const [deciding, setDeciding] = useState<Decide | null>(null);
  const [removing, setRemoving] = useState<EtpAlternativeDto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async () => {
    // Sob a chave do ETP: o cabeçalho (`recommendedAlternativeId`) acompanha.
    await queryClient.invalidateQueries({ queryKey: etpKeys.detail(tenantId, etpId) });
    await queryClient.invalidateQueries({ queryKey: etpAlternativeKeys.list(tenantId, etpId) });
  };

  const reorder = useMutation({
    mutationFn: async (input: { readonly id: string; readonly direction: -1 | 1 }) => {
      const rows = query.data?.alternatives ?? [];
      for (const change of movedOrder(rows, input.id, input.direction)) {
        const row = rows.find((candidate) => candidate.id === change.id);
        if (row) await updateEtpAlternative(row.id, { sortOrder: change.sortOrder }, row.version);
      }
    },
    onSettled: refresh,
    onError: (error: unknown) => {
      setNotice(alternativeProblemMessage(alternativeProblemOf(error)) ?? t('errors.unexpected'));
    },
  });

  if (query.isPending) return <Skeleton className="h-24 w-full" />;
  if (query.isError) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
        <span>{t('loadError')}</span>
        <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
          {t('retry')}
        </Button>
      </div>
    );
  }

  const { alternatives, meta } = query.data;
  const canManage = meta.canManage;
  const rows = alternativesComparison(alternatives);
  const byId = new Map(alternatives.map((alternative) => [alternative.id, alternative]));
  const masked = meta.estimatedCostMasked;
  const actions = {
    canManage,
    pending: reorder.isPending,
    onEdit: (alternative: EtpAlternativeDto) => {
      setEditing(alternative);
    },
    onDecide: (alternative: EtpAlternativeDto, decision: AlternativeDecision) => {
      setDeciding({ alternative, decision });
    },
    onRemove: (alternative: EtpAlternativeDto) => {
      setRemoving(alternative);
    },
    onMove: (alternative: EtpAlternativeDto, direction: -1 | 1) => {
      setNotice(null);
      reorder.mutate({ id: alternative.id, direction });
    },
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{canManage ? t('hint') : t('readOnly')}</p>
        {canManage ? (
          <Button
            size="sm"
            onClick={() => {
              setEditing('new');
            }}
          >
            {t('add')}
          </Button>
        ) : null}
      </div>
      {masked ? <p className="text-xs text-muted-foreground">{t('maskedHint')}</p> : null}
      <div aria-live="polite">{notice === null ? null : <Alert tone="error" title={notice} />}</div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <AlternativesComparisonTable rows={rows} byId={byId} actions={actions} />
      )}

      <AlternativeFormDrawer
        etpId={etpId}
        alternative={editing === 'new' ? null : editing}
        masked={masked}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onChanged={refresh}
      />
      <DecideAlternativeDialog
        target={deciding}
        recommended={
          meta.recommendedAlternativeId === null
            ? null
            : (byId.get(meta.recommendedAlternativeId) ?? null)
        }
        onClose={() => {
          setDeciding(null);
        }}
        onChanged={refresh}
      />
      <DeleteAlternativeDialog
        alternative={removing}
        onClose={() => {
          setRemoving(null);
        }}
        onChanged={refresh}
      />
    </div>
  );
}

interface RowActions {
  readonly canManage: boolean;
  readonly pending: boolean;
  readonly onEdit: (alternative: EtpAlternativeDto) => void;
  readonly onDecide: (alternative: EtpAlternativeDto, decision: AlternativeDecision) => void;
  readonly onRemove: (alternative: EtpAlternativeDto) => void;
  readonly onMove: (alternative: EtpAlternativeDto, direction: -1 | 1) => void;
}

function DecisionBadge({ row }: { readonly row: AlternativeComparisonRow }) {
  const tone =
    row.decision === 'RECOMMENDED'
      ? 'border-success text-success'
      : row.decision === 'DISCARDED'
        ? 'border-border text-muted-foreground line-through'
        : 'border-border';
  return (
    <span className={`inline-flex rounded-control border px-2 py-0.5 text-xs font-medium ${tone}`}>
      {ALTERNATIVE_DECISION_LABELS[row.decision]}
    </span>
  );
}

function CostCell({ row }: { readonly row: AlternativeComparisonRow }) {
  const t = useTranslations('etp.alternatives');
  if (row.estimatedCostMasked) return <span className="text-muted-foreground">{t('masked')}</span>;
  if (row.estimatedCost === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="tabular-nums">
      {BRL(row.estimatedCost)}
      {row.isLowestCost ? (
        <span className="ml-1 text-xs text-muted-foreground">({t('lowestCost')})</span>
      ) : null}
    </span>
  );
}

/** Ações da linha no menu "⋯" (prd-5 · regra 3): editar, decidir, reordenar e excluir. */
function RowMenu({
  alternative,
  index,
  total,
  actions,
}: {
  readonly alternative: EtpAlternativeDto;
  readonly index: number;
  readonly total: number;
  readonly actions: RowActions;
}) {
  const t = useTranslations('etp.alternatives');
  if (!actions.canManage) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={buttonClassName({ variant: 'ghost', size: 'sm' })}
        aria-label={t('actions.menu', { name: alternative.name })}
      >
        <Ellipsis aria-hidden="true" className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() => {
            actions.onEdit(alternative);
          }}
        >
          <Pencil aria-hidden="true" className="size-4" />
          {t('actions.edit')}
        </DropdownMenuItem>
        {alternative.decision === 'RECOMMENDED' ? (
          <DropdownMenuItem
            onSelect={() => {
              actions.onDecide(alternative, 'UNDER_ANALYSIS');
            }}
          >
            {t('actions.reopen')}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onSelect={() => {
              actions.onDecide(alternative, 'RECOMMENDED');
            }}
          >
            <BadgeCheck aria-hidden="true" className="size-4" />
            {t('actions.recommend')}
          </DropdownMenuItem>
        )}
        {alternative.decision === 'DISCARDED' ? null : (
          <DropdownMenuItem
            onSelect={() => {
              actions.onDecide(alternative, 'DISCARDED');
            }}
          >
            {t('actions.discard')}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={actions.pending || index === 0}
          onSelect={() => {
            actions.onMove(alternative, -1);
          }}
        >
          <ChevronUp aria-hidden="true" className="size-4" />
          {t('actions.up')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={actions.pending || index === total - 1}
          onSelect={() => {
            actions.onMove(alternative, 1);
          }}
        >
          <ChevronDown aria-hidden="true" className="size-4" />
          {t('actions.down')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive"
          onSelect={() => {
            actions.onRemove(alternative);
          }}
        >
          <Trash2 aria-hidden="true" className="size-4" />
          {t('actions.remove')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** `AlternativesComparisonTable` (RN-ETP-23): tabela em ≥ 768 px; cartões abaixo disso. */
export function AlternativesComparisonTable({
  rows,
  byId,
  actions,
}: {
  readonly rows: readonly AlternativeComparisonRow[];
  readonly byId: ReadonlyMap<string, EtpAlternativeDto>;
  readonly actions: RowActions;
}) {
  const t = useTranslations('etp.alternatives');
  return (
    <>
      <TableContainer label={t('caption')} className="hidden md:block">
        <Table>
          <caption className="sr-only">{t('caption')}</caption>
          <TableHead>
            <Tr>
              <Th>{t('columns.name')}</Th>
              <Th>{t('columns.decision')}</Th>
              <Th className="text-right">{t('columns.cost')}</Th>
              <Th>{t('columns.risk')}</Th>
              {actions.canManage ? (
                <Th>
                  <span className="sr-only">{t('columns.actions')}</span>
                </Th>
              ) : null}
            </Tr>
          </TableHead>
          <TableBody>
            {rows.map((row, index) => {
              const alternative = byId.get(row.id);
              return (
                <Tr
                  key={row.id}
                  aria-current={row.isRecommended ? 'true' : undefined}
                  className={row.isRecommended ? 'bg-success-soft' : ''}
                >
                  <th scope="row" className="min-w-48 px-3.5 py-3 text-left font-semibold">
                    {row.name}
                  </th>
                  <Td>
                    <DecisionBadge row={row} />
                  </Td>
                  <Td className="text-right">
                    <CostCell row={row} />
                  </Td>
                  <Td>{row.riskLevel === null ? '—' : RISK_LEVEL_LABELS[row.riskLevel]}</Td>
                  {actions.canManage && alternative ? (
                    <Td className="w-12 text-right">
                      <RowMenu
                        alternative={alternative}
                        index={index}
                        total={rows.length}
                        actions={actions}
                      />
                    </Td>
                  ) : null}
                </Tr>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      <ul aria-label={t('caption')} className="flex flex-col gap-2 md:hidden">
        {rows.map((row, index) => {
          const alternative = byId.get(row.id);
          return (
            <li
              key={row.id}
              className={`flex flex-col gap-2 rounded-card p-3 text-sm ${row.isRecommended ? 'bg-success-soft' : 'bg-muted'}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 font-semibold break-words">{row.name}</span>
                <span className="flex items-center gap-1">
                  <DecisionBadge row={row} />
                  {alternative ? (
                    <RowMenu
                      alternative={alternative}
                      index={index}
                      total={rows.length}
                      actions={actions}
                    />
                  ) : null}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-1 text-xs">
                <dt className="text-muted-foreground">{t('columns.cost')}</dt>
                <dd>
                  <CostCell row={row} />
                </dd>
                <dt className="text-muted-foreground">{t('columns.risk')}</dt>
                <dd>{row.riskLevel === null ? '—' : RISK_LEVEL_LABELS[row.riskLevel]}</dd>
              </dl>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// --- Formulário ---------------------------------------------------------------------------------

interface AlternativeFormDrawerProps {
  readonly etpId: string;
  /** `null` = nova alternativa; a editada vem da lista mais recente (versão atual). */
  readonly alternative: EtpAlternativeDto | null;
  /** POL-09: o custo do processo sigiloso não é exibido nem enviado. */
  readonly masked: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onChanged: () => Promise<void> | void;
}

/** Valor da opção "sem risco informado" (o Radix não aceita `SelectItem value=""`). */
const NO_RISK = '__none__';

/** `AlternativeFormDrawer` (passos 1 e 7): painel lateral de cadastro e edição. */
export function AlternativeFormDrawer(props: AlternativeFormDrawerProps) {
  const t = useTranslations('etp.alternatives.form');
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent closeLabel={t('close')} aria-describedby={undefined}>
        <div className="border-b border-border p-4 pr-12">
          <DialogTitle>{props.alternative === null ? t('addTitle') : t('editTitle')}</DialogTitle>
        </div>
        {props.open ? <AlternativeForm key={props.alternative?.id ?? 'new'} {...props} /> : null}
      </SheetContent>
    </Dialog>
  );
}

function ProblemAlert({
  problem,
  onRetry,
}: {
  readonly problem: AlternativeProblem | null;
  readonly onRetry?: () => void;
}) {
  const t = useTranslations('etp.alternatives');
  const tErrors = useTranslations('errors.correlation');
  if (problem === null) return null;
  if (problem.kind === 'fields') return <Alert tone="error" title={t('errors.formErrors')} />;
  if (problem.kind === 'unexpected') {
    return (
      <Alert tone="error" title={t('errors.unexpected')}>
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
  const message = alternativeProblemMessage(problem);
  if (message === null) return null;
  return (
    <Alert tone={problem.kind === 'stale' ? 'warning' : 'error'} title={message}>
      {problem.kind === 'unavailable' && onRetry ? (
        <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={onRetry}>
          {t('retry')}
        </Button>
      ) : null}
    </Alert>
  );
}

function AlternativeForm({
  etpId,
  alternative,
  masked,
  onOpenChange,
  onChanged,
}: AlternativeFormDrawerProps) {
  const t = useTranslations('etp.alternatives');
  const idPrefix = useId();
  const formRef = useRef<HTMLFormElement | null>(null);
  const [values, setValues] = useState<AlternativeFormValues>(() =>
    alternativeFormValuesOf(alternative),
  );
  const [messages, setMessages] = useState<AlternativeFieldMessages>({});
  const [problem, setProblem] = useState<AlternativeProblem | null>(null);
  const costHidden = masked || alternative?.estimatedCostMasked === true;

  const set = <K extends keyof AlternativeFormValues>(
    field: K,
    value: AlternativeFormValues[K],
  ) => {
    setValues((current) => ({ ...current, [field]: value }));
  };
  const fieldId = (name: string) => `${idPrefix}-${name}`;
  const focusFirstError = () => {
    setTimeout(() => {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    }, 0);
  };

  const save = useMutation({
    mutationFn: () =>
      alternative === null
        ? createEtpAlternative(etpId, createAlternativeBodyOf(values, { masked: costHidden }))
        : updateEtpAlternative(
            alternative.id,
            alternativePatchOf(alternative, values),
            alternative.version,
          ),
    onSuccess: async () => {
      toast({
        title: alternative === null ? t('toast.added') : t('toast.updated'),
        tone: 'success',
      });
      await onChanged();
      onOpenChange(false);
    },
    onError: (error: unknown) => {
      const found = alternativeProblemOf(error);
      if (found.kind === 'fields') {
        setMessages(found.fields);
        focusFirstError();
      }
      if (found.kind === 'notFound') {
        toast({ title: ETP_ALTERNATIVE_MESSAGES.notFound, tone: 'error' });
        void onChanged();
        onOpenChange(false);
        return;
      }
      if (found.kind === 'stale' || found.kind === 'blocked' || found.kind === 'permission') {
        void onChanged();
      }
      setProblem(found);
    },
  });

  const submit = () => {
    const found = validateAlternative(values, { masked: costHidden });
    setMessages(found);
    if (Object.keys(found).length > 0) {
      setProblem({ kind: 'fields', fields: found });
      focusFirstError();
      return;
    }
    setProblem(null);
    if (alternative !== null && Object.keys(alternativePatchOf(alternative, values)).length === 0) {
      onOpenChange(false);
      return;
    }
    save.mutate();
  };

  const pending = save.isPending;
  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div aria-live="polite">
          <ProblemAlert problem={problem} onRetry={submit} />
        </div>
        <FormField
          id={fieldId('name')}
          label={t('form.fields.name')}
          error={messages.name}
          required
        >
          {(control) => (
            <Input
              {...control}
              maxLength={ETP_ALTERNATIVE_LIMITS.nameMax}
              value={values.name}
              onChange={(event) => {
                set('name', event.target.value);
              }}
            />
          )}
        </FormField>
        <FormField
          id={fieldId('description')}
          label={t('form.fields.description')}
          error={messages.description}
          required
        >
          {(control) => (
            <Textarea
              {...control}
              value={values.description}
              onChange={(event) => {
                set('description', event.target.value);
              }}
            />
          )}
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            id={fieldId('advantages')}
            label={t('form.fields.advantages')}
            error={messages.advantages}
          >
            {(control) => (
              <Textarea
                {...control}
                value={values.advantages}
                onChange={(event) => {
                  set('advantages', event.target.value);
                }}
              />
            )}
          </FormField>
          <FormField
            id={fieldId('disadvantages')}
            label={t('form.fields.disadvantages')}
            error={messages.disadvantages}
          >
            {(control) => (
              <Textarea
                {...control}
                value={values.disadvantages}
                onChange={(event) => {
                  set('disadvantages', event.target.value);
                }}
              />
            )}
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {costHidden ? (
            <div className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t('form.fields.estimatedCost')}</span>
              <span className="text-muted-foreground">{t('masked')}</span>
            </div>
          ) : (
            <FormField
              id={fieldId('estimatedCost')}
              label={t('form.fields.estimatedCost')}
              error={messages.estimatedCost}
            >
              {({ id, ...control }) => (
                <MoneyInput
                  id={id}
                  {...control}
                  value={values.estimatedCost}
                  onValueChange={(text) => {
                    set('estimatedCost', text);
                  }}
                />
              )}
            </FormField>
          )}
          <FormField
            id={fieldId('riskLevel')}
            label={t('form.fields.riskLevel')}
            error={messages.riskLevel}
          >
            {(control) => (
              <Select
                value={values.riskLevel === '' ? NO_RISK : values.riskLevel}
                onValueChange={(value) => {
                  set('riskLevel', value === NO_RISK ? '' : (value as RiskLevel));
                }}
              >
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_RISK}>{t('form.noRisk')}</SelectItem>
                  {RISK_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {RISK_LEVEL_LABELS[level]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
        </div>
        <FormField
          id={fieldId('observations')}
          label={t('form.fields.observations')}
          error={messages.observations}
        >
          {(control) => (
            <Textarea
              {...control}
              maxLength={ETP_ALTERNATIVE_LIMITS.observationsMax}
              value={values.observations}
              onChange={(event) => {
                set('observations', event.target.value);
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
        <Button type="submit" disabled={pending}>
          {pending ? t('form.saving') : t('form.save')}
        </Button>
      </div>
    </form>
  );
}

// --- Decisão ------------------------------------------------------------------------------------

/**
 * `DecideAlternativeDialog` (passos 4–6): justificativa ≥ 20 caracteres para recomendar/descartar
 * (V-04). Com outra já recomendada, a API recusa (V-05) e o diálogo vira o
 * `ReplaceRecommendedConfirm` ("Substituir recomendação" reenvia com `replaceRecommended: true`).
 */
export function DecideAlternativeDialog({
  target,
  recommended,
  onClose,
  onChanged,
}: {
  readonly target: Decide | null;
  /** A recomendada atual (para o aviso de substituição). */
  readonly recommended: EtpAlternativeDto | null;
  readonly onClose: () => void;
  readonly onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations('etp.alternatives.decide');
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent closeLabel={null}>
        {target === null ? (
          <DialogTitle>{t('title.RECOMMENDED')}</DialogTitle>
        ) : (
          <DecideForm
            key={`${target.alternative.id}-${target.decision}`}
            target={target}
            recommended={recommended}
            onClose={onClose}
            onChanged={onChanged}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DecideForm({
  target,
  recommended,
  onClose,
  onChanged,
}: {
  readonly target: Decide;
  readonly recommended: EtpAlternativeDto | null;
  readonly onClose: () => void;
  readonly onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations('etp.alternatives.decide');
  const fieldId = useId();
  const { alternative, decision } = target;
  const [justification, setJustification] = useState(
    decision === alternative.decision ? (alternative.decisionJustification ?? '') : '',
  );
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<AlternativeProblem | null>(null);
  const needsJustification = decision !== 'UNDER_ANALYSIS';

  const decide = useMutation({
    mutationFn: (replaceRecommended: boolean) =>
      decideEtpAlternative(
        alternative.id,
        {
          decision,
          ...(justification.trim() === '' ? {} : { decisionJustification: justification }),
          ...(replaceRecommended ? { replaceRecommended: true } : {}),
        },
        alternative.version,
      ),
    onSuccess: async () => {
      toast({ title: t(`toast.${decision}`, { name: alternative.name }), tone: 'success' });
      onClose();
      await onChanged();
    },
    onError: (error: unknown) => {
      const found = alternativeProblemOf(error);
      if (found.kind === 'justification') {
        setMessage(found.message);
        return;
      }
      if (found.kind === 'stale' || found.kind === 'notFound') {
        toast({ title: alternativeProblemMessage(found) ?? '', tone: 'error' });
        void onChanged();
        onClose();
        return;
      }
      setProblem(found);
    },
  });

  const submit = (replaceRecommended: boolean) => {
    const found = decisionMessageOf(decision, justification);
    setMessage(found);
    if (found !== null) {
      document.getElementById(fieldId)?.focus();
      return;
    }
    setProblem(null);
    decide.mutate(replaceRecommended);
  };

  if (problem?.kind === 'recommendedExists') {
    // `ReplaceRecommendedConfirm` (FA-01).
    return (
      <>
        <DialogTitle>{t('replace.title')}</DialogTitle>
        <DialogDescription>{ETP_ALTERNATIVE_MESSAGES.recommendedExists}</DialogDescription>
        {recommended === null ? null : (
          <p className="text-sm text-muted-foreground">
            {t('replace.current', { name: recommended.name })}
          </p>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            disabled={decide.isPending}
            onClick={() => {
              setProblem(null);
              decide.mutate(true);
            }}
          >
            {t('replace.confirm')}
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogTitle>{t(`title.${decision}`, { name: alternative.name })}</DialogTitle>
      <DialogDescription>{t(`description.${decision}`)}</DialogDescription>
      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId} className="text-sm font-medium">
          {needsJustification ? t('justification') : t('justificationOptional')}
        </label>
        <Textarea
          id={fieldId}
          maxLength={ETP_ALTERNATIVE_LIMITS.justificationMax}
          aria-invalid={message !== null ? true : undefined}
          aria-required={needsJustification ? true : undefined}
          aria-describedby={message !== null ? `${fieldId}-error` : undefined}
          value={justification}
          onChange={(event) => {
            setJustification(event.target.value);
          }}
        />
        {message !== null ? (
          <p id={`${fieldId}-error`} className="text-sm text-destructive" aria-live="polite">
            {message}
          </p>
        ) : null}
      </div>
      <div aria-live="polite">
        <ProblemAlert
          problem={problem}
          onRetry={() => {
            submit(false);
          }}
        />
      </div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          disabled={decide.isPending}
          onClick={() => {
            submit(false);
          }}
        >
          {t(`confirm.${decision}`)}
        </Button>
      </DialogFooter>
    </>
  );
}

// --- Exclusão -----------------------------------------------------------------------------------

/** Exclusão lógica (passo 7 · RN-ETP-22); a recomendada pede antes a mudança da decisão (FA-03). */
export function DeleteAlternativeDialog({
  alternative,
  onClose,
  onChanged,
}: {
  readonly alternative: EtpAlternativeDto | null;
  readonly onClose: () => void;
  readonly onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations('etp.alternatives.remove');
  const [problem, setProblem] = useState<AlternativeProblem | null>(null);
  const close = () => {
    setProblem(null);
    onClose();
  };
  const remove = useMutation({
    mutationFn: (target: EtpAlternativeDto) => deleteEtpAlternative(target.id, target.version),
    onSuccess: async () => {
      toast({ title: t('toast'), tone: 'success' });
      close();
      await onChanged();
    },
    onError: (error: unknown) => {
      const found = alternativeProblemOf(error);
      if (found.kind === 'stale' || found.kind === 'notFound') {
        toast({ title: alternativeProblemMessage(found) ?? '', tone: 'error' });
        void onChanged();
        close();
        return;
      }
      setProblem(found);
    },
  });
  const isRecommended = alternative?.decision === 'RECOMMENDED';
  return (
    <Dialog
      open={alternative !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent closeLabel={null}>
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>
          {isRecommended
            ? ETP_ALTERNATIVE_MESSAGES.deleteRecommended
            : t('description', { name: alternative?.name ?? '' })}
        </DialogDescription>
        <div aria-live="polite">
          <ProblemAlert problem={problem} />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={close}>
            {t('cancel')}
          </Button>
          {isRecommended ? null : (
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => {
                setProblem(null);
                if (alternative !== null) remove.mutate(alternative);
              }}
            >
              {t('confirm')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
