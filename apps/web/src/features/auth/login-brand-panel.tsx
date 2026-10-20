import { BrandLogo } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

import { AuthIcon } from './auth-icons';
import type { AuthIconName } from './auth-icons';

const HIGHLIGHTS = [
  { key: 'standardized', icon: 'fileText' },
  { key: 'workflow', icon: 'zap' },
  { key: 'transparency', icon: 'chartColumn' },
] as const satisfies readonly { readonly key: string; readonly icon: AuthIconName }[];

/*
 * A ilustração some em telas menores e se funde ao fundo pelas máscaras; os degradês navy da marca
 * por cima garantem o contraste AA dos textos claros mesmo sobre as partes claras do desenho.
 */
const PHOTO_MASK =
  '[mask-image:linear-gradient(to_right,transparent_0%,#000_45%),linear-gradient(to_bottom,transparent_0%,#000_18%)] [mask-composite:intersect]';

/**
 * Painel institucional decorativo da moldura de entrada (SCR-001): marca, proposta de valor,
 * três destaques e frase de rodapé. Só a partir de 1024 px (`lg`); abaixo disso a marca vai
 * para o topo do painel de acesso. Sem dados de nenhuma instituição (DEC-141).
 */
export function LoginBrandPanel() {
  const t = useTranslations('auth.login.brand');
  return (
    <section
      aria-label={t('panelLabel')}
      className="relative hidden overflow-hidden bg-linear-to-b from-[#1a2638] via-brand-navy to-[#0b1118] text-white lg:flex lg:flex-col"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- ilustração SVG decorativa e estática: a otimização de imagens do Next não se aplica. */}
      <img
        src="/login-predio.svg"
        alt=""
        className={`pointer-events-none absolute right-0 bottom-0 h-[96%] w-auto max-w-none object-cover select-none ${PHOTO_MASK}`}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-linear-to-r from-[#0b1118]/95 via-[#0b1118]/85 via-55% to-[#0b1118]/35"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-linear-to-b from-[#0b1118]/40 via-transparent to-[#0b1118]/40"
      />

      <div className="relative flex flex-1 flex-col px-12 pt-12 pb-10">
        <BrandLogo tone="onDark" size="lg" name={t('name')} tagline={t('slogan')} />

        <p className="mt-10 max-w-md text-[2.6rem] leading-[1.1] font-bold tracking-tight">
          {t('headline')}
        </p>
        <p className="mt-5 max-w-sm text-lg leading-relaxed text-slate-100">{t('tagline')}</p>

        <ul className="mt-10 space-y-6">
          {HIGHLIGHTS.map(({ key, icon }) => (
            <li key={key} className="flex items-center gap-4">
              <span className="grid size-12 flex-none place-items-center rounded-lg border border-white/20 bg-white/10">
                <AuthIcon name={icon} />
              </span>
              <span>
                <span className="block font-semibold">{t(`highlights.${key}.title`)}</span>
                <span className="block text-sm text-slate-200">
                  {t(`highlights.${key}.description`)}
                </span>
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-auto pt-12">
          <span aria-hidden="true" className="block h-px w-6 bg-white/50" />
          <p className="mt-4 text-sm leading-relaxed text-slate-100">
            <span className="block">{t('footer.line1')}</span>
            <span className="block">{t('footer.line2')}</span>
          </p>
        </div>
      </div>
    </section>
  );
}
