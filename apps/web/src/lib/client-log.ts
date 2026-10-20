/*
 * Log estruturado do navegador (`event` + campos, observability.md §2.2). Sem instrumentação de
 * browser no MVP 1 (observability.md §4), sai no console — único ponto do front autorizado a usá-lo;
 * quando o coletor de erros de front chegar, só este arquivo muda. Nunca recebe dado sensível:
 * os chamadores passam ids e contagens, não conteúdo (DEC-138).
 */

export type ClientLogFields = Readonly<Record<string, string | number | boolean | null>>;

export function logClientEvent(
  level: 'info' | 'warn',
  event: string,
  fields: ClientLogFields = {},
): void {
  const entry = { level, event, service: 'web', ...fields };
  // eslint-disable-next-line contrataflow/no-console -- saída do log de front (ver o cabeçalho)
  if (level === 'warn') console.warn(entry);
  // eslint-disable-next-line contrataflow/no-console -- saída do log de front (ver o cabeçalho)
  else console.info(entry);
}
