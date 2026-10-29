import type { Meta, StoryObj } from '@storybook/react-vite';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './accordion.js';

function EtpSections({ type }: { readonly type: 'single' | 'multiple' }) {
  const items = (
    <>
      <AccordionItem value="necessidade">
        <AccordionTrigger>Descrição da necessidade</AccordionTrigger>
        <AccordionContent>Limpeza contínua das alas de internação.</AccordionContent>
      </AccordionItem>
      <AccordionItem value="requisitos">
        <AccordionTrigger>Requisitos da contratação</AccordionTrigger>
        <AccordionContent>Equipe treinada em protocolos hospitalares.</AccordionContent>
      </AccordionItem>
      <AccordionItem value="estimativa">
        <AccordionTrigger>Estimativa de quantidades</AccordionTrigger>
        <AccordionContent>12 postos de 44 horas semanais.</AccordionContent>
      </AccordionItem>
    </>
  );
  return (
    <div className="w-[min(32rem,100vw-2rem)]">
      {type === 'single' ? (
        <Accordion type="single" collapsible defaultValue="necessidade">
          {items}
        </Accordion>
      ) : (
        <Accordion type="multiple" defaultValue={['necessidade', 'requisitos']}>
          {items}
        </Accordion>
      )}
    </div>
  );
}

const meta = {
  title: 'Componentes/Accordion',
  component: EtpSections,
  args: { type: 'single' },
} satisfies Meta<typeof EtpSections>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = {};

export const Multiple: Story = { args: { type: 'multiple' } };
