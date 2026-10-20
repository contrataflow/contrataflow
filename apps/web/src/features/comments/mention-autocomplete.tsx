'use client';

import type { MentionCandidateDto } from '@contrataflow/validation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

/*
 * `MentionAutocomplete` (US-072 · fluxo principal, passos 2–3 · FA-05): popover do "@" no
 * compositor — `role="listbox"` com as opções (`role="option"`), a ativa apontada pelo
 * `aria-activedescendant` do campo (setas, `Enter`/`Tab` escolhem, `Esc` fecha — teclado tratado pelo
 * compositor). Estados: carregando, vazio (`NoCandidatesFound`, com o atalho para Participantes) e
 * erro (o "@algo" segue como texto, sem bloquear a digitação). Ocupa a largura do compositor.
 */

export interface MentionAutocompleteProps {
  readonly processId: string;
  readonly listboxId: string;
  readonly optionId: (index: number) => string;
  readonly state: 'loading' | 'error' | 'ready';
  readonly candidates: readonly MentionCandidateDto[];
  readonly active: number;
  readonly onHover: (index: number) => void;
  readonly onPick: (candidate: MentionCandidateDto) => void;
}

/** FA-05: ninguém com visibilidade encontrado — dar acesso é em Participantes (US-012). */
export function NoCandidatesFound({ processId }: { readonly processId: string }) {
  const t = useTranslations('comments.mentions');
  return (
    <p className="p-3 text-sm text-muted-foreground">
      {t('empty')}{' '}
      <Link
        href={`/processos/${processId}?aba=participantes`}
        className="text-primary underline focus-visible:outline-2"
      >
        {t('addParticipant')}
      </Link>
    </p>
  );
}

export function MentionAutocomplete({
  processId,
  listboxId,
  optionId,
  state,
  candidates,
  active,
  onHover,
  onPick,
}: MentionAutocompleteProps) {
  const t = useTranslations('comments.mentions');
  const frame =
    'absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-card border border-border bg-surface shadow-md';
  if (state === 'loading') {
    return (
      <div className={frame} role="status" aria-live="polite">
        <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
          <span
            aria-hidden="true"
            className="size-4 animate-spin rounded-full border-2 border-border border-t-primary"
          />
          {t('loading')}
        </p>
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div className={frame} role="status" aria-live="polite">
        <p className="p-3 text-sm text-muted-foreground">{t('failed')}</p>
      </div>
    );
  }
  if (candidates.length === 0) {
    return (
      <div className={frame} role="status" aria-live="polite">
        <NoCandidatesFound processId={processId} />
      </div>
    );
  }
  return (
    <div id={listboxId} role="listbox" aria-label={t('listLabel')} className={`${frame} p-1`}>
      {candidates.map((candidate, index) => (
        <div
          key={`${candidate.kind}:${candidate.id}`}
          id={optionId(index)}
          role="option"
          tabIndex={-1}
          aria-selected={index === active}
          className={`flex min-h-11 cursor-pointer flex-col justify-center rounded-control px-2 text-sm md:min-h-9 ${
            index === active ? 'bg-muted' : 'hover:bg-muted'
          }`}
          onMouseEnter={() => {
            onHover(index);
          }}
          onMouseDown={(event) => {
            // Mantém o foco no campo (o clique não pode tirar o cursor do texto).
            event.preventDefault();
            onPick(candidate);
          }}
        >
          <span className="font-medium">
            {candidate.label}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {candidate.kind === 'DEPARTMENT' ? t('department') : t('user')}
            </span>
          </span>
          {candidate.secondaryLabel === undefined ? null : (
            <span className="text-xs text-muted-foreground">{candidate.secondaryLabel}</span>
          )}
        </div>
      ))}
    </div>
  );
}
