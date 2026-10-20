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
import type { DepartmentDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { moveTargets } from './department-tree-model';

const ROOT = '__root__';

export interface MoveDepartmentDialogProps {
  /** Unidade a mover; `null` = fechado. */
  readonly department: DepartmentDto | null;
  readonly departments: readonly DepartmentDto[];
  readonly pending: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  /** `null` = primeiro nível do órgão. */
  readonly onConfirm: (department: DepartmentDto, parentId: string | null) => void;
}

/**
 * `MoveDepartmentDialog` (SCR-032 · US-102 · passo 7): alternativa acessível ao arrastar. Oferece
 * só destinos válidos — unidades ativas do órgão fora da subárvore da própria unidade (RN-TEN-46)
 * — e o primeiro nível do órgão; a API confere de novo (ciclo → `DEPARTMENT_CYCLE`).
 */
export function MoveDepartmentDialog({
  department,
  departments,
  pending,
  error,
  onCancel,
  onConfirm,
}: MoveDepartmentDialogProps) {
  return (
    <Dialog
      open={department !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent>
        {department ? (
          <MoveBody
            key={department.id}
            department={department}
            departments={departments}
            pending={pending}
            error={error}
            onCancel={onCancel}
            onConfirm={onConfirm}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function MoveBody({
  department,
  departments,
  pending,
  error,
  onCancel,
  onConfirm,
}: Omit<MoveDepartmentDialogProps, 'department'> & { readonly department: DepartmentDto }) {
  const t = useTranslations('departments');
  const selectId = useId();
  const targets = moveTargets(departments, department);
  const canGoRoot = department.parentId !== null;
  const [choice, setChoice] = useState<string>(canGoRoot ? ROOT : (targets[0]?.id ?? ''));
  const nothing = targets.length === 0 && !canGoRoot;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (choice !== '') onConfirm(department, choice === ROOT ? null : choice);
      }}
    >
      <DialogTitle>{t('move.title', { name: department.name })}</DialogTitle>
      <DialogDescription>{t('move.description')}</DialogDescription>
      {error ? <Alert tone="error" title={error} /> : null}
      {nothing ? (
        <p className="text-sm text-muted-foreground">{t('move.noTargets')}</p>
      ) : (
        <div className="flex flex-col gap-1">
          <label htmlFor={selectId} className="text-sm font-medium">
            {t('move.target')}
          </label>
          <select
            id={selectId}
            className="h-10 rounded-control border border-border bg-surface px-3 text-sm"
            value={choice}
            onChange={(event) => {
              setChoice(event.target.value);
            }}
          >
            {canGoRoot ? <option value={ROOT}>{t('form.root')}</option> : null}
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {`${'— '.repeat(target.depth)}${target.name}`}
              </option>
            ))}
          </select>
        </div>
      )}
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('move.cancel')}
        </Button>
        <Button type="submit" disabled={pending || nothing} aria-busy={pending}>
          {t('move.submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}
