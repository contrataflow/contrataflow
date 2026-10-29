import type { Meta, StoryObj } from '@storybook/react-vite';

import { Label } from './field.js';
import { RadioGroup, RadioGroupItem } from './radio-group.js';

const options = [
  { value: 'menor-preco', label: 'Menor preço' },
  { value: 'tecnica-preco', label: 'Técnica e preço' },
  { value: 'maior-desconto', label: 'Maior desconto' },
];

const meta: Meta<typeof RadioGroup> = {
  title: 'Formulário/RadioGroup',
  component: RadioGroup,
  args: { 'aria-label': 'Critério de julgamento', defaultValue: 'menor-preco' },
  render: (args) => (
    <RadioGroup {...args}>
      {options.map((option) => (
        <div key={option.value} className="flex items-center gap-2">
          <RadioGroupItem value={option.value} id={`criterio-${option.value}`} />
          <Label htmlFor={`criterio-${option.value}`} className="font-normal">
            {option.label}
          </Label>
        </div>
      ))}
    </RadioGroup>
  ),
};

export default meta;
type Story = StoryObj<typeof RadioGroup>;

export const Default: Story = {};

export const Horizontal: Story = {
  args: { orientation: 'horizontal', className: 'flex-row flex-wrap gap-5' },
};
