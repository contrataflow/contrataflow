import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BrandLogo, BrandMark } from './brand-logo.js';

afterEach(cleanup);

const classes = (element: Element | null | undefined) => [...(element?.classList ?? [])];

describe('BrandLogo', () => {
  it('expõe o nome como uma palavra só e esconde a palavra-marca em duas cores', () => {
    const { container } = render(<BrandLogo />);
    expect(classes(screen.getByText('ContrataFlow'))).toContain('sr-only');
    const visual = container.querySelector('span[aria-hidden="true"]');
    expect(visual?.textContent).toBe('ContrataFlow');
    expect(classes(screen.getByText('Contrata'))).toContain('text-brand-ink');
    expect(classes(screen.getByText('Flow'))).toContain('text-brand-accent');
  });

  it('mostra o slogan só quando informado', () => {
    const { rerender } = render(<BrandLogo />);
    expect(screen.queryByText('Do planejamento à contratação')).toBeNull();
    rerender(<BrandLogo tagline="Do planejamento à contratação" />);
    expect(classes(screen.getByText('Do planejamento à contratação'))).toContain('uppercase');
  });

  it('sobre fundo escuro usa as cores do menu lateral', () => {
    render(<BrandLogo tone="onDark" tagline="Slogan" />);
    expect(classes(screen.getByText('Contrata'))).toContain('text-sidebar-foreground');
    expect(classes(screen.getByText('Flow'))).toContain('text-sidebar-accent');
    expect(classes(screen.getByText('Slogan'))).toContain('text-sidebar-muted');
  });
});

describe('BrandMark', () => {
  it('é decorativo e troca a faixa navy por clara sobre fundo escuro', () => {
    const { container, rerender } = render(<BrandMark />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(classes(svg)).toContain('text-brand-ink');
    expect(svg?.querySelectorAll('path')).toHaveLength(3);
    rerender(<BrandMark tone="onDark" />);
    expect(classes(container.querySelector('svg'))).toContain('text-sidebar-foreground');
  });
});
