import type { Meta, StoryObj } from '@storybook/react-vite';

import { CalendarDays } from '../icons.js';
import { Button } from './button.js';
import { Popover, PopoverContent, PopoverTrigger } from './popover.js';

function DeadlinePopover({ defaultOpen }: { readonly defaultOpen: boolean }) {
  return (
    <Popover defaultOpen={defaultOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary" iconLeft={<CalendarDays />}>
          Prazo da etapa
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Prazo da etapa" className="flex flex-col gap-1 text-sm">
        <p className="font-bold text-brand-ink">Vence em 2 dias úteis</p>
        <p className="text-muted-foreground">Contado pelo calendário do órgão, sem feriados.</p>
      </PopoverContent>
    </Popover>
  );
}

const meta = {
  title: 'Sobreposição/Popover',
  component: DeadlinePopover,
  args: { defaultOpen: false },
} satisfies Meta<typeof DeadlinePopover>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

export const Open: Story = { args: { defaultOpen: true } };
