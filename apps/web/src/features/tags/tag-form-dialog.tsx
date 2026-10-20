'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
  cx,
  toast,
} from '@contrataflow/ui';
import {
  DEFAULT_TAG_COLOR,
  TAG_LIMITS,
  TAG_PALETTE,
  tagNameKey,
  tagNameSchema,
} from '@contrataflow/validation';
import type { TagDto, UpdateTagInput } from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';

import { TagChip } from './tag-chip';
import { createTag, updateTag } from './tags.api';

/** Paleta acessível em `radiogroup`: setas movem a seleção (roving tabindex). */
function ColorPaletteSelect({
  value,
  onChange,
  labelledBy,
  disabled,
}: {
  readonly value: string;
  readonly onChange: (color: string) => void;
  readonly labelledBy: string;
  readonly disabled: boolean;
}) {
  const t = useTranslations('tags');
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = Math.max(0, TAG_PALETTE.indexOf(value as (typeof TAG_PALETTE)[number]));
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = TAG_PALETTE.length - 1;
    const target =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? (index + 1) % TAG_PALETTE.length
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? (index - 1 + TAG_PALETTE.length) % TAG_PALETTE.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (target === null) return;
    event.preventDefault();
    const color = TAG_PALETTE[target];
    if (color) {
      onChange(color);
      refs.current[target]?.focus();
    }
  };
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex flex-wrap gap-2">
      {TAG_PALETTE.map((color, index) => (
        <button
          key={color}
          ref={(element) => {
            refs.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={color === value}
          aria-label={t(`colors.${color}`)}
          title={t(`colors.${color}`)}
          tabIndex={index === selected ? 0 : -1}
          disabled={disabled}
          onClick={() => {
            onChange(color);
          }}
          onKeyDown={(event) => {
            move(event, index);
          }}
          className={cx(
            'flex size-9 items-center justify-center rounded-full border-2 text-sm font-bold text-white md:size-8',
            color === value ? 'border-foreground' : 'border-transparent',
          )}
          style={{ backgroundColor: color }}
        >
          {color === value ? '✓' : ''}
        </button>
      ))}
    </div>
  );
}

export interface TagFormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Etiqueta em edição (`undefined` = nova). */
  readonly tag?: TagDto | undefined;
  /** 412/404: a etiqueta mudou — a lista é recarregada pelo chamador. */
  readonly onConflict: () => void;
  /** Depois de salvar (a lista é invalidada pelo chamador). */
  readonly onSaved: () => void;
}

/**
 * `TagForm` (US-007 · SCR-109 aba "Etiquetas"): nome (2–40) e cor da paleta acessível. Nova etiqueta
 * sai com `Idempotency-Key` (TAG-02); edição envia só o que mudou com `If-Match` (TAG-03). Ao
 * renomear, avisa que regras de workflow com o nome antigo deixam de reconhecer a etiqueta (FA-02).
 * O formulário só existe com o diálogo aberto: cada abertura parte do estado da etiqueta.
 */
export function TagFormDialog({
  open,
  onOpenChange,
  tag,
  onConflict,
  onSaved,
}: TagFormDialogProps) {
  const t = useTranslations('tags.admin.form');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('close')}>
        <TagForm
          tag={tag}
          onClose={() => {
            onOpenChange(false);
          }}
          onConflict={onConflict}
          onSaved={onSaved}
        />
      </DialogContent>
    </Dialog>
  );
}

function TagForm({
  tag,
  onClose,
  onConflict,
  onSaved,
}: {
  readonly tag: TagDto | undefined;
  readonly onClose: () => void;
  readonly onConflict: () => void;
  readonly onSaved: () => void;
}) {
  const t = useTranslations('tags.admin.form');
  const tToast = useTranslations('tags.admin.toast');
  const nameId = useId();
  const nameHintId = useId();
  const colorLabelId = useId();
  const [name, setName] = useState(tag?.name ?? '');
  const [color, setColor] = useState<string>(tag?.color ?? DEFAULT_TAG_COLOR);
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const finish = (saved: TagDto, key: 'created' | 'updated') => {
    toast({ title: tToast(key, { name: saved.name }), tone: 'success' });
    onSaved();
    onClose();
  };

  const create = useIdempotentMutation({
    mutationFn: (body: { name: string; color: string }, context) => createTag(body, context),
  });
  const update = useMutation({
    mutationFn: (input: { patch: UpdateTagInput; version: number; id: string }) =>
      updateTag(input.id, input.patch, input.version),
  });
  const pending = create.isPending || update.isPending;

  const failure = (error: unknown) => {
    if (isApiError(error) && (error.status === 412 || error.status === 404)) {
      onConflict();
      onClose();
    } else if (isApiError(error) && error.status === 409) {
      setNameError(t('nameTaken'));
    } else if (isApiError(error) && error.status === 422) {
      const fields = new Set(error.errors.map((entry) => entry.field));
      if (fields.has('name')) setNameError(t('nameInvalid'));
      else setFormError(t('colorInvalid'));
    } else {
      setFormError(
        isApiError(error) && error.status === 503 ? t('submitUnavailable') : t('submitFailed'),
      );
    }
  };

  const submit = () => {
    if (pending) return;
    const parsed = tagNameSchema.safeParse(name);
    if (!parsed.success) {
      setNameError(t('nameInvalid'));
      return;
    }
    setNameError(null);
    setFormError(null);
    const trimmed = parsed.data;
    if (tag === undefined) {
      create
        .submit({ name: trimmed, color })
        .then((saved) => {
          finish(saved, 'created');
        })
        .catch(failure);
      return;
    }
    const patch: UpdateTagInput = {
      ...(trimmed === tag.name ? {} : { name: trimmed }),
      ...(color === tag.color ? {} : { color }),
    };
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    update.mutate(
      { id: tag.id, patch, version: tag.version },
      {
        onSuccess: (saved) => {
          finish(saved, 'updated');
        },
        onError: failure,
      },
    );
  };

  const renamed = tag !== undefined && tagNameKey(name) !== tagNameKey(tag.name);

  return (
    <>
      <DialogTitle>{tag === undefined ? t('createTitle') : t('editTitle')}</DialogTitle>
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={nameId} className="text-sm font-medium">
            {t('name')}
          </label>
          <input
            id={nameId}
            type="text"
            maxLength={TAG_LIMITS.nameMax}
            autoComplete="off"
            aria-invalid={nameError !== null || undefined}
            aria-describedby={nameHintId}
            className="h-11 rounded-control border border-border bg-surface px-3 text-sm md:h-9"
            value={name}
            disabled={pending}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
            }}
          />
          <p id={nameHintId} className="text-xs text-muted-foreground">
            {t('nameHint')}
          </p>
          <p role="alert" className="text-sm text-destructive">
            {nameError}
          </p>
          {renamed ? (
            <p role="status" className="text-sm text-warning">
              {t('renameWarning')}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <span id={colorLabelId} className="text-sm font-medium">
            {t('color')}
          </span>
          <ColorPaletteSelect
            value={color}
            onChange={setColor}
            labelledBy={colorLabelId}
            disabled={pending}
          />
          <p className="text-xs text-muted-foreground">{t('colorHint')}</p>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">{t('preview')}</span>
          <div>
            <TagChip name={name.trim() === '' ? t('previewFallback') : name.trim()} color={color} />
          </div>
        </div>

        <div aria-live="polite">
          {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={pending} aria-busy={pending || undefined}>
            {t('submit')}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
