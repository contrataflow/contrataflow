'use client';

import { useId, useState } from 'react';

import { Button } from './button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from './dialog.js';
import { diffParagraphs } from '../autosave/text-diff.js';
import { cx } from '../lib/cx.js';

/*
 * `ConflictDialog` (US-015 · DEC-182 · FA-01/FA-10): outra pessoa (ou a mesma, em outra aba) salvou a
 * seção antes. O autosave da seção fica pausado até a escolha: **Ver diferenças** (comparação lado a
 * lado, por parágrafo, com "inserido"/"removido" em texto — nunca só cor), **Manter a minha versão**
 * (reenvia sobre a revisão atual, gerando nova revisão) ou **Descartar a minha e recarregar** (fica
 * a do servidor; a pendência local é apagada). Foco preso; em tela cheia no celular.
 */

/** Diálogo em tela cheia abaixo de 640 px (DEC-182 · responsivo da US-015). */
export const FULL_SCREEN_ON_PHONE =
  'max-h-[100dvh] overflow-auto sm:max-w-3xl max-sm:top-0 max-sm:left-0 max-sm:h-[100dvh] max-sm:w-screen max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none';

export interface ConflictDialogLabels {
  readonly title: string;
  readonly changedBy: (name: string, time: string) => string;
  readonly changedBySelf: (time: string) => string;
  readonly description: string;
  readonly showDiff: string;
  readonly hideDiff: string;
  readonly keepMine: string;
  readonly discardMine: string;
  readonly serverColumn: string;
  readonly mineColumn: string;
  readonly inserted: string;
  readonly removed: string;
  readonly empty: string;
}

export const CONFLICT_DIALOG_LABELS: ConflictDialogLabels = {
  title: 'Esta seção foi alterada enquanto você editava',
  changedBy: (name, time) => `Alterado por ${name} às ${time}.`,
  changedBySelf: (time) => `Você mesma, em outra aba, às ${time}.`,
  description: 'Escolha qual versão manter. As demais seções continuam salvando normalmente.',
  showDiff: 'Ver diferenças',
  hideDiff: 'Ocultar diferenças',
  keepMine: 'Manter a minha versão',
  discardMine: 'Descartar a minha e recarregar',
  serverColumn: 'Versão salva no servidor',
  mineColumn: 'Minha versão',
  inserted: 'inserido',
  removed: 'removido',
  empty: '(vazio)',
};

export interface SectionDiffViewProps {
  readonly serverText: string;
  readonly localText: string;
  readonly labels?: Partial<ConflictDialogLabels> | undefined;
}

/** Comparação lado a lado: servidor (com o removido) × minha versão (com o inserido). */
export function SectionDiffView({
  serverText,
  localText,
  labels: overrides,
}: SectionDiffViewProps) {
  const labels = { ...CONFLICT_DIALOG_LABELS, ...overrides };
  const parts = diffParagraphs(serverText, localText);
  const column = (side: 'server' | 'mine') =>
    parts.filter(
      (part) => part.kind === 'same' || part.kind === (side === 'server' ? 'removed' : 'inserted'),
    );
  const renderColumn = (side: 'server' | 'mine', title: string) => (
    <section className="flex min-w-0 flex-col gap-1" aria-label={title}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="max-h-64 overflow-auto rounded-control border border-border p-2 text-sm">
        {column(side).length === 0 ? (
          <p className="text-muted-foreground">{labels.empty}</p>
        ) : (
          column(side).map((part, index) => (
            <p
              // A posição na comparação é a identidade estável do trecho.
              key={index}
              className={cx(
                'break-words whitespace-pre-wrap',
                part.kind === 'inserted' ? 'bg-success-soft' : undefined,
                part.kind === 'removed' ? 'bg-destructive-soft line-through' : undefined,
              )}
            >
              {part.kind === 'same' ? null : (
                <span className="mr-1 text-xs font-semibold uppercase">
                  [{part.kind === 'inserted' ? labels.inserted : labels.removed}]
                </span>
              )}
              {part.text === '' ? ' ' : part.text}
            </p>
          ))
        )}
      </div>
    </section>
  );
  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      {renderColumn('server', labels.serverColumn)}
      {renderColumn('mine', labels.mineColumn)}
    </div>
  );
}

export interface ConflictDialogProps {
  readonly open: boolean;
  /** Nome de quem salvou a versão do servidor (`null` = desconhecido). */
  readonly authorName: string | null;
  /** Horário já formatado da versão do servidor ("14:31"). */
  readonly time: string;
  /** A versão do servidor foi salva pela própria pessoa (outra aba — FA-10). */
  readonly isSelf?: boolean | undefined;
  /** Título da seção em conflito ("Justificativa da necessidade"). */
  readonly sectionTitle?: string | undefined;
  readonly serverText: string;
  readonly localText: string;
  readonly busy?: boolean | undefined;
  readonly onKeepMine: () => void;
  readonly onDiscardMine: () => void;
  readonly labels?: Partial<ConflictDialogLabels> | undefined;
}

export function ConflictDialog({
  open,
  authorName,
  time,
  isSelf = false,
  sectionTitle,
  serverText,
  localText,
  busy = false,
  onKeepMine,
  onDiscardMine,
  labels: overrides,
}: ConflictDialogProps) {
  const labels = { ...CONFLICT_DIALOG_LABELS, ...overrides };
  const [showDiff, setShowDiff] = useState(false);
  const diffId = useId();
  const who = isSelf
    ? labels.changedBySelf(time)
    : labels.changedBy(authorName ?? 'outra pessoa', time);
  return (
    <Dialog open={open}>
      <DialogContent
        closeLabel={null}
        className={FULL_SCREEN_ON_PHONE}
        onEscapeKeyDown={(event) => {
          // A escolha é obrigatória: o autosave da seção está pausado.
          event.preventDefault();
        }}
        onInteractOutside={(event) => {
          event.preventDefault();
        }}
      >
        <DialogTitle className="text-lg font-semibold">
          {sectionTitle === undefined ? labels.title : `${labels.title}: ${sectionTitle}`}
        </DialogTitle>
        <DialogDescription className="text-sm text-muted-foreground">
          {who} {labels.description}
        </DialogDescription>
        <div>
          <Button
            variant="secondary"
            size="sm"
            aria-expanded={showDiff}
            aria-controls={diffId}
            onClick={() => {
              setShowDiff((value) => !value);
            }}
          >
            {showDiff ? labels.hideDiff : labels.showDiff}
          </Button>
        </div>
        <div id={diffId} hidden={!showDiff}>
          {showDiff ? (
            <SectionDiffView serverText={serverText} localText={localText} labels={overrides} />
          ) : null}
        </div>
        <DialogFooter className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={onDiscardMine}>
            {labels.discardMine}
          </Button>
          <Button variant="primary" disabled={busy} onClick={onKeepMine}>
            {labels.keepMine}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
