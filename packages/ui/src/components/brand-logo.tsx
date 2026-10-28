import { cx } from '../lib/cx.js';

/*
 * Identidade visual oficial do ContrataFlow (docs/brand · DEC-185). O ícone é o contorno
 * vetorizado de `docs/brand/contrataflow-icone.png` (arte de 855×906 no quadro de 1254 px), com
 * `viewBox` quadrado justo e margem de ~6%. A palavra-marca e o slogan são texto real.
 */

const MARK_VIEWBOX = '126 141 1031 1031';
const MARK_NAVY =
  'M689 203 L718 205 L742 213 L1047 382 L837 504 L784 479 L752 469 L718 468 L681 479 L215 735 L215 498 L221 476 L240 448 L261 431 L644 216 Z';
const MARK_BLUE = [
  'M403 673 L412 694 L426 707 L925 978 L704 1102 L683 1108 L656 1109 L628 1102 L602 1088 L261 887 L240 870 L221 842 L215 821 L214 776 Z',
  'M830 777 L857 782 L1069 899 L965 956 L742 823 Z',
] as const;

/** Tom da marca: `default` sobre fundos do tema; `onDark` sobre o navy da marca (login). */
export type BrandTone = 'default' | 'onDark';
export type BrandSize = 'sm' | 'md' | 'lg';

export interface BrandMarkProps {
  readonly tone?: BrandTone | undefined;
  readonly className?: string | undefined;
}

/** Ícone da marca; decorativo — o nome vem ao lado. Sobre navy, a faixa navy fica clara. */
export function BrandMark({ tone = 'default', className }: BrandMarkProps) {
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      aria-hidden="true"
      focusable="false"
      className={cx(
        'size-10 flex-none',
        tone === 'onDark' ? 'text-on-navy' : 'text-brand-ink',
        className,
      )}
    >
      <path d={MARK_NAVY} fill="currentColor" />
      {MARK_BLUE.map((d) => (
        <path key={d} d={d} className="fill-brand-blue" />
      ))}
    </svg>
  );
}

const SIZES = {
  sm: { gap: 'gap-2', mark: 'size-8', name: 'text-lg', tagline: 'text-[0.5625rem]' },
  md: { gap: 'gap-2.5', mark: 'size-9', name: 'text-xl', tagline: 'text-[0.625rem]' },
  lg: { gap: 'gap-3.5', mark: 'size-14', name: 'text-[2rem]', tagline: 'text-xs' },
} as const satisfies Record<BrandSize, Record<'gap' | 'mark' | 'name' | 'tagline', string>>;

export interface BrandLogoProps {
  readonly tone?: BrandTone | undefined;
  readonly size?: BrandSize | undefined;
  /** Nome lido pelos leitores de tela como uma palavra só. */
  readonly name?: string | undefined;
  /** Slogan opcional sob a palavra-marca (exibido em caixa alta). */
  readonly tagline?: string | undefined;
  readonly className?: string | undefined;
}

/**
 * Lockup horizontal: ícone + palavra-marca ("Contrata" em navy, "Flow" em azul) + slogan opcional.
 * A palavra-marca visual é dividida em duas cores e oculta da árvore de acessibilidade; o nome
 * inteiro vai num texto só para leitor de tela, que não o soletra em duas partes.
 */
export function BrandLogo({
  tone = 'default',
  size = 'md',
  name = 'ContrataFlow',
  tagline,
  className,
}: BrandLogoProps) {
  const sizes = SIZES[size];
  const onDark = tone === 'onDark';
  return (
    <span className={cx('inline-flex items-center', sizes.gap, className)}>
      <BrandMark tone={tone} className={sizes.mark} />
      <span className="flex flex-col">
        <span className={cx('leading-none font-extrabold tracking-[-0.03em]', sizes.name)}>
          <span className="sr-only">{name}</span>
          <span aria-hidden="true">
            <span className={onDark ? 'text-on-navy' : 'text-brand-ink'}>Contrata</span>
            <span className={onDark ? 'text-on-navy-accent' : 'text-brand-accent'}>Flow</span>
          </span>
        </span>
        {tagline ? (
          <span
            className={cx(
              'mt-1.5 leading-none font-normal tracking-[0.25em] uppercase',
              onDark ? 'text-on-navy-muted' : 'text-muted-foreground',
              sizes.tagline,
            )}
          >
            {tagline}
          </span>
        ) : null}
      </span>
    </span>
  );
}
