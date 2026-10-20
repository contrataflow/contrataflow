import { useTranslations } from 'next-intl';

/**
 * `MfaStatusBadge` (SCR-039 · US-090 · RN-IAM-44): se a sessão atual comprova o segundo fator
 * (`mfaVerified` de ME-01, derivado do `amr`). Somente leitura e sem detalhar o dispositivo — os
 * fatores vivem no Authentik. O texto (nunca só a cor) diz o estado.
 */
export function MfaStatusBadge({ verified }: { readonly verified: boolean }) {
  const t = useTranslations('profile.security.mfaStatus');
  return (
    <span
      className={`inline-flex rounded-control px-2 py-0.5 text-xs font-medium whitespace-nowrap ${
        verified ? 'bg-success-soft text-foreground' : 'bg-muted text-muted-foreground'
      }`}
    >
      {t(verified ? 'verified' : 'notVerified')}
    </span>
  );
}
