'use client';

import {
  Alert,
  Button,
  Checkbox,
  Field,
  InfoTooltip,
  Input,
  Label,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  StatusChip,
  Table,
  TableBody,
  TableContainer,
  TableHead,
  Td,
  Th,
  Tr,
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

import { OptionSelect } from './option-select';
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

/**
 * Aba "Transições" (SCR-034 · US-043 passo 6): `TransitionList` com origem → destino, ação, ação
 * principal e exigência de comentário, e o `TransitionForm` (WF-13/14) num painel lateral — só
 * `FORWARD`/`RETURN`/`COMPLETE`; `APPROVE`/`REJECT` vêm das etapas de aprovação e ficam só leitura.
 * Excluir (WF-15) é bloqueado enquanto houver regra na transição (RN-WF-50). "Adicionar transição"
 * é a ação primária da faixa do editor: quem a usa controla o painel por `editing`.
 */
export function TransitionsSection({
  version,
  stages,
  readOnly,
  editing,
  onEditingChange,
  needStagesId,
  onSaved,
  onDeleted,
  onProblem,
}: {
  readonly version: WorkflowVersionDetailDto;
  readonly stages: readonly WorkflowStageDto[];
  readonly readOnly: boolean;
  /** Transição aberta no painel: a própria, `'new'` (nova) ou `null`. */
  readonly editing: WorkflowTransitionDto | 'new' | null;
  readonly onEditingChange: (editing: WorkflowTransitionDto | 'new' | null) => void;
  /** `id` do texto "Crie ao menos duas etapas", ligado ao botão de adicionar. */
  readonly needStagesId: string;
  readonly onSaved: (transition: WorkflowTransitionDto) => void;
  readonly onDeleted: (transitionId: string) => void;
  readonly onProblem: (problem: EditorProblem) => void;
}) {
  const t = useTranslations('workflows.editor');
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
    <section aria-label={t('tabs.transitions')} className="flex flex-col gap-4">
      {!readOnly && stages.length < 2 ? (
        <p id={needStagesId} className="text-sm text-muted-foreground">
          {t('transitions.needStages')}
        </p>
      ) : null}
      <div aria-live="assertive" className="empty:hidden">
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
        <p className="rounded-card border border-dashed border-border-strong bg-surface p-6 text-center text-muted-foreground">
          {t('transitions.empty')}
        </p>
      ) : (
        <TableContainer label={t('transitions.caption')}>
          <Table>
            <caption className="sr-only">{t('transitions.caption')}</caption>
            <TableHead>
              <tr>
                <Th>{t('transitions.columns.name')}</Th>
                <Th>{t('transitions.columns.route')}</Th>
                {readOnly ? null : (
                  <Th className="text-right">{t('transitions.columns.actions')}</Th>
                )}
              </tr>
            </TableHead>
            <TableBody>
              {transitions.map((transition) => (
                <Tr key={transition.id}>
                  <Td>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-brand-ink">{transition.name}</span>
                      <StatusChip>{t(`actions.${transition.action}`)}</StatusChip>
                      {transition.isPrimary ? (
                        <StatusChip tone="info">{t('transitions.primary')}</StatusChip>
                      ) : null}
                      {transition.requiresComment ? (
                        <StatusChip>{t('transitions.comment')}</StatusChip>
                      ) : null}
                    </div>
                  </Td>
                  <Td className="text-muted-foreground">
                    {t('transitions.route', {
                      from: stageName(transition.fromStageId),
                      to: stageName(transition.toStageId),
                    })}
                  </Td>
                  {readOnly ? null : (
                    <Td>
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          aria-label={t('transitions.editFor', { name: transition.name })}
                          onClick={() => {
                            onEditingChange(transition);
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
                    </Td>
                  )}
                </Tr>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <Sheet
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) onEditingChange(null);
        }}
      >
        <SheetContent closeLabel={t('panel.close')}>
          {editing ? (
            <TransitionForm
              key={editing === 'new' ? 'new' : editing.id}
              versionId={version.id}
              transition={editing === 'new' ? null : editing}
              transitions={version.transitions}
              stages={stages}
              onSaved={(saved) => {
                onSaved(saved);
                onEditingChange(null);
              }}
              onProblem={(problem) => {
                onEditingChange(null);
                onProblem(problem);
              }}
              onCancel={() => {
                onEditingChange(null);
              }}
            />
          ) : null}
        </SheetContent>
      </Sheet>
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

  const field = (name: string, control: ReactNode, help?: string) => (
    <Field
      label={label(name)}
      id={`${ids}-${name}`}
      error={errors[name]}
      labelAddon={
        help ? (
          <InfoTooltip label={t('helpLabel', { field: label(name) })}>{help}</InfoTooltip>
        ) : null
      }
    >
      {control}
    </Field>
  );
  const stageSelect = (name: 'fromStageId' | 'toStageId') =>
    field(
      name,
      <OptionSelect
        value={draft[name]}
        noneLabel={t('values.select')}
        options={stages.map((stage) => ({ value: stage.id, label: stage.name }))}
        onValueChange={(value) => {
          change({ [name]: value });
        }}
      />,
    );
  const option = (
    name: 'isPrimary' | 'requiresComment' | 'allowDueDateOverride',
    extra?: { disabled?: boolean | undefined; help?: string | undefined },
  ) => (
    <div className="flex items-center gap-2">
      <Checkbox
        id={`${ids}-${name}`}
        checked={draft[name]}
        disabled={extra?.disabled}
        onCheckedChange={(checked) => {
          change({ [name]: checked === true });
        }}
      />
      <Label htmlFor={`${ids}-${name}`} className="font-normal">
        {label(name)}
      </Label>
      {extra?.help ? (
        <InfoTooltip label={t('helpLabel', { field: label(name) })}>{extra.help}</InfoTooltip>
      ) : null}
    </div>
  );

  return (
    <form
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <SheetHeader>
        <SheetTitle>
          {transition
            ? t('transitions.editTitle', { name: transition.name })
            : t('transitions.newTitle')}
        </SheetTitle>
        <SheetDescription>{t('transitions.formHint')}</SheetDescription>
      </SheetHeader>
      <SheetBody>
        {field(
          'name',
          <Input
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
          <Input
            className="font-mono"
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
            <OptionSelect
              value={draft.action}
              options={EDITOR_TRANSITION_ACTIONS.map((action) => ({
                value: action,
                label: t(`actions.${action}`),
              }))}
              onValueChange={(value) => {
                change({ action: value as TransitionDraft['action'] });
              }}
            />,
          )
        )}
        {option('isPrimary')}
        {option('requiresComment', {
          disabled: draft.action === 'RETURN',
          help: draft.action === 'RETURN' ? t('hints.returnComment') : undefined,
        })}
        {option('allowDueDateOverride')}
        <div aria-live="assertive" className="empty:hidden">
          {formError ? <Alert tone="error" title={formError} /> : null}
        </div>
      </SheetBody>
      <SheetFooter>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('transitions.cancel')}
        </Button>
        <Button type="submit" disabled={save.isPending} aria-busy={save.isPending}>
          {transition ? t('transitions.save') : t('transitions.create')}
        </Button>
      </SheetFooter>
    </form>
  );
}
