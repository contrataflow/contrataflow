import { cx } from '../lib/cx.js';
import { SOFT_TONE } from '../lib/tones.js';
import type { StatusTone } from '../lib/tones.js';

export interface AvatarProps {
  /** Nome da pessoa; dá as iniciais e a cor. */
  readonly name: string;
  readonly size?: 'sm' | 'md' | undefined;
  /**
   * `true` quando o nome já aparece ao lado (o avatar some da árvore de acessibilidade); `false`
   * expõe o nome como imagem rotulada.
   */
  readonly decorative?: boolean | undefined;
  readonly className?: string | undefined;
}

/** Tons dos avatares: pares fundo suave/texto validados nos dois temas (sem `neutral`). */
const AVATAR_TONES: readonly StatusTone[] = ['info', 'approval', 'success', 'warning', 'danger'];

/** Até duas iniciais: primeiro e último nome (ex.: "Ana Maria Ribeiro" → "AR"). */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const first = words[0] ?? '';
  const last = words.length > 1 ? (words.at(-1) ?? '') : '';
  return `${first.charAt(0)}${last.charAt(0)}`.toLocaleUpperCase('pt-BR');
}

/** Cor estável por nome: a mesma pessoa tem sempre a mesma cor. */
export function avatarToneOf(name: string): StatusTone {
  let hash = 0;
  for (const char of name.trim().toLocaleLowerCase('pt-BR')) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 2_147_483_647;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length] ?? 'info';
}

const SIZES = { sm: 'size-7 text-[0.6875rem]', md: 'size-8 text-[0.8125rem]' } as const;

/** Avatar com iniciais e cor por nome (linhas de tabela, responsável, menu do usuário). */
export function Avatar({ name, size = 'md', decorative = true, className }: AvatarProps) {
  return (
    <span
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name })}
      className={cx(
        'inline-grid flex-none place-items-center rounded-full font-bold',
        SIZES[size],
        SOFT_TONE[avatarToneOf(name)],
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}
