'use client';

import { Alert, buttonClassName } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode, SyntheticEvent } from 'react';

import { AuthIcon } from './auth-icons';
import { LoginReasonMessage } from './login-reason-message';
import type { LoginReason } from './login-reason-message';

/*
 * Formulário de entrada nativo (SCR-001 · DEC-187): usuário e senha na tela do ContrataFlow,
 * conduzidos pelo BFF no *flow* do IdP (`POST /api/auth/login`); quando o usuário tem segundo
 * fator, a etapa de código de 6 dígitos na mesma transação. Mensagens genéricas, sem revelar se a
 * conta existe (RN-IAM-18); erro anunciado (`role="alert"`) e foco no primeiro campo com erro.
 */

type Field = 'username' | 'password' | 'code';

/** Erros do topo do formulário (chaves de `auth.login.errors`). */
type FormError =
  | 'invalidCredentials'
  | 'locked'
  | 'mfaInvalid'
  | 'mfaExpired'
  | 'rateLimited'
  | 'unavailable'
  | 'forbidden'
  | 'failed';

const ERROR_BY_CODE: Readonly<Record<string, FormError>> = {
  INVALID_CREDENTIALS: 'invalidCredentials',
  LOCKED: 'locked',
  MFA_INVALID: 'mfaInvalid',
  MFA_EXPIRED: 'mfaExpired',
  RATE_LIMITED: 'rateLimited',
  IDP_UNAVAILABLE: 'unavailable',
  DEPENDENCY_UNAVAILABLE: 'unavailable',
  CSRF_REJECTED: 'forbidden',
};

const FIELDS: readonly Field[] = ['username', 'password', 'code'];
const CODE_PATTERN = /^\d{6}$/;

