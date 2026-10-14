import type { Meta, StoryObj } from '@storybook/react-vite';

import { SkipLink } from './skip-link.js';

const meta = {
  title: 'Componentes/SkipLink',
  component: SkipLink,
  args: { targetId: 'conteudo' },
  render: (args) => (
    <>
      <SkipLink {...args} />
      <main id="conteudo" tabIndex={-1}>
        <p>Conteúdo principal.</p>
      </main>
    </>
  ),
} satisfies Meta<typeof SkipLink>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
