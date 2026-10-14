import { cx } from '@contrataflow/ui';

/** Marca do ContrataFlow (três faixas em perspectiva); decorativa — o nome vem ao lado. */
export function BrandMark({ className }: { readonly className?: string | undefined }) {
  return (
    <svg
      viewBox="0 0 40 40"
      aria-hidden="true"
      focusable="false"
      className={cx('size-10', className)}
    >
      <path d="M8 6 L22 6 L32 16 L18 16 Z" fill="#3b82f6" />
      <path d="M8 17 L22 17 L32 27 L18 27 Z" fill="#60a5fa" />
      <path d="M8 28 L18 28 L22 34 L12 34 Z" fill="#2563eb" />
    </svg>
  );
}

/** Marca + nome. O nome é texto real (a marca é decorativa). */
export function BrandLogo({
  name,
  className,
  markClassName,
  nameClassName,
}: {
  readonly name: string;
  readonly className?: string | undefined;
  readonly markClassName?: string | undefined;
  readonly nameClassName?: string | undefined;
}) {
  return (
    <span className={cx('inline-flex items-center gap-3', className)}>
      <BrandMark className={markClassName} />
      <span className={cx('font-semibold tracking-tight', nameClassName)}>{name}</span>
    </span>
  );
}
