'use client';

import {
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  brandingTheme,
  contrastRatio,
  cx,
} from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useId } from 'react';

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const WHITE = '#ffffff';
const FALLBACK = '#000000';
const AA = 4.5;

/** Cores sugeridas: todas atingem 4,5:1 com texto branco (AA), o mínimo que a configuração aceita. */
const PRESETS = [
  '#1D4ED8',
  '#0F766E',
  '#15803D',
  '#B91C1C',
  '#7E22CE',
  '#C2410C',
  '#0E7490',
  '#334155',
] as const;

export interface ColorFieldProps {
  /** `id` do controle do `Field` (liga o rótulo "Cor principal" ao botão que abre o seletor). */
  readonly id: string | undefined;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean | undefined;
  readonly describedBy?: string | undefined;
  readonly invalid?: boolean | undefined;
}

/**
 * Seletor de cor do kit (prd-6 · spec-596): no lugar do controle de cor nativo do navegador, um `Popover`
 * com o campo hexadecimal (`#RRGGBB`), a amostra da cor, a prévia de contraste (texto do botão da
 * marca sobre a cor, como o app aplica por `brandingTheme`) e cores sugeridas. O botão que abre o
 * painel mostra a amostra e o valor atual e leva o rótulo do `Field`.
 */
export function ColorField({
  id,
  value,
  onChange,
  disabled,
  describedBy,
  invalid,
}: ColorFieldProps) {
  const t = useTranslations('settings.field');
  const hexId = useId();
  const valid = HEX_COLOR.test(value);
  const color = valid ? value : FALLBACK;
  const theme = valid ? brandingTheme(value) : null;
  const ratio = valid ? contrastRatio(WHITE, value) : null;
  const passes = ratio !== null && ratio >= AA;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          disabled={disabled}
          aria-describedby={describedBy}
          className={cx(
            'inline-flex h-11 items-center gap-2.5 rounded-control border bg-surface px-3 text-sm',
            'font-mono text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60',
            invalid ? 'border-destructive' : 'border-border-strong',
          )}
        >
          <span
            aria-hidden="true"
            className="size-5 rounded-sm border border-border"
            style={{ backgroundColor: color }}
          />
          {value === '' ? '—' : value}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label={t('colorPicker')} className="w-72">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={hexId} className="text-sm font-semibold text-brand-ink">
              {t('colorHex')}
            </label>
            <Input
              id={hexId}
              className="font-mono"
              value={value}
              maxLength={7}
              spellCheck={false}
              aria-invalid={valid ? undefined : true}
              onChange={(event) => {
                onChange(event.target.value);
              }}
            />
            {valid ? null : <p className="text-xs text-destructive">{t('colorInvalid')}</p>}
          </div>

          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="grid h-11 min-w-20 place-items-center rounded-control px-3 text-sm font-bold"
              style={{
                backgroundColor: color,
                color: theme?.['--color-primary-foreground'] ?? WHITE,
              }}
            >
              Aa
            </span>
            <p
              aria-live="polite"
              className={cx('text-xs', passes ? 'text-muted-foreground' : 'text-destructive')}
            >
              {ratio === null
                ? t('colorNoContrast')
                : t('colorContrast', { ratio: ratio.toFixed(1).replace('.', ',') })}
              {ratio === null ? null : (
                <span className="block font-semibold">
                  {passes ? t('colorContrastOk') : t('colorContrastLow')}
                </span>
              )}
            </p>
          </div>

          <div role="group" aria-label={t('colorPresets')} className="flex flex-wrap gap-2">
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                aria-label={preset}
                aria-pressed={value.toUpperCase() === preset}
                className={cx(
                  'size-8 rounded-control border border-border',
                  'aria-pressed:border-brand-ink aria-pressed:ring-2 aria-pressed:ring-brand-ink',
                )}
                style={{ backgroundColor: preset }}
                onClick={() => {
                  onChange(preset);
                }}
              />
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
