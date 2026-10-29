import type { Meta, StoryObj } from '@storybook/react-vite';

import { Field, Label } from './field.js';
import { Input } from './input.js';
import { RadioGroup, RadioGroupItem } from './radio-group.js';
import { InfoTooltip } from './tooltip.js';

const meta: Meta<typeof Field> = {
  title: 'Formulário/Field',
  component: Field,
  args: { label: 'Valor estimado', children: null },
  decorators: [(Story) => <div className="w-80">{Story()}</div>],
};

export default meta;
type Story = StoryObj<typeof Field>;

export const WithHelp: Story = {
  render: () => (
    <Field
      label="Valor estimado"
      description="Soma dos itens, em reais."
      labelAddon={
        <InfoTooltip label="Ajuda sobre o valor estimado">
          Calculado a partir da pesquisa de preços.
        </InfoTooltip>
      }
    >
      <Input inputMode="decimal" placeholder="0,00" />
    </Field>
  ),
};

export const WithError: Story = {
  render: () => (
    <Field label="E-mail institucional" error="Use o domínio do órgão." required>
      <Input type="email" defaultValue="maria@gmail.com" />
    </Field>
  ),
};

export const Group: Story = {
  render: () => (
    <Field label="Modalidade" description="Define o rito da contratação." group>
      <RadioGroup defaultValue="pregao">
        <div className="flex items-center gap-2">
          <RadioGroupItem value="pregao" id="mod-pregao" />
          <Label htmlFor="mod-pregao" className="font-normal">
            Pregão eletrônico
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="dispensa" id="mod-dispensa" />
          <Label htmlFor="mod-dispensa" className="font-normal">
            Dispensa
          </Label>
        </div>
      </RadioGroup>
    </Field>
  ),
};
