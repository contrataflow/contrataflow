'use client';

import { Button, toast } from '@contrataflow/ui';
import { internalEchoRequestSchema } from '@contrataflow/validation';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { isApiError } from '@/lib/api/api-error';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';

import { createEcho } from './example.api';

type FormInput = z.input<typeof internalEchoRequestSchema>;
type FormOutput = z.output<typeof internalEchoRequestSchema>;

const FIELDS = ['name', 'quantity'] as const;

/**
 * Formulário de exemplo (architecture.md §8.6): React Hook Form + `zodResolver` com o MESMO schema
 * que a API valida (DEC-054); nada é enviado antes da validação local passar. Erros de campo
 * associados por `aria-describedby`; `errors[]` do servidor voltam para os campos.
 */
export function ExampleForm() {
  const t = useTranslations('example.form');
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<FormInput, unknown, FormOutput>({ resolver: zodResolver(internalEchoRequestSchema) });

  const mutation = useIdempotentMutation({
    mutationFn: (values: FormOutput, { idempotencyKey }) => createEcho(values, idempotencyKey),
    onSuccess: (result) => {
      toast({ title: t('created', { name: result.data.name }), tone: 'success' });
      reset();
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await mutation.submit(values);
    } catch (error) {
      if (isApiError(error)) {
        for (const fieldError of error.errors) {
          const field = FIELDS.find((name) => name === fieldError.field);
          if (field) setError(field, { message: fieldError.message });
        }
      }
    }
  });

  return (
    <form
      noValidate
      onSubmit={(event) => void onSubmit(event)}
      className="flex max-w-md flex-col gap-4"
    >
      <h2 className="text-lg font-semibold">{t('heading')}</h2>
      <div className="flex flex-col gap-1">
        <label htmlFor="example-name" className="text-sm font-medium">
          {t('name')}
        </label>
        <input
          id="example-name"
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? 'example-name-error' : undefined}
          className="h-10 rounded-control border border-border bg-surface px-3 text-sm"
          {...register('name')}
        />
        {errors.name ? (
          <p id="example-name-error" className="text-sm text-destructive">
            {errors.name.message}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="example-quantity" className="text-sm font-medium">
          {t('quantity')}
        </label>
        <input
          id="example-quantity"
          type="number"
          inputMode="numeric"
          aria-invalid={errors.quantity ? true : undefined}
          aria-describedby={errors.quantity ? 'example-quantity-error' : undefined}
          className="h-10 rounded-control border border-border bg-surface px-3 text-sm"
          {...register('quantity', {
            setValueAs: (value: string) => (value === '' ? undefined : Number(value)),
          })}
        />
        {errors.quantity ? (
          <p id="example-quantity-error" className="text-sm text-destructive">
            {errors.quantity.message}
          </p>
        ) : null}
      </div>
      <Button type="submit" aria-busy={mutation.isPending} className="self-start">
        {mutation.isPending ? t('submitting') : t('submit')}
      </Button>
    </form>
  );
}
