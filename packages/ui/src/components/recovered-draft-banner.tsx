import { Alert } from './alert.js';
import { Button } from './button.js';

/*
 * `RecoveredDraftBanner` (US-015 · FA-07/FA-08 · fluxo principal 9): há alterações locais pendentes
 * desta pessoa neste documento (contingência cifrada da aba). "Restaurar" reaplica — salvando sobre a
 * revisão atual só se a revisão-base for a mesma; senão abre o diálogo de conflito —; "Descartar"
 * apaga a pendência local.
 */

export interface RecoveredDraftBannerLabels {
  readonly title: (time: string) => string;
  readonly restore: string;
  readonly discard: string;
}

export const RECOVERED_DRAFT_BANNER_LABELS: RecoveredDraftBannerLabels = {
  title: (time) => `Recuperamos alterações não salvas de ${time}.`,
  restore: 'Restaurar',
  discard: 'Descartar',
};

export interface RecoveredDraftBannerProps {
  /** Horário já formatado da pendência mais recente ("14:32"). */
  readonly time: string;
  readonly busy?: boolean | undefined;
  readonly onRestore: () => void;
  readonly onDiscard: () => void;
  readonly labels?: Partial<RecoveredDraftBannerLabels> | undefined;
}

export function RecoveredDraftBanner({
  time,
  busy = false,
  onRestore,
  onDiscard,
  labels: overrides,
}: RecoveredDraftBannerProps) {
  const labels = { ...RECOVERED_DRAFT_BANNER_LABELS, ...overrides };
  return (
    <Alert tone="warning" title={labels.title(time)}>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={busy} onClick={onRestore}>
          {labels.restore}
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={onDiscard}>
          {labels.discard}
        </Button>
      </div>
    </Alert>
  );
}
