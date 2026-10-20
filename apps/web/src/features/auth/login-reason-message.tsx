import { Alert } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

/*
 * Motivos de retorno a `/entrar?motivo=` (SCR-001): vêm só de redirecionamentos do próprio
 * app/BFF e nunca de entrada livre — qualquer outro valor é ignorado e a página segue direto
 * para o login.
 */
export const LOGIN_REASONS = [
  'saiu',
  'saiu-parcial',
  'sessao-expirada',
  'senha-redefinida',
  'erro',
  'indisponivel',
] as const;

export type LoginReason = (typeof LOGIN_REASONS)[number];

export function isLoginReason(value: string | undefined): value is LoginReason {
  return (LOGIN_REASONS as readonly (string | undefined)[]).includes(value);
}

/** Motivos que pedem atenção (aviso) em vez de só informar. */
const WARNING_REASONS: readonly LoginReason[] = ['saiu-parcial', 'erro', 'indisponivel'];

/** Mensagem do motivo, anunciada por leitores de tela (`role="status"` — o `Alert` informativo). */
export function LoginReasonMessage({ reason }: { readonly reason: LoginReason }) {
  const t = useTranslations('auth.login.reasons');
  return (
    <Alert
      tone={WARNING_REASONS.includes(reason) ? 'warning' : 'info'}
      title={t(reason)}
      className="mt-6"
    />
  );
}
