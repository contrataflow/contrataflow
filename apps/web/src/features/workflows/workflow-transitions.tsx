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
import type {
  WorkflowStageDto,
  WorkflowTransitionDto,
  WorkflowVersionDetailDto,
} from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { outcomeOf } from './workflow-editor-errors';
import type { EditorProblem } from './workflow-editor-errors';
import {
  EDITOR_TRANSITION_ACTIONS,
  EMPTY_TRANSITION,
  isEditorAction,
  keyFromName,
  transitionCreateBody,
  transitionDraftOf,
  transitionDraftProblems,
  transitionPatch,
  uniqueKey,
  withForcedComment,
} from './workflow-editor-model';
import type { FieldProblem, TransitionDraft } from './workflow-editor-model';
import { createTransition, deleteTransition, updateTransition } from './workflows.api';

const INPUT = 'h-10 w-full rounded-control border border-border bg-surface px-3 text-sm';

/**
 * Aba "Transições" (SCR-034 · US-043 passo 6): `TransitionList` com origem → destino, ação, ação
 * principal e exigência de comentário, e o `TransitionForm` (WF-13/14) — só `FORWARD`/`RETURN`/
 * `COMPLETE`; `APPROVE`/`REJECT` vêm das etapas de aprovação e ficam só leitura. Excluir (WF-15) é
 * bloqueado enquanto houver regra na transição (RN-WF-50).
 */
