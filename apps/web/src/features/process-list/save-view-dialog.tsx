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
import { SAVED_VIEW_NAME_MAX } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { newIdempotencyKey } from '@/lib/api/client';

import { classifyViewError, validateViewName, viewFailureMessage } from './saved-views-model';
import type { NewViewInput } from './use-saved-views';

/*
 * `SaveViewDialog` (US-003 · fluxo principal 1–4): Nome (obrigatório, até 80), "Usar como visão
 * padrão", "Compartilhar com a equipe" e o resumo dos critérios em texto. Erros da API aparecem no
 * campo (409 nome repetido, 422 por campo) ou no topo do formulário (limite de 20 visões…) e o
 * diálogo continua aberto. A `Idempotency-Key` nasce na primeira tentativa e é reaproveitada
 * enquanto o conteúdo não muda (reenvio após falha de rede); foco preso e devolvido ao gatilho.
 */

export interface SaveViewDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** `copy`: "Salvar como minha" (cópia de visão compartilhada por outro dono). */
  readonly mode: 'new' | 'copy';
  readonly initialName: string;
  readonly summary: string;
  readonly onSubmit: (input: NewViewInput, idempotencyKey: string) => Promise<unknown>;
  readonly returnFocusRef?: RefObject<HTMLElement | null> | undefined;
}

export function SaveViewDialog({
  open,
  onOpenChange,
  mode,
  initialName,
  summary,
  onSubmit,
  returnFocusRef,
}: SaveViewDialogProps) {
  const t = useTranslations('processList.views.saveDialog');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={t('cancel')}
        onCloseAutoFocus={(event) => {
          if (returnFocusRef?.current) {
            event.preventDefault();
            returnFocusRef.current.focus();
          }
        }}
      >
        <DialogTitle>{mode === 'copy' ? t('copyTitle') : t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
        <SaveViewForm
          initialName={initialName}
          summary={summary}
          onSubmit={onSubmit}
          onDone={() => {
            onOpenChange(false);
          }}
          onCancel={() => {
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function SaveViewForm({
  initialName,
  summary,
  onSubmit,
  onDone,
  onCancel,
}: {
  readonly initialName: string;
  readonly summary: string;
  readonly onSubmit: SaveViewDialogProps['onSubmit'];
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const t = useTranslations('processList.views.saveDialog');
  const tViews = useTranslations('processList.views');
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialName);
  const [isDefault, setIsDefault] = useState(false);
  const [isShared, setIsShared] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const attempt = useRef<{ readonly key: string; readonly fingerprint: string } | null>(null);

  const submit = async () => {
    const invalid = validateViewName(name);
    setFormError(null);
    if (invalid !== null) {
      setNameError(invalid);
      nameRef.current?.focus();
      return;
    }
    setNameError(null);
    // Mesma chave para o mesmo conteúdo (reenvio idempotente); conteúdo novo, chave nova.
    const fingerprint = JSON.stringify([name.trim(), isDefault, isShared]);
    const request =
      attempt.current?.fingerprint === fingerprint
        ? attempt.current
        : { key: newIdempotencyKey(), fingerprint };
    attempt.current = request;
    setPending(true);
    try {
      await onSubmit({ name, isDefault, isShared }, request.key);
      onDone();
    } catch (error) {
      const failure = classifyViewError(error, 'create');
      // Só a indisponibilidade mantém a chave: o reenvio é o mesmo pedido.
      if (failure.kind !== 'unavailable') attempt.current = null;
      if (failure.kind === 'nameTaken') {
        setNameError(viewFailureMessage(failure));
        nameRef.current?.focus();
      } else if (failure.kind === 'validation' && failure.fields.name !== undefined) {
        setNameError(failure.fields.name);
        nameRef.current?.focus();
      } else if (failure.kind === 'validation') {
        setFormError(failure.message ?? failure.fields.filters ?? failure.fields.columns ?? null);
      } else {
        setFormError(viewFailureMessage(failure) ?? tViews('unavailable'));
      }
    } finally {
      setPending(false);
    }
  };

  const nameId = `${id}-name`;
  const errorId = `${id}-name-error`;
  const countId = `${id}-name-count`;
  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {formError !== null ? <Alert tone="error" title={formError} /> : null}

      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className="text-sm font-medium">
          {t('name')} *
        </label>
        <input
          id={nameId}
          ref={nameRef}
          type="text"
          value={name}
          required
          aria-required="true"
          aria-invalid={nameError !== null}
          aria-describedby={nameError === null ? countId : `${errorId} ${countId}`}
          autoComplete="off"
          onChange={(event) => {
            setName(event.target.value);
            setNameError(null);
          }}
          className="h-11 rounded-control border border-border bg-surface px-3 text-sm md:h-9"
        />
        {nameError !== null ? (
          <p id={errorId} role="alert" className="text-xs text-destructive">
            {nameError}
          </p>
        ) : null}
        <p id={countId} className="text-xs text-muted-foreground">
          {t('nameCount', { count: name.trim().length, max: SAVED_VIEW_NAME_MAX })}
        </p>
      </div>

      <div>
        <h3 className="text-sm font-medium">{t('criteria')}</h3>
        <p className="text-sm text-muted-foreground">{summary}</p>
      </div>

      <div className="flex flex-col gap-3">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4"
            checked={isDefault}
            aria-describedby={`${id}-default-hint`}
            onChange={(event) => {
              setIsDefault(event.target.checked);
            }}
          />
          <span>
            {t('isDefault')}
            <span id={`${id}-default-hint`} className="block text-xs text-muted-foreground">
              {t('isDefaultHint')}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4"
            checked={isShared}
            aria-describedby={`${id}-shared-hint`}
            onChange={(event) => {
              setIsShared(event.target.checked);
            }}
          />
          <span>
            {t('isShared')}
            <span id={`${id}-shared-hint`} className="block text-xs text-muted-foreground">
              {t('isSharedHint')}
            </span>
          </span>
        </label>
      </div>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? t('saving') : t('submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}
