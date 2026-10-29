'use client';

import { Button } from '@contrataflow/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { useTenantId } from '@/lib/session/session-context';

import {
  lookupUnits,
  lookupUsers,
  participantKeys,
} from '../process-participants/process-participants.api';
import { FormField, INPUT_CLASS } from '../processes/form-field';

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

interface Option {
  readonly id: string;
  readonly name: string;
  readonly detail: string | null;
}

export interface OwnerLookupProps {
  readonly id: string;
  readonly kind: 'USER' | 'DEPARTMENT';
  /** Id e nome atuais (vazio = ninguém). */
  readonly value: string;
  readonly name: string;
  readonly onChange: (id: string, name: string) => void;
  readonly error?: string | undefined;
  /** Impede nova busca/troca (gravação em andamento). */
  readonly disabled?: boolean | undefined;
  /** Rótulo e dica próprios de quem reutiliza a busca (ex.: responsável pelo DFD, obrigatório). */
  readonly label?: string | undefined;
  readonly hint?: string | undefined;
}

/**
 * Responsável do risco (US-033 · RN-RISK-06): pessoa (USR-02) ou unidade (DEP-02), ambos
 * opcionais. Busca por nome (mín. 2 caracteres) com os resultados como botões — acessível por
 * teclado e leitor de tela. Selecionado, o campo mostra o nome e o botão "Remover".
 */
export function OwnerLookup({
  id,
  kind,
  value,
  name,
  onChange,
  error,
  disabled,
  label: customLabel,
  hint,
}: OwnerLookupProps) {
  const t = useTranslations('risks.form.owner');
  const tenantId = useTenantId();
  const [text, setText] = useState('');
  const q = useDebounced(text.trim());
  const label = customLabel ?? (kind === 'USER' ? t('userLabel') : t('departmentLabel'));
  const selected = value !== '';
  const enabled = q.length >= 2 && !selected;
  const results = useQuery({
    queryKey:
      kind === 'USER'
        ? participantKeys.users(tenantId, q)
        : participantKeys.departments(tenantId, q),
    queryFn: async ({ signal }): Promise<Option[]> =>
      kind === 'USER'
        ? (await lookupUsers(q, signal)).map((item) => ({
            id: item.id,
            name: item.name,
            detail: item.email,
          }))
        : (await lookupUnits(q, signal)).map((item) => ({
            id: item.id,
            name: item.name,
            detail: null,
          })),
    enabled,
    throwOnError: false,
  });

  if (selected) {
    return (
      <FormField id={id} label={label} error={error}>
        {(control) => (
          <div className="flex flex-wrap items-center gap-2">
            <input
              {...control}
              className={`${INPUT_CLASS} flex-1`}
              value={name === '' ? t('defined') : name}
              readOnly
              aria-readonly
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={disabled}
              aria-label={t('removeField', { field: label.toLowerCase() })}
              onClick={() => {
                onChange('', '');
                setText('');
              }}
            >
              {t('remove')}
            </Button>
          </div>
        )}
      </FormField>
    );
  }
  return (
    <FormField id={id} label={label} hint={hint ?? t('hint')} error={error}>
      {(control) => (
        <div className="flex flex-col gap-1">
          <input
            {...control}
            type="search"
            autoComplete="off"
            className={INPUT_CLASS}
            value={text}
            disabled={disabled}
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
                  {(results.data ?? []).map((option) => (
                    <li key={option.id}>
                      <button
                        type="button"
                        className="w-full rounded-control px-2 py-1 text-left hover:bg-muted focus-visible:bg-muted"
                        onClick={() => {
                          onChange(option.id, option.name);
                          setText('');
                        }}
                      >
                        <span className="block">{option.name}</span>
                        {option.detail === null ? null : (
                          <span className="block text-xs text-muted-foreground">
                            {option.detail}
                          </span>
                        )}
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
