import type { Meta, StoryObj } from '@storybook/react-vite';

import { AutosaveIndicator } from './autosave-indicator.js';
import { Button } from './button.js';
import { Field } from './field.js';
import { FormPage, FormSection, WizardShell } from './form-page.js';
import { Input } from './input.js';
import { PageHeader } from './page-header.js';

const section = (
  <FormSection title="Identificação" description="Diga o que será contratado.">
    <Field label="Título" required>
      <Input />
    </Field>
  </FormSection>
);
const actions = (
  <>
    <Button variant="secondary">Salvar rascunho</Button>
    <Button>Continuar</Button>
  </>
);

const meta = {
  title: 'Modelos/FormPage',
  component: FormPage,
  parameters: { layout: 'padded' },
  args: {
    header: <PageHeader title="Novo processo" />,
    children: section,
    actions,
    actionsLabel: 'Ações do formulário',
  },
} satisfies Meta<typeof FormPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Wizard: Story = {
  render: () => (
    <WizardShell
      header={<PageHeader title="Novo processo" />}
      stepsLabel="Passos para criar o processo"
      current={1}
      steps={[
        { id: 'identificacao', label: 'Identificação' },
        { id: 'origem', label: 'Origem e planejamento' },
        { id: 'revisao', label: 'Revisão' },
      ]}
      onStepSelect={() => undefined}
      actions={actions}
      actionsLabel="Ações do formulário"
      autosave={<AutosaveIndicator status="saved" savedAt={0} timeZone="America/Sao_Paulo" />}
    >
      {section}
    </WizardShell>
  ),
};
