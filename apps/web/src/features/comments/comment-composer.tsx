'use client';

import { Alert, Button } from '@contrataflow/ui';
import type { CommentDto, CommentTargetType, MentionCandidateDto } from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';

import {
  activeMentionQuery,
  commentBodyToText,
  insertMention,
  mentionsOfBody,
} from './comment-markup';
import type { ComposerMention } from './comment-markup';
import {
  TEXT_MAX,
  applyFormat,
  composerProblemOf,
  draftKeyOf,
  prepareCommentBody,
  readDraft,
  textLength,
  writeDraft,
} from './comments-model';
import type { ComposerProblem, ComposerProblemKey } from './comments-model';
import { createComment, updateComment, useMentionCandidates } from './comments.api';
import { MentionAutocomplete } from './mention-autocomplete';

export interface ComposerTarget {
  readonly targetType: CommentTargetType;
  readonly documentId?: string | undefined;
  readonly sectionKey?: string | undefined;
}

export type CommentComposerProps = {
  readonly processId: string;
  /** FA-07: aviso de não registrar valores estimados (RN-CMT-14). */
  readonly isBudgetConfidential: boolean;
  readonly onDone: (comment: CommentDto) => void;
  readonly onCancel?: (() => void) | undefined;
  /** Comentário/estado recusado pela API: o pai recarrega a lista (412/404/409). */
  readonly onStale?: (() => void) | undefined;
  readonly focusOnMount?: boolean | undefined;
} & (
  | {
      readonly mode: 'create';
      readonly target: ComposerTarget;
      /** Seções do documento (painel do editor): seleção opcional da âncora. */
      readonly sections?: readonly { readonly key: string; readonly title: string }[] | undefined;
    }
  | { readonly mode: 'reply'; readonly parent: CommentDto }
  | { readonly mode: 'edit'; readonly comment: CommentDto }
);

const STALE_KEYS: ReadonlySet<ComposerProblemKey> = new Set([
  'stale',
  'notFound',
  'readOnly',
  'editWindow',
]);

/**
 * `CommentComposer` (US-071 · fluxo principal, passo 3 · FA-01/FA-02/FA-07/FA-08): campo com barra
 * de formatação operável por teclado (negrito, itálico, lista e link — marcação convertida no JSON
 * TipTap restrito), contador, `Ctrl+Enter` envia e `Esc` cancela a edição/resposta. Na falha o texto
 * permanece (e fica no `sessionStorage` por processo/alvo) com a mensagem e o `correlationId`; o
 * reenvio da mesma intenção reutiliza a `Idempotency-Key`. US-072: "@" seguido de 1 caractere abre o
 * `MentionAutocomplete` (CMT-05); o candidato escolhido vira "@Rótulo" no texto e o nó `mention` no
 * envio. O compositor só existe para quem tem `COMMENT_CREATE` (RN-CMT-07).
 */
