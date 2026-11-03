import { BrandLogo } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

/*
 * Colunas translúcidas da ilustração (abstrata, decorativa): posição, largura e altura de cada uma.
 * Desenhadas em CSS, sem imagem nem texto, para não pesar no carregamento da entrada.
 */
const COLUMNS = [
  'left-[48%] h-[16.875rem]',
  'left-[58%] h-[25rem]',
  'left-[68%] h-[20rem]',
  'left-[78%] h-[13.125rem]',
] as const;

/** Degradê navy (165°) com brilho azul da marca no canto inferior direito (prd-6 · §2.7). */
const PANEL_BACKGROUND =
  'bg-[radial-gradient(760px_460px_at_88%_112%,rgb(0_91_249/0.45),transparent_62%),linear-gradient(165deg,#1e2d40_0%,#141e2b_55%,#0b1118_100%)]';

/**
 * Painel institucional da moldura de entrada (SCR-001 · prd-6 §2.7, padrão do Microlegis): marca
 * no topo, ilustração abstrata e o slogan no rodapé, em degradê navy fixo (não muda com o tema).
 * Ocupa 58 % da largura a partir de 1024 px (`lg`); abaixo disso fica só o acesso. Sem dados de
 * nenhuma instituição (DEC-141); a LGPD fica no aviso de privacidade do painel de acesso.
 */
export function LoginBrandPanel() {
  const t = useTranslations('auth.login.brand');
  return (
    <section
      aria-label={t('panelLabel')}
      className={`relative hidden min-w-0 flex-col overflow-hidden px-12 pt-10 pb-11 text-on-navy lg:flex ${PANEL_BACKGROUND}`}
    >
      <BrandLogo tone="onDark" size="lg" name={t('name')} />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[26.25rem]"
      >
        <span className="absolute -bottom-30 left-[38%] h-40 w-[38.75rem] rounded-[2.5rem] bg-white/6 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]" />
        {COLUMNS.map((column) => (
          <span
            key={column}
            className={`absolute -bottom-2.5 w-[5.375rem] rounded-t-[2.5rem] bg-white/6 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] ${column}`}
          />
        ))}
      </div>
      <div className="relative mt-auto max-w-[28.75rem]">
        <span aria-hidden="true" className="mb-5 block h-0.5 w-10 bg-on-navy" />
        <p className="text-[2.5rem] leading-[1.12] font-bold tracking-[-0.02em] text-balance">
          {t('statement')}
        </p>
      </div>
    </section>
  );
}
