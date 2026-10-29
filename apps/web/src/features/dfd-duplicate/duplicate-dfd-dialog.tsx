'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Field,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Search,
  Skeleton,
  buttonClassName,
  cx,
  toast,
} from '@contrataflow/ui';
import type { DfdDto } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { newIdempotencyKey } from '@/lib/api/client';
import { hasPermission, useEffectivePermissions } from '@/lib/permissions/use-permission';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

import {
  duplicateDfdBody,
  eligibleTargets,
  initialValues,
  missingTarget,
  problemOf,
  searchTextOf,
} from './duplicate-dfd-model';
import type { DuplicateDfdValues, DuplicateProblem } from './duplicate-dfd-model';
import { duplicateDfd, searchTargetProcesses } from './duplicate-dfd.api';
import { dfdHref } from '../dfd/dfd.api';

export interface DuplicateDfdDialogProps {
  /** DFD de origem: id, processo e código (para o toast). */
  readonly dfd: Pick<DfdDto, 'id' | 'processId' | 'code'>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * `DuplicateDfdDialog` (US-018 · SCR-113 "Duplicar apenas o DFD"): escolhe o destino — "Novo
 * processo" (exige `PROCESS_CREATE`, senão a opção fica desabilitada) ou "Processo existente"
 * (busca por código/título entre os processos editáveis) — e confirma com o DFD-05 (`Idempotency-Key`
 * fixa por abertura). Sucesso leva ao wizard do novo DFD (SCR-007); 409 oferece "Abrir DFD" no
 * processo que já tem um; os demais erros ficam no diálogo.
 */
export function DuplicateDfdDialog({ dfd, open, onOpenChange }: DuplicateDfdDialogProps) {
  const t = useTranslations('dfd.duplicate');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('close')} className="max-h-[90vh] overflow-y-auto">
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
        {open ? (
          <DuplicateForm
            dfd={dfd}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DuplicateForm({
  dfd,
  onClose,
}: {
  readonly dfd: DuplicateDfdDialogProps['dfd'];
  readonly onClose: () => void;
}) {
  const t = useTranslations('dfd.duplicate');
  const router = useRouter();
  const queryClient = useQueryClient();
  const tenantId = useTenantId();
  const ids = useId();
  const permissions = useEffectivePermissions();
  const canCreateProcess = hasPermission(permissions.data, 'PROCESS_CREATE');

  // As permissões chegam depois de abrir: o padrão acompanha `PROCESS_CREATE` até o usuário escolher.
  const [choice, setChoice] = useState<DuplicateDfdValues['targetType'] | null>(null);
  const [target, setTarget] = useState<DuplicateDfdValues['target']>(null);
  const values: DuplicateDfdValues = {
    ...initialValues(canCreateProcess),
    ...(choice === null ? {} : { targetType: choice }),
    target,
  };
  const [search, setSearch] = useState('');
  const [problem, setProblem] = useState<DuplicateProblem | null>(null);
  const [needsTarget, setNeedsTarget] = useState(false);
  // Uma chave por abertura: reenvios (falha transitória) repetem a mesma (Duplicidade).
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  const text = searchTextOf(search);
  const existing = values.targetType === 'EXISTING_PROCESS';
  const candidates = useQuery({
    queryKey: tenantKey(tenantId, 'processes', 'dfd-duplicate-targets', text ?? ''),
    queryFn: ({ signal }) => searchTargetProcesses(text ?? '', signal),
    enabled: existing && text !== null,
    throwOnError: false,
  });
  const targets = eligibleTargets(candidates.data ?? [], dfd.processId);

  const duplicate = useMutation({
    mutationFn: (current: DuplicateDfdValues) =>
      duplicateDfd(dfd.id, duplicateDfdBody(current), idempotencyKey),
    onSuccess: (created) => {
      toast({
        title:
          dfd.code === null
            ? t('toastNoCode')
            : t('toast', { code: created.code ?? '—', sourceCode: dfd.code }),
        tone: 'success',
      });
      for (const key of ['processes', 'tasks', 'dashboard', 'documents'] as const) {
        void queryClient.invalidateQueries({ queryKey: tenantKey(tenantId, key) });
      }
      onClose();
      router.push(dfdHref(created.processId, created.id));
    },
    onError: (error: unknown) => {
      if (!isApiError(error)) {
        setProblem({ kind: 'unexpected', correlationId: '—' });
        return;
      }
      const found = problemOf(error);
      if (found.kind === 'keyReused') setIdempotencyKey(newIdempotencyKey());
      if (found.kind === 'target') void candidates.refetch();
      if (found.kind === 'notFound') {
        toast({ title: t('errors.notFound'), tone: 'error' });
        onClose();
        router.push('/processos');
        return;
      }
      setProblem(found);
    },
  });

  const submit = () => {
    if (duplicate.isPending) return;
    setProblem(null);
    if (missingTarget(values)) {
      setNeedsTarget(true);
      return;
    }
    setNeedsTarget(false);
    duplicate.mutate(values);
  };

  const chooseType = (targetType: DuplicateDfdValues['targetType']) => {
    setChoice(targetType);
    setProblem(null);
    setNeedsTarget(false);
  };

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <ProblemAlert
        problem={problem}
        targetProcessId={values.target?.id ?? null}
        onRetry={submit}
      />

      <Field label={t('target')} group>
        <RadioGroup
          value={values.targetType}
          onValueChange={(value) => {
            chooseType(value as DuplicateDfdValues['targetType']);
          }}
        >
          <div className="flex items-start gap-2.5 text-sm">
            <RadioGroupItem
              id={`${ids}-new`}
              value="NEW_PROCESS"
              className="mt-0.5"
              disabled={!canCreateProcess}
              aria-describedby={`${ids}-new-hint`}
            />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor={`${ids}-new`}>{t('newProcess')}</Label>
              <span id={`${ids}-new-hint`} className="text-xs text-muted-foreground">
                {canCreateProcess ? t('newProcessHint') : t('newProcessDenied')}
              </span>
            </div>
          </div>
          <div className="flex items-start gap-2.5 text-sm">
            <RadioGroupItem
              id={`${ids}-existing`}
              value="EXISTING_PROCESS"
              className="mt-0.5"
              aria-describedby={`${ids}-existing-hint`}
            />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor={`${ids}-existing`}>{t('existingProcess')}</Label>
              <span id={`${ids}-existing-hint`} className="text-xs text-muted-foreground">
                {t('existingProcessHint')}
              </span>
            </div>
          </div>
        </RadioGroup>
      </Field>

      {existing ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-search`}>{t('search')}</Label>
          <Input
            id={`${ids}-search`}
            type="search"
            icon={<Search />}
            value={search}
            aria-describedby={`${ids}-search-hint`}
            aria-invalid={needsTarget ? true : undefined}
            placeholder={t('searchPlaceholder')}
            maxLength={200}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
          <p id={`${ids}-search-hint`} className="text-xs text-muted-foreground">
            {t('searchHint')}
          </p>
          {needsTarget ? (
            <p role="alert" className="text-sm text-destructive">
              {t('errors.targetRequired')}
            </p>
          ) : null}
          <div aria-live="polite">
            {text === null ? null : candidates.isPending ? (
              <div role="status" className="flex flex-col gap-2">
                <span className="sr-only">{t('searching')}</span>
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : candidates.isError ? (
              <Alert tone="error" title={t('searchFailed')}>
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-2"
                  onClick={() => {
                    void candidates.refetch();
                  }}
                >
                  {t('errors.retry')}
                </Button>
              </Alert>
            ) : targets.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noTargets')}</p>
            ) : (
              <ul aria-label={t('results')} className="flex flex-col gap-1">
                {targets.map((item) => {
                  const selected = values.target?.id === item.id;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => {
                          setTarget(item);
                          setNeedsTarget(false);
                          setProblem(null);
                        }}
                        className={cx(
                          'flex w-full min-w-0 flex-col items-start gap-0.5 rounded-control border px-3 py-2 text-left text-sm',
                          selected
                            ? 'border-primary bg-primary-soft'
                            : 'border-border hover:bg-muted',
                        )}
                      >
                        <span className="w-full truncate font-medium">
                          {item.code ?? t('draftCode')} — {item.title}
                        </span>
                        <span className="w-full truncate text-xs text-muted-foreground">
                          {item.currentStage?.name ?? t('noStage')}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {values.target === null ? null : (
            <p className="text-sm">
              {t('selected', { code: values.target.code ?? t('draftCode') })}
            </p>
          )}
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">{t('whatCopies')}</p>

      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button type="submit" variant="primary" disabled={duplicate.isPending}>
          {duplicate.isPending ? t('submitting') : t('submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ProblemAlert({
  problem,
  targetProcessId,
  onRetry,
}: {
  readonly problem: DuplicateProblem | null;
  readonly targetProcessId: string | null;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('dfd.duplicate.errors');
  if (problem === null) return null;
  switch (problem.kind) {
    case 'exists':
      return (
        <Alert
          tone="error"
          title={problem.code === null ? t('existsNoCode') : t('exists', { code: problem.code })}
        >
          {problem.dfdId === null || targetProcessId === null ? null : (
            <div className="mt-2">
              <Link
                href={dfdHref(targetProcessId, problem.dfdId)}
                className={buttonClassName({ variant: 'secondary', size: 'sm' })}
              >
                {t('open')}
              </Link>
            </div>
          )}
        </Alert>
      );
    case 'stage':
      return <Alert tone="error" title={t('stage')} />;
    case 'target':
      return <Alert tone="error" title={t('target')} />;
    case 'process':
    case 'permission':
      return <Alert tone="error" title={problem.detail} />;
    case 'keyReused':
    case 'unexpected':
      return (
        <Alert
          tone="error"
          title={t('unexpected', {
            correlationId: problem.kind === 'unexpected' ? problem.correlationId : '—',
          })}
        />
      );
    case 'unavailable':
      return (
        <Alert tone="error" title={t('unavailable')}>
          <Button size="sm" variant="secondary" className="mt-2" onClick={onRetry}>
            {t('retry')}
          </Button>
        </Alert>
      );
    case 'notFound':
      return null;
  }
}

/** Quem tem `DFD_CREATE` em algum escopo vê "Duplicar DFD" (a API decide de novo, 403). */
export function useCanDuplicateDfd(): boolean {
  const permissions = useEffectivePermissions();
  return hasPermission(permissions.data, 'DFD_CREATE');
}

/**
 * "Duplicar DFD" (SCR-007 e lista de documentos): visível só com `DFD_CREATE` em algum escopo — a
 * UI esconde, a API decide (403) em toda requisição. Abre o diálogo SCR-113.
 */
export function DuplicateDfdButton({
  dfd,
  size = 'sm',
}: {
  readonly dfd: DuplicateDfdDialogProps['dfd'];
  readonly size?: 'sm' | 'md';
}) {
  const t = useTranslations('dfd.duplicate');
  const allowed = useCanDuplicateDfd();
  const [open, setOpen] = useState(false);
  if (!allowed) return null;
  return (
    <>
      <Button
        variant="secondary"
        size={size}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t('action')}
      </Button>
      <DuplicateDfdDialog dfd={dfd} open={open} onOpenChange={setOpen} />
    </>
  );
}