export function CommentComposer(props: CommentComposerProps) {
  const t = useTranslations('comments.composer');
  const fieldId = useId();
  const hintId = useId();
  const listboxId = useId();
  const optionId = (index: number) => `${listboxId}-option-${String(index)}`;
  const field = useRef<HTMLTextAreaElement>(null);
  const draftKey =
    props.mode === 'edit'
      ? null
      : draftKeyOf(props.processId, {
          documentId: props.mode === 'create' ? props.target.documentId : undefined,
          parentId: props.mode === 'reply' ? props.parent.id : undefined,
        });
  const [text, setText] = useState(() =>
    props.mode === 'edit'
      ? commentBodyToText(props.comment.body)
      : draftKey === null
        ? ''
        : readDraft(draftKey),
  );
  const [sectionKey, setSectionKey] = useState(
    props.mode === 'create' ? (props.target.sectionKey ?? '') : '',
  );
  const [problem, setProblem] = useState<ComposerProblem | null>(null);
  // US-072: menções escolhidas, posição do cursor, opção ativa e "@consulta" dispensada com Esc.
  const [mentions, setMentions] = useState<readonly ComposerMention[]>(() =>
    props.mode === 'edit' ? mentionsOfBody(props.comment.body) : [],
  );
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const query = caret === null ? null : activeMentionQuery(text, caret);
  const open = query !== null && dismissed !== query.start;
  const candidates = useMentionCandidates(props.processId, open ? query.query : null);
  const options = candidates.data ?? [];
  const popover = !open
    ? null
    : candidates.isError
      ? 'error'
      : candidates.data === undefined
        ? 'loading'
        : 'ready';
  const listed = popover === 'ready' && options.length > 0;
  const current = Math.min(active, Math.max(options.length - 1, 0));

  useEffect(() => {
    if (props.focusOnMount === true) field.current?.focus();
  }, [props.focusOnMount]);

  const persist = (value: string) => {
    setText(value);
    if (draftKey !== null) writeDraft(draftKey, value);
  };

  const { onDone, onStale } = props;
  const succeed = (comment: CommentDto) => {
    setProblem(null);
    setText('');
    setMentions([]);
    if (draftKey !== null) writeDraft(draftKey, '');
    onDone(comment);
  };
  const fail = (error: unknown) => {
    const found = composerProblemOf(error);
    setProblem(found);
    if (STALE_KEYS.has(found.key)) onStale?.();
  };

  const create = useIdempotentMutation({
    mutationFn: (
      variables: Parameters<typeof createComment>[1],
      context: Parameters<typeof createComment>[2],
    ) => createComment(props.processId, variables, context),
  });
  const edit = useMutation({
    mutationFn: ({
      id,
      version,
      body,
    }: {
      id: string;
      version: number;
      body: CommentDto['body'];
    }) => updateComment(id, body ?? { type: 'doc' }, version),
  });
  const pending = create.isPending || edit.isPending;

  const submit = async () => {
    if (pending) return;
    const prepared = prepareCommentBody(text, mentions);
    if (!prepared.ok) {
      setProblem({ key: prepared.key, correlationId: '—' });
      return;
    }
    setProblem(null);
    try {
      if (props.mode === 'edit') {
        succeed(
          await edit.mutateAsync({
            id: props.comment.id,
            version: props.comment.version,
            body: prepared.body,
          }),
        );
        return;
      }
      const variables =
        props.mode === 'reply'
          ? {
              body: prepared.body,
              targetType: props.parent.targetType,
              parentId: props.parent.id,
            }
          : {
              body: prepared.body,
              targetType: props.target.targetType,
              documentId: props.target.documentId,
              sectionKey:
                props.target.targetType === 'DOCUMENT' && sectionKey !== ''
                  ? sectionKey
                  : undefined,
            };
      succeed(await create.submit(variables));
    } catch (error) {
      fail(error);
    }
  };

  const format = (kind: 'bold' | 'italic' | 'list' | 'link') => {
    const element = field.current;
    const selection = {
      start: element?.selectionStart ?? text.length,
      end: element?.selectionEnd ?? text.length,
    };
    const next = applyFormat(text, selection, kind);
    persist(next.text);
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(next.start, next.end);
    });
  };

  const syncCaret = () => {
    setCaret(field.current?.selectionStart ?? null);
  };

  /** Passo 3: "@consulta" → "@Rótulo " e a menção guardada para o envio. */
  const pick = (candidate: MentionCandidateDto) => {
    if (query === null || caret === null) return;
    const next = insertMention(text, { start: query.start, end: caret }, candidate.label);
    persist(next.text);
    setMentions((previous) =>
      previous.some((item) => item.kind === candidate.kind && item.id === candidate.id)
        ? previous
        : [...previous, { kind: candidate.kind, id: candidate.id, label: candidate.label }],
    );
    setCaret(next.caret);
    setActive(0);
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      setDismissed(query.start);
      return;
    }
    if (listed && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current + step + options.length) % options.length);
      return;
    }
    if (
      listed &&
      (event.key === 'Enter' || event.key === 'Tab') &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      const candidate = options[current];
      if (candidate !== undefined) {
        event.preventDefault();
        pick(candidate);
        return;
      }
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    } else if (event.key === 'Escape' && props.onCancel) {
      event.preventDefault();
      props.onCancel();
    }
  };

  const length = textLength(text);
  const label =
    props.mode === 'edit' ? t('editLabel') : props.mode === 'reply' ? t('replyLabel') : t('label');
  const submitLabel =
    props.mode === 'edit' ? t('save') : props.mode === 'reply' ? t('reply') : t('submit');
  const sections = props.mode === 'create' ? (props.sections ?? []) : [];

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {props.isBudgetConfidential ? (
        <Alert tone="warning" live={false} title={t('confidentialHint')} />
      ) : null}
      <label htmlFor={fieldId} className="text-sm font-medium">
        {label}
      </label>
      <div role="toolbar" aria-label={t('toolbar')} aria-controls={fieldId} className="flex gap-1">
        {(['bold', 'italic', 'list', 'link'] as const).map((kind) => (
          <Button
            key={kind}
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              format(kind);
            }}
          >
            {t(kind)}
          </Button>
        ))}
      </div>
      <div className="relative">
        <textarea
          ref={field}
          id={fieldId}
          value={text}
          rows={props.mode === 'create' ? 4 : 3}
          placeholder={t('placeholder')}
          aria-describedby={hintId}
          aria-invalid={problem !== null && problem.key === 'length' ? true : undefined}
          aria-autocomplete="list"
          aria-controls={listed ? listboxId : undefined}
          aria-activedescendant={listed ? optionId(current) : undefined}
          className="w-full rounded-control border border-border bg-surface p-2 text-sm"
          onChange={(event) => {
            persist(event.target.value);
            setCaret(event.target.selectionStart);
            setActive(0);
            setDismissed(null);
          }}
          onSelect={syncCaret}
          onClick={syncCaret}
          onBlur={() => {
            setCaret(null);
          }}
          onKeyDown={onKeyDown}
        />
        {popover === null ? null : (
          <MentionAutocomplete
            processId={props.processId}
            listboxId={listboxId}
            optionId={optionId}
            state={popover}
            candidates={options}
            active={current}
            onHover={setActive}
            onPick={pick}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span id={hintId}>{t('hint')}</span>
        <span aria-live="polite" className={length > TEXT_MAX ? 'text-destructive' : undefined}>
          {t('counter', { count: length, max: TEXT_MAX })}
        </span>
      </div>
      {sections.length > 0 ? (
        <label className="flex flex-col gap-1 text-sm">
          <span>{t('section')}</span>
          <select
            value={sectionKey}
            className="rounded-control border border-border bg-surface p-2 text-sm"
            onChange={(event) => {
              setSectionKey(event.target.value);
            }}
          >
            <option value="">{t('noSection')}</option>
            {sections.map((section) => (
              <option key={section.key} value={section.key}>
                {section.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div aria-live="assertive">
        {problem ? (
          <Alert
            tone="error"
            title={t(`errors.${problem.key}`, { correlationId: problem.correlationId })}
          />
        ) : null}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {props.onCancel ? (
          <Button type="button" variant="secondary" size="sm" onClick={props.onCancel}>
            {t('cancel')}
          </Button>
        ) : null}
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? t('sending') : submitLabel}
        </Button>
      </div>
    </form>
  );
}