export function TransitionsSection({
  version,
  stages,
  readOnly,
  onSaved,
  onDeleted,
  onProblem,
}: {
  readonly version: WorkflowVersionDetailDto;
  readonly stages: readonly WorkflowStageDto[];
  readonly readOnly: boolean;
  readonly onSaved: (transition: WorkflowTransitionDto) => void;
  readonly onDeleted: (transitionId: string) => void;
  readonly onProblem: (problem: EditorProblem) => void;
}) {
  const t = useTranslations('workflows.editor');
  const ids = useId();
  const [editing, setEditing] = useState<WorkflowTransitionDto | 'new' | null>(null);
  const [blocked, setBlocked] = useState<{ name: string; items: readonly string[] } | null>(null);
  const stageName = (id: string) => stages.find((stage) => stage.id === id)?.name ?? '—';
  const transitions = [...version.transitions].sort(
    (a, b) => a.displayOrder - b.displayOrder || a.key.localeCompare(b.key),
  );

  const remove = useMutation({
    mutationFn: (transition: WorkflowTransitionDto) => deleteTransition(transition),
    onSuccess: (_result, transition) => {
      setBlocked(null);
      onDeleted(transition.id);
    },
    onError: (error, transition) => {
      const outcome = outcomeOf(error);
      if (outcome.kind === 'blocked') {
        setBlocked({ name: transition.name, items: outcome.items.map((item) => item.name) });
      } else if (outcome.kind === 'screen') {
        onProblem(outcome.problem);
      } else {
        onProblem({ kind: 'generic', message: null });
      }
    },
  });

  return (
    <section aria-labelledby={`${ids}-title`} className="flex flex-col gap-3 pt-2">
      <h2 id={`${ids}-title`} className="sr-only">
        {t('tabs.transitions')}
      </h2>
      {readOnly ? null : (
        <div>
          <Button
            disabled={stages.length < 2}
            aria-describedby={stages.length < 2 ? `${ids}-need-stages` : undefined}
            onClick={() => {
              setEditing('new');
            }}
          >
            {t('transitions.add')}
          </Button>
          {stages.length < 2 ? (
            <p id={`${ids}-need-stages`} className="mt-1 text-xs text-muted-foreground">
              {t('transitions.needStages')}
            </p>
          ) : null}
        </div>
      )}
      <div aria-live="assertive">
        {blocked ? (
          <Alert tone="error" title={t('transitions.blocked', { name: blocked.name })}>
            <ul className="mt-1 list-disc pl-5">
              {blocked.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
      </div>
      {transitions.length === 0 ? (
        <p className="rounded-card border border-dashed border-border p-6 text-muted-foreground">
          {t('transitions.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('transitions.caption')}>
          {transitions.map((transition) => (
            <li
              key={transition.id}
              className="flex flex-col gap-2 rounded-card border border-border bg-surface p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{transition.name}</span>
                  <span className="rounded-control bg-muted px-2 py-0.5 text-xs">
                    {t(`actions.${transition.action}`)}
                  </span>
                  {transition.isPrimary ? (
                    <span className="rounded-control bg-primary-soft px-2 py-0.5 text-xs">
                      {t('transitions.primary')}
                    </span>
                  ) : null}
                  {transition.requiresComment ? (
                    <span className="rounded-control bg-muted px-2 py-0.5 text-xs">
                      {t('transitions.comment')}
                    </span>
                  ) : null}
                </div>
                <p className="text-sm text-muted-foreground">
                  {t('transitions.route', {
                    from: stageName(transition.fromStageId),
                    to: stageName(transition.toStageId),
                  })}
                </p>
              </div>
              {readOnly ? null : (
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={t('transitions.editFor', { name: transition.name })}
                    onClick={() => {
                      setEditing(transition);
                    }}
                  >
                    {t('transitions.edit')}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={remove.isPending}
                    aria-label={t('transitions.deleteFor', { name: transition.name })}
                    onClick={() => {
                      remove.mutate(transition);
                    }}
                  >
                    {t('transitions.delete')}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent closeLabel={t('transitions.cancel')}>
          <DialogTitle>
            {editing === 'new' || editing === null
              ? t('transitions.newTitle')
              : t('transitions.editTitle', { name: editing.name })}
          </DialogTitle>
          <DialogDescription>{t('transitions.formHint')}</DialogDescription>
          {editing ? (
            <TransitionForm
              key={editing === 'new' ? 'new' : editing.id}
              versionId={version.id}
              transition={editing === 'new' ? null : editing}
              transitions={version.transitions}
              stages={stages}
              onSaved={(saved) => {
                onSaved(saved);
                setEditing(null);
              }}
              onProblem={(problem) => {
                setEditing(null);
                onProblem(problem);
              }}
              onCancel={() => {
                setEditing(null);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** `TransitionForm`: valida no front (V-01/V-05) e envia WF-13 (nova) ou WF-14 (só o que mudou). */
function TransitionForm({
  versionId,
  transition,
  transitions,
  stages,
  onSaved,
  onProblem,
  onCancel,
}: {
  readonly versionId: string;
  readonly transition: WorkflowTransitionDto | null;
  readonly transitions: readonly WorkflowTransitionDto[];
  readonly stages: readonly WorkflowStageDto[];
  readonly onSaved: (transition: WorkflowTransitionDto) => void;
  readonly onProblem: (problem: EditorProblem) => void;
  readonly onCancel: () => void;
}) {
  const t = useTranslations('workflows.editor');
  const ids = useId();
  const [draft, setDraft] = useState<TransitionDraft>(() =>
    transition ? transitionDraftOf(transition) : EMPTY_TRANSITION,
  );
  const [keyTouched, setKeyTouched] = useState(transition !== null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  // Transição automática de aprovação (APPROVE/REJECT): só nome e opções.
  const automatic = transition !== null && !isEditorAction(transition.action);

  const label = (field: string) => t(`transitionFields.${field as keyof TransitionDraft}`);
  const messageOf = (problem: FieldProblem) =>
    problem.code === 'REQUIRED'
      ? t('validation.required', { field: label(problem.field) })
      : problem.code === 'KEY_PATTERN'
        ? t('validation.keyPattern')
        : problem.code === 'NAME_LENGTH'
          ? t('validation.nameLength')
          : (problem.message ?? t('validation.invalid'));

  const save = useMutation({
    mutationFn: async (next: TransitionDraft) => {
      if (!transition) {
        const order = transitions.reduce((max, item) => Math.max(max, item.displayOrder + 1), 0);
        return (await createTransition(versionId, transitionCreateBody(next, order))).data;
      }
      const patch = transitionPatch(transition, automatic ? { ...next, action: 'FORWARD' } : next);
      if (automatic) delete (patch as { action?: unknown }).action;
      if (Object.keys(patch).length === 0) return transition;
      return (await updateTransition(transition, patch)).data;
    },
    onSuccess: onSaved,
    onError: (error) => {
      const outcome = outcomeOf(error);
      if (outcome.kind === 'fields') {
        setErrors(Object.fromEntries(outcome.errors.map((item) => [item.field, item.message])));
      } else if (outcome.kind === 'keyTaken') {
        setErrors({ key: t('validation.keyTaken') });
      } else if (outcome.kind === 'rule') {
        setFormError(outcome.message);
      } else if (outcome.kind === 'screen') {
        onProblem(outcome.problem);
      } else {
        setFormError(t('problems.generic'));
      }
    },
  });

  const change = (patch: Partial<TransitionDraft>) => {
    setDraft((current) => withForcedComment({ ...current, ...patch }));
  };

  const onSubmit = () => {
    setFormError(null);
    const found = Object.fromEntries(
      transitionDraftProblems(draft).map((problem) => [problem.field, messageOf(problem)]),
    );
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    save.mutate(draft);
  };

  const errorId = (field: string) => `${ids}-${field}-error`;
  const field = (name: string, control: ReactNode, hint?: string) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${ids}-${name}`} className="text-sm font-medium">
        {label(name)}
      </label>
      {control}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {errors[name] ? (
        <p id={errorId(name)} className="text-sm text-destructive">
          {errors[name]}
        </p>
      ) : null}
    </div>
  );
  const props = (name: string) => ({
    id: `${ids}-${name}`,
    'aria-invalid': errors[name] ? true : undefined,
    'aria-describedby': errors[name] ? errorId(name) : undefined,
  });
  const stageSelect = (name: 'fromStageId' | 'toStageId') =>
    field(
      name,
      <select
        {...props(name)}
        className={INPUT}
        value={draft[name]}
        onChange={(event) => {
          change({ [name]: event.target.value });
        }}
      >
        <option value="">{t('values.select')}</option>
        {stages.map((stage) => (
          <option key={stage.id} value={stage.id}>
            {stage.name}
          </option>
        ))}
      </select>,
    );

  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {field(
        'name',
        <input
          {...props('name')}
          className={INPUT}
          value={draft.name}
          maxLength={150}
          onChange={(event) => {
            const name = event.target.value;
            if (keyTouched) change({ name });
            else {
              const used = new Set(transitions.map((item) => item.key));
              change({ name, key: uniqueKey(keyFromName(name), used) });
            }
          }}
        />,
      )}
      {field(
        'key',
        <input
          {...props('key')}
          className={`${INPUT} font-mono`}
          value={draft.key}
          maxLength={60}
          readOnly={transition !== null}
          onChange={(event) => {
            setKeyTouched(true);
            change({ key: event.target.value.toUpperCase() });
          }}
        />,
        transition ? t('hints.keyImmutable') : t('hints.key'),
      )}
      {stageSelect('fromStageId')}
      {stageSelect('toStageId')}
      {automatic ? (
        <p className="text-sm">
          {label('action')}: <strong>{t(`actions.${transition.action}`)}</strong>{' '}
          <span className="text-muted-foreground">{t('transitions.automatic')}</span>
        </p>
      ) : (
        field(
          'action',
          <select
            {...props('action')}
            className={INPUT}
            value={draft.action}
            onChange={(event) => {
              change({ action: event.target.value as TransitionDraft['action'] });
            }}
          >
            {EDITOR_TRANSITION_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {t(`actions.${action}`)}
              </option>
            ))}
          </select>,
        )
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.isPrimary}
          onChange={(event) => {
            change({ isPrimary: event.target.checked });
          }}
        />
        {label('isPrimary')}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.requiresComment}
          disabled={draft.action === 'RETURN'}
          aria-describedby={draft.action === 'RETURN' ? `${ids}-comment-hint` : undefined}
          onChange={(event) => {
            change({ requiresComment: event.target.checked });
          }}
        />
        {label('requiresComment')}
      </label>
      {draft.action === 'RETURN' ? (
        <p id={`${ids}-comment-hint`} className="text-xs text-muted-foreground">
          {t('hints.returnComment')}
        </p>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.allowDueDateOverride}
          onChange={(event) => {
            change({ allowDueDateOverride: event.target.checked });
          }}
        />
        {label('allowDueDateOverride')}
      </label>
      <div aria-live="assertive">{formError ? <Alert tone="error" title={formError} /> : null}</div>
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('transitions.cancel')}
        </Button>
        <Button type="submit" disabled={save.isPending} aria-busy={save.isPending}>
          {transition ? t('transitions.save') : t('transitions.create')}
        </Button>
      </DialogFooter>
    </form>
  );
}
