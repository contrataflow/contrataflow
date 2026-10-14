import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect } from 'react';

import { Button } from './button.js';
import { Toaster, clearToasts, toast } from './toast.js';
import type { ToastTone } from './toast.js';

function ToastExample({ tone, initial }: { readonly tone: ToastTone; readonly initial: boolean }) {
  useEffect(() => {
    if (initial)
      toast({ title: 'Processo salvo.', description: 'As alterações foram registradas.', tone });
    return clearToasts;
  }, [initial, tone]);
  return (
    <>
      <Button
        onClick={() => {
          toast({ title: 'Ocorreu um erro inesperado.', description: 'Código: 3f2a9c1e', tone });
        }}
      >
        Mostrar toast
      </Button>
      <Toaster />
    </>
  );
}

const meta = {
  title: 'Componentes/Toast',
  component: ToastExample,
  args: { tone: 'info', initial: false },
} satisfies Meta<typeof ToastExample>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Trigger: Story = {};

export const Success: Story = { args: { tone: 'success', initial: true } };

export const Failure: Story = { args: { tone: 'error', initial: true } };
