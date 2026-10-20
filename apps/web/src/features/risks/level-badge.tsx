import { cx } from '@contrataflow/ui';
import { RISK_LEVEL_LABELS } from '@contrataflow/validation';
import type { RiskLevel } from '@contrataflow/validation';

/*
 * Cor por nível de risco (DEC-021): Baixo verde, Médio âmbar, Alto vermelho suave, Extremo vermelho
 * sólido. A cor nunca é a única pista (SCR-011 · "Acessibilidade"): o texto do nível vem sempre
 * junto e o Extremo ainda ganha um marcador "!" para diferenciar do Alto sem depender da cor.
 */
export const LEVEL_CLASSES: Readonly<Record<RiskLevel, string>> = Object.freeze({
  LOW: 'border-success bg-success-soft text-success',
  MEDIUM: 'border-warning bg-warning-soft text-warning',
  HIGH: 'border-destructive bg-destructive-soft text-destructive',
  EXTREME: 'border-destructive bg-destructive text-destructive-foreground',
});

export interface LevelBadgeProps {
  readonly level: RiskLevel;
  /** Escore ao lado do nível ("Alto · 12"). */
  readonly score?: number | undefined;
  readonly className?: string | undefined;
}

/** `LevelBadge` (US-033): nível de risco com cor e texto. */
export function LevelBadge({ level, score, className }: LevelBadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-control border px-2 py-0.5 text-xs font-semibold whitespace-nowrap',
        LEVEL_CLASSES[level],
        className,
      )}
    >
      {level === 'EXTREME' ? <span aria-hidden="true">!</span> : null}
      {RISK_LEVEL_LABELS[level]}
      {score === undefined ? null : <span className="font-normal"> · {score}</span>}
    </span>
  );
}
