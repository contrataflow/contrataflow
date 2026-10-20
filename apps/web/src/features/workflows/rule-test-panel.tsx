'use client';

import { Alert, Button } from '@contrataflow/ui';
import type { ProcessListItemDto, WorkflowRuleTestResult } from '@contrataflow/validation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useDeferredValue, useId, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useTenantId } from '@/lib/session/session-context';

import { searchRuleTestProcesses, testRule, workflowKeys } from './workflows.api';
import type { RuleTestInput } from './workflows.api';

const INPUT = 'h-10 w-full rounded-control border border-border bg-surface px-3 text-sm';
const MIN_QUERY = 2;

const processLabel = (process: ProcessListItemDto) =>
  `${process.code ?? process.internalCode ?? '—'} — ${process.title}`;

const valueText = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value ?? null);

/**
 * `RuleTestPanel` (US-044 · passo 6 · FA-03 · WF-23): busca o processo de referência (PRC-01, por
 * código/título) e avalia a regra do FORMULÁRIO — salva ou não — sem gravar nada. O resultado é
 * anunciado (`aria-live`) com texto e cor ("Satisfeita" / "Não satisfeita — {mensagem}"), junto aos
 * valores do contexto usados e aos avisos (FA-04: "Campo não reconhecido").
 */
export function RuleTestPanel({
  versionId,
  buildRequest,
}: {
  readonly versionId: string;
  /** A regra do formulário pronta para o teste; `null` = configuração incompleta. */
  readonly buildRequest: () => Omit<RuleTestInput, 'processId'> | null;
}) {
  const t = useTranslations('workflows.rules.test');
  const tenantId = useTenantId();
  const ids = useId();
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query.trim());
  const [selected, setSelected] = useState<ProcessListItemDto | null>(null);
  const [result, setResult] = useState<WorkflowRuleTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = useQuery({
    queryKey: workflowKeys.ruleTestProcesses(tenantId, deferred),
    queryFn: async ({ signal }) => (await searchRuleTestProcesses(deferred, signal)).data,
    enabled: selected === null && deferred.length >= MIN_QUERY,
    throwOnError: false,
  });

  const run = useMutation({
    mutationFn: (body: RuleTestInput) => testRule(versionId, body),
    onSuccess: (response) => {
      setError(null);
      setResult(response.data);
    },
    onError: (failure) => {
      setResult(null);
      if (isApiError(failure) && failure.status === 404) {
        setSelected(null);
        setError(t('processNotFound'));
      } else if (isApiError(failure) && failure.code === 'WORKFLOW_INVALID') {
        setError(t('operatorForbidden'));
      } else if (isApiError(failure) && failure.code === 'VALIDATION_ERROR') {
        setError(t('invalidConfig'));
      } else {
        setError(t('failed'));
      }
    },
  });

  const onRun = () => {
    if (selected === null) return;
    const body = buildRequest();
    if (body === null) {
      setResult(null);
      setError(t('fixForm'));
      return;
    }
    run.mutate({ ...body, processId: selected.id });
  };

  const entries = result ? Object.entries(result.contextUsed) : [];

  return (
    <section
      aria-labelledby={`${ids}-title`}
      className="flex flex-col gap-3 rounded-card border border-border bg-surface p-3"
    >
      <h3 id={`${ids}-title`} className="font-medium">
        {t('title')}
      </h3>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
      {selected ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{t('selected', { label: processLabel(selected) })}</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setSelected(null);
              setResult(null);
            }}
          >
            {t('change')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-search`} className="text-sm font-medium">
            {t('search')}
          </label>
          <input
            id={`${ids}-search`}
            type="search"
            className={INPUT}
            value={query}
            aria-describedby={`${ids}-search-hint`}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
          <p id={`${ids}-search-hint`} className="text-xs text-muted-foreground">
            {t('searchHint')}
          </p>
          {deferred.length >= MIN_QUERY ? (
            search.isPending ? (
              <p className="text-sm text-muted-foreground">{t('searching')}</p>
            ) : (search.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noResults')}</p>
            ) : (
              <ul className="flex flex-col gap-1" aria-label={t('search')}>
                {(search.data ?? []).map((process) => (
                  <li key={process.id}>
                    <button
                      type="button"
                      className="w-full rounded-control px-2 py-1 text-left text-sm hover:bg-muted"
                      onClick={() => {
                        setSelected(process);
                        setError(null);
                      }}
                    >
                      {processLabel(process)}
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>
      )}
      <div>
        <Button
          type="button"
          variant="secondary"
          disabled={selected === null || run.isPending}
          aria-busy={run.isPending}
          onClick={onRun}
        >
          {t('run')}
        </Button>
      </div>
      <div aria-live="polite" className="flex flex-col gap-2">
        {error ? <Alert tone="error" title={error} /> : null}
        {result ? (
          <Alert
            tone={
              result.satisfied ? 'success' : result.severity === 'WARNING' ? 'warning' : 'error'
            }
            title={
              result.satisfied ? t('satisfied') : t('notSatisfied', { message: result.message })
            }
          >
            {result.warnings.map((warning) => (
              <p key={warning.code}>{t('warning', { message: warning.message })}</p>
            ))}
            <p className="mt-1 font-medium">{t('contextUsed')}</p>
            {entries.length === 0 ? (
              <p>{t('noContext')}</p>
            ) : (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                {entries.map(([path, value]) => (
                  <div key={path} className="contents">
                    <dt className="font-mono text-xs">{path}</dt>
                    <dd className="font-mono text-xs break-all">{valueText(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Alert>
        ) : null}
      </div>
    </section>
  );
}
