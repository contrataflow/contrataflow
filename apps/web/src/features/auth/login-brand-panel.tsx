import { BrandLogo } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

import { AuthIcon } from './auth-icons';
import type { AuthIconName } from './auth-icons';
import { PRIVACY_POLICY_HREF } from './privacy-notice';

const HIGHLIGHTS = [
  { key: 'standardized', icon: 'fileText' },
  { key: 'workflow', icon: 'zap' },
  { key: 'transparency', icon: 'shieldCheck' },
] as const satisfies readonly { readonly key: string; readonly icon: AuthIconName }[];

/**
 * Painel institucional da moldura de entrada (SCR-001 · mockup da repaginação): marca, proposta
 * de valor, três destaques e o rodapé com a lei e a política de privacidade, em navy sólido (o
 * navy da marca sai do fundo das telas e fica aqui e nos títulos — DEC-186). Só a partir de
 * 1024 px (`lg`). Sem dados de nenhuma instituição (DEC-141).
 */
export function LoginBrandPanel() {
  const t = useTranslations('auth.login.brand');
  return (
    <section
      aria-label={t('panelLabel')}
      className="hidden w-[460px] flex-none flex-col justify-between gap-12 bg-brand-navy px-14 py-11 text-on-navy lg:flex xl:w-[520px]"
    >
      <BrandLogo tone="onDark" size="lg" name={t('name')} tagline={t('slogan')} />

      <div className="flex max-w-[520px] flex-col gap-7">
        <p className="text-[2.5rem] leading-[1.15] font-extrabold tracking-[-0.02em]">
          {t('headline')}
        </p>
        <p className="text-[1.0625rem] leading-relaxed text-on-navy-muted">{t('tagline')}</p>
        <ul className="flex flex-col gap-[1.125rem]">
          {HIGHLIGHTS.map(({ key, icon }) => (
            <li key={key} className="flex items-start gap-3.5">
              <span className="grid size-10 flex-none place-items-center rounded-control bg-white/10 text-on-navy-accent">
                <AuthIcon name={icon} />
              </span>
              <span>
                <span className="block text-[0.9375rem] font-bold">
                  {t(`highlights.${key}.title`)}
                </span>
                <span className="block text-sm text-on-navy-muted">
                  {t(`highlights.${key}.description`)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p className="flex flex-wrap items-center gap-3 text-xs text-on-navy-muted">
        <span>{t('footer.law')}</span>
        <span aria-hidden="true">·</span>
        <a href={PRIVACY_POLICY_HREF} className="hover:text-on-navy hover:underline">
          {t('footer.privacy')}
        </a>
      </p>
    </section>
  );
}
