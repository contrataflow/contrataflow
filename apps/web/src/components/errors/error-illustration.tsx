import {
  FileSearch,
  Hourglass,
  Lock,
  ShieldCheck,
  TriangleAlert,
  UserX,
  Wrench,
} from '@contrataflow/ui';
import type { IconComponent } from '@contrataflow/ui';

/** Motivo ilustrado na página de erro (SCR-111): um desenho por família de variante. */
export type ErrorIllustrationKind =
  'not-found' | 'forbidden' | 'failure' | 'maintenance' | 'session' | 'membership' | 'confirmation';

const ICONS: Readonly<Record<ErrorIllustrationKind, IconComponent>> = {
  'not-found': FileSearch,
  forbidden: Lock,
  failure: TriangleAlert,
  maintenance: Wrench,
  session: Hourglass,
  membership: UserX,
  confirmation: ShieldCheck,
};

/**
 * Ilustração neutra das páginas de erro (prd-5 · card 10): SVG inline com os tokens do tema
 * (claro e escuro) — um cartão suave com o ícone do motivo, sombra e dois pontos. Decorativa: o
 * título da página é que diz o que aconteceu.
 */
export function ErrorIllustration({ kind }: { readonly kind: ErrorIllustrationKind }) {
  const Icon = ICONS[kind];
  return (
    <span aria-hidden="true" className="relative inline-grid h-28 w-40 place-items-center">
      <svg viewBox="0 0 160 112" className="absolute inset-0 size-full">
        <ellipse cx="80" cy="104" rx="50" ry="5" className="fill-muted" />
        <rect x="38" y="10" width="84" height="84" rx="24" className="fill-primary-soft" />
        <rect
          x="50"
          y="22"
          width="60"
          height="60"
          rx="16"
          className="fill-surface stroke-border"
          strokeWidth="1.5"
        />
        <circle cx="134" cy="24" r="6" className="fill-muted" />
        <circle cx="24" cy="78" r="4" className="fill-muted" />
        <circle cx="140" cy="70" r="3" className="fill-primary-soft" />
      </svg>
      <Icon className="relative -mt-2 size-9 text-primary-soft-foreground" strokeWidth={1.75} />
    </span>
  );
}