type Outcome =
  | { readonly kind: 'done'; readonly redirectTo: string }
  | { readonly kind: 'mfa'; readonly transaction: string }
  | { readonly kind: 'invalid'; readonly fields: readonly Field[] }
  | { readonly kind: 'error'; readonly error: FormError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Só caminhos da própria aplicação (o BFF já valida; aqui é defesa extra). */
function safeDestination(path: string): string {
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\')
    ? path
    : '/painel';
}

async function submitLogin(body: Readonly<Record<string, string>>): Promise<Outcome> {
  let response: Response;
  try {
    response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CF-Request': '1' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return { kind: 'error', error: 'unavailable' };
  }
  const payload: unknown = await response.json().catch(() => null);
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  if (response.ok && data) {
    if (data.step === 'done' && typeof data.redirectTo === 'string') {
      return { kind: 'done', redirectTo: data.redirectTo };
    }
    if (data.step === 'mfa' && typeof data.transaction === 'string') {
      return { kind: 'mfa', transaction: data.transaction };
    }
  }
  const code = isRecord(payload) && typeof payload.code === 'string' ? payload.code : '';
  if (code === 'VALIDATION_ERROR' && isRecord(payload) && Array.isArray(payload.errors)) {
    const fields = FIELDS.filter((field) =>
      (payload.errors as unknown[]).some((error) => isRecord(error) && error.field === field),
    );
    return { kind: 'invalid', fields };
  }
  return { kind: 'error', error: ERROR_BY_CODE[code] ?? 'failed' };
}

const INPUT_CLASS =
  'h-12 w-full rounded-control border border-border-strong bg-surface px-3.5 text-[0.9375rem] text-foreground placeholder:text-neutral focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-ring/30 aria-invalid:border-destructive';

const LINK_CLASS =
  'inline-flex min-h-11 items-center text-sm font-medium text-primary-hover hover:text-brand-ink hover:underline';

const SUBMIT_CLASS = buttonClassName({ size: 'md', className: 'h-[3.125rem] w-full text-base' });

function FieldError({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  return (
    <p id={id} className="text-sm text-destructive">
      {children}
    </p>
  );
}

export interface LoginFormProps {
  /** Destino validado no servidor (`safeReturnTo`); `null` = início. */
  readonly returnTo: string | null;
  /** Motivo de `/entrar?motivo=` (saiu, sessão expirada…). */
  readonly reason: LoginReason | null;
  /** "Esqueci minha senha" → `GET /api/auth/forgot-password` (US-089). */
  readonly forgotHref: string;
}

export function LoginForm({ returnTo, reason, forgotHref }: LoginFormProps) {
  const t = useTranslations('auth.login');
  const [step, setStep] = useState<'password' | 'mfa'>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState('');
  const [transaction, setTransaction] = useState<string | null>(null);
  const [error, setError] = useState<FormError | null>(null);
  const [invalid, setInvalid] = useState<readonly Field[]>([]);
  const [pending, setPending] = useState(false);
  // Foco pedido para depois da renderização que trocou a etapa ou marcou o campo (`seq` repete o
  // pedido para o mesmo campo). Começa no usuário.
  const [focusRequest, setFocusRequest] = useState<{ field: Field; seq: number }>({
    field: 'username',
    seq: 0,
  });
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const target = { username: usernameRef, password: passwordRef, code: codeRef }[
      focusRequest.field
    ];
    target.current?.focus();
  }, [focusRequest]);

  const focusField = (field: Field) => {
    setFocusRequest((previous) => ({ field, seq: previous.seq + 1 }));
  };

  const showFieldErrors = (fields: readonly Field[]) => {
    setInvalid(fields);
    setError(null);
    const [first] = fields;
    if (first) focusField(first);
  };

  const apply = (outcome: Outcome) => {
    switch (outcome.kind) {
      case 'done':
        // Navegação completa: as páginas do servidor passam a ver a sessão nova.
        window.location.assign(safeDestination(outcome.redirectTo));
        return;
      case 'mfa':
        setTransaction(outcome.transaction);
        setStep('mfa');
        setPassword('');
        setCode('');
        setError(null);
        setInvalid([]);
        focusField('code');
        break;
      case 'invalid':
        showFieldErrors(outcome.fields);
        break;
      case 'error':
        setError(outcome.error);
        setInvalid([]);
        if (outcome.error === 'mfaExpired') {
          setStep('password');
          setTransaction(null);
          setCode('');
          focusField('password');
        } else if (outcome.error === 'mfaInvalid') {
          setCode('');
          focusField('code');
        } else if (outcome.error === 'invalidCredentials' || outcome.error === 'locked') {
          setPassword('');
          focusField('password');
        }
        break;
    }
    setPending(false);
  };

  const onSubmitPassword = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const missing = (
      [
        ['username', username.trim()],
        ['password', password],
      ] as const
    )
      .filter(([, value]) => value === '')
      .map(([field]) => field);
    if (missing.length > 0) {
      showFieldErrors(missing);
      return;
    }
    setPending(true);
    apply(
      await submitLogin({
        username: username.trim(),
        password,
        ...(returnTo ? { returnTo } : {}),
      }),
    );
  };

  const onSubmitCode = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || !transaction) return;
    if (!CODE_PATTERN.test(code)) {
      showFieldErrors(['code']);
      return;
    }
    setPending(true);
    apply(await submitLogin({ transaction, code }));
  };

  const back = () => {
    setStep('password');
    setTransaction(null);
    setCode('');
    setError(null);
    setInvalid([]);
    focusField('password');
  };

  const errorAlert = error ? (
    <Alert tone="error" title={t(`errors.${error}`)} className="flex-none" />
  ) : null;

  if (step === 'mfa') {
    const codeInvalid = invalid.includes('code');
    return (
      <div className="flex flex-col gap-7">
        <div className="flex flex-col gap-2">
          <span className="grid size-12 place-items-center rounded-card bg-primary-soft text-primary">
            <AuthIcon name="smartphone" className="size-6" />
          </span>
          <h1 className="mt-2 text-page-title text-brand-ink">{t('mfa.title')}</h1>
          <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">
            {t('mfa.description')}
          </p>
        </div>
        {errorAlert}
        <form
          noValidate
          onSubmit={(event) => void onSubmitCode(event)}
          className="flex flex-col gap-5"
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="login-code" className="text-sm font-semibold text-brand-ink">
              {t('mfa.label')}
            </label>
            <input
              ref={codeRef}
              id="login-code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(event) => {
                setCode(event.target.value.replace(/\D/g, '').slice(0, 6));
              }}
              aria-invalid={codeInvalid || error === 'mfaInvalid' || undefined}
              aria-describedby={codeInvalid ? 'login-code-error' : undefined}
              className={`${INPUT_CLASS} h-14 text-center text-[1.625rem] tracking-[0.5em]`}
            />
            {codeInvalid ? (
              <FieldError id="login-code-error">{t('fields.codeRequired')}</FieldError>
            ) : null}
          </div>
          <button type="submit" aria-busy={pending} disabled={pending} className={SUBMIT_CLASS}>
            {pending ? t('mfa.submitting') : t('mfa.submit')}
          </button>
        </form>
        <button type="button" onClick={back} className={`${LINK_CLASS} gap-1.5 self-start`}>
          <AuthIcon name="arrowLeft" className="size-4" />
          {t('mfa.back')}
        </button>
      </div>
    );
  }

  const usernameInvalid = invalid.includes('username');
  const passwordInvalid = invalid.includes('password');
  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-2">
        <h1 className="text-page-title text-brand-ink">{t('title')}</h1>
        <p className="text-[0.9375rem] text-muted-foreground">{t('subtitle')}</p>
      </div>
      {errorAlert ?? (reason ? <LoginReasonMessage reason={reason} className="" /> : null)}
      <form
        noValidate
        onSubmit={(event) => void onSubmitPassword(event)}
        className="flex flex-col gap-5"
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="login-username" className="text-sm font-semibold text-brand-ink">
            {t('fields.username')}
          </label>
          <input
            ref={usernameRef}
            id="login-username"
            name="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={t('fields.usernamePlaceholder')}
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
            }}
            aria-invalid={usernameInvalid || undefined}
            aria-describedby={usernameInvalid ? 'login-username-error' : undefined}
            className={INPUT_CLASS}
          />
          {usernameInvalid ? (
            <FieldError id="login-username-error">{t('fields.usernameRequired')}</FieldError>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="login-password" className="text-sm font-semibold text-brand-ink">
            {t('fields.password')}
          </label>
          <div className="relative flex">
            <input
              ref={passwordRef}
              id="login-password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              placeholder={t('fields.passwordPlaceholder')}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              aria-invalid={passwordInvalid || undefined}
              aria-describedby={passwordInvalid ? 'login-password-error' : undefined}
              className={`${INPUT_CLASS} pr-12`}
            />
            <button
              type="button"
              onClick={() => {
                setShowPassword((shown) => !shown);
              }}
              aria-label={showPassword ? t('fields.hidePassword') : t('fields.showPassword')}
              aria-controls="login-password"
              className="absolute top-1 right-1 grid size-10 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <AuthIcon name={showPassword ? 'eyeOff' : 'eye'} />
            </button>
          </div>
          {passwordInvalid ? (
            <FieldError id="login-password-error">{t('fields.passwordRequired')}</FieldError>
          ) : null}
        </div>
        <div className="flex justify-end">
          <a href={forgotHref} className={LINK_CLASS}>
            {t('forgot')}
          </a>
        </div>
        <button type="submit" aria-busy={pending} disabled={pending} className={SUBMIT_CLASS}>
          {pending ? t('submitting') : t('submit')}
        </button>
      </form>
    </div>
  );
}
