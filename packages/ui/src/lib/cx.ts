export type ClassValue = string | false | null | undefined;

/** Junta classes CSS ignorando valores vazios. */
export function cx(...classes: readonly ClassValue[]): string {
  return classes
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join(' ');
}
