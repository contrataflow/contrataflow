'use client';

import { useState } from 'react';

import { Button } from './button.js';
import { FULL_SCREEN_ON_PHONE } from './conflict-dialog.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from './dialog.js';

/*
 * `HeaderConflictDialog` (US-015 · FA-02 · RN-DFD-28): o merge automático do cabeçalho encontrou
 * campos alterados pelos dois lados. Para cada campo, a pessoa escolhe "Minha alteração" ou
 * "Alteração de {nome} às HH:mm"; os demais campos já foram mesclados sem perguntar. Grupo de
 * opções nativo por campo (teclado e leitor de tela), foco preso, tela cheia no celular.
 */

export type HeaderChoice = 'mine' | 'theirs';

export interface HeaderConflictField {
  readonly field: string;
  readonly label: string;
  /** Valores já formatados para leitura. */
  readonly mine: string;
  readonly theirs: string;
}

export interface HeaderConflictDialogLabels {
  readonly title: string;
  readonly description: (fields: string) => string;
  readonly mine: string;
  readonly theirs: (name: string, time: string) => string;
  readonly confirm: string;
}

export const HEADER_CONFLICT_DIALOG_LABELS: HeaderConflictDialogLabels = {
  title: 'Outra pessoa alterou os mesmos campos',
  description: (fields) => `Outra pessoa alterou ${fields}. Escolha qual valor manter.`,
  mine: 'Minha alteração',
  theirs: (name, time) => `Alteração de ${name} às ${time}`,
  confirm: 'Salvar escolhas',
};

export interface HeaderConflictDialogProps {
  readonly open: boolean;
  readonly fields: readonly HeaderConflictField[];
  readonly authorName: string | null;
  readonly time: string;
  readonly busy?: boolean | undefined;
  readonly onResolve: (choices: Readonly<Record<string, HeaderChoice>>) => void;
  readonly labels?: Partial<HeaderConflictDialogLabels> | undefined;
}

export function HeaderConflictDialog({
  open,
  fields,
  authorName,
  time,
  busy = false,
  onResolve,
  labels: overrides,
}: HeaderConflictDialogProps) {
  const labels = { ...HEADER_CONFLICT_DIALOG_LABELS, ...overrides };
  const [choices, setChoices] = useState<Record<string, HeaderChoice>>({});
  const theirs = labels.theirs(authorName ?? 'outra pessoa', time);
  const resolved = fields.every((field) => choices[field.field] !== undefined);
  return (
    <Dialog open={open}>
      <DialogContent
        closeLabel={null}
        className={FULL_SCREEN_ON_PHONE}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
        }}
        onInteractOutside={(event) => {
          event.preventDefault();
        }}
      >
        <DialogTitle>{labels.title}</DialogTitle>
        <DialogDescription className="text-sm text-muted-foreground">
          {labels.description(fields.map((field) => field.label).join(', '))}
        </DialogDescription>
        <div className="flex flex-col gap-4">
          {fields.map((field) => (
            <fieldset key={field.field} className="rounded-control border border-border p-3">
              <legend className="px-1 text-sm font-semibold">{field.label}</legend>
              {(['mine', 'theirs'] as const).map((choice) => (
                <label key={choice} className="flex items-start gap-2 py-1 text-sm">
                  <input
                    type="radio"
                    name={`header-conflict-${field.field}`}
                    value={choice}
                    checked={choices[field.field] === choice}
                    onChange={() => {
                      setChoices((previous) => ({ ...previous, [field.field]: choice }));
                    }}
                  />
                  <span>
                    <span className="font-medium">{choice === 'mine' ? labels.mine : theirs}:</span>{' '}
                    <span className="break-words">
                      {choice === 'mine' ? field.mine : field.theirs}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
        <DialogFooter className="flex justify-end">
          <Button
            variant="primary"
            disabled={busy || !resolved}
            onClick={() => {
              onResolve(choices);
            }}
          >
            {labels.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
