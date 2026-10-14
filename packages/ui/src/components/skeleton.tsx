import type { ComponentPropsWithoutRef } from 'react';

import { cx } from '../lib/cx.js';

export type SkeletonProps = ComponentPropsWithoutRef<'div'>;

/** Bloco de carregamento decorativo; o estado "carregando" é anunciado por quem o usa. */
export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cx('animate-pulse rounded-control bg-muted', className)}
      {...props}
    />
  );
}
