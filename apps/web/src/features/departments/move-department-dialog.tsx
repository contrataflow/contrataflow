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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contrataflow/ui';
import type { DepartmentDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

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
        <Field label={t('move.target')}>
          <Select value={choice} onValueChange={setChoice}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {canGoRoot ? <SelectItem value={ROOT}>{t('form.root')}</SelectItem> : null}
              {targets.map((target) => (
                <SelectItem key={target.id} value={target.id}>
                  {`${'— '.repeat(target.depth)}${target.name}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
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
