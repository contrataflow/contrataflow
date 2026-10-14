'use client';

import { SegmentError } from '@/components/errors/segment-error';

/** Boundary do conteúdo autenticado: o shell continua visível (FA-04). */
export default function AppError({
  error,
  retry,
}: {
  readonly error: Error & { digest?: string };
  readonly retry: () => void;
}) {
  return <SegmentError error={error} retry={retry} />;
}
