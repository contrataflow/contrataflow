import { describe, expect, it } from 'vitest';

import { buttonClassName } from './button-class.js';

describe('buttonClassName', () => {
  // O axe do E2E reprovou o "Salvar" sob o cursor: `hover:opacity-90` levava o primário a 4,1:1.
  it.each(['primary', 'secondary', 'ghost', 'destructive', 'link'] as const)(
    'o hover de %s não esmaece nem muda o brilho do par texto/fundo',
    (variant) => {
      const hoverClasses = buttonClassName({ variant })
        .split(' ')
        .filter((name) => name.startsWith('hover:'));
      expect(hoverClasses.some((name) => /opacity|brightness/.test(name))).toBe(false);
    },
  );

  it.each(['primary', 'secondary', 'ghost', 'destructive'] as const)(
    'desabilitado em %s usa tokens neutros, sem opacidade',
    (variant) => {
      const classes = buttonClassName({ variant }).split(' ');
      expect(classes).toContain('disabled:text-muted-foreground');
      expect(classes.some((name) => name.includes('opacity'))).toBe(false);
    },
  );

  it('link fica no fluxo do texto: sem altura mínima nem respiro lateral', () => {
    const classes = buttonClassName({ variant: 'link' }).split(' ');
    expect(classes).toContain('text-primary');
    expect(classes).not.toContain('min-h-11');
    expect(classes).toContain('p-0');
  });

  it('alvo de toque de 44 px no tamanho padrão e no ícone (prd-4)', () => {
    expect(buttonClassName().split(' ')).toContain('min-h-11');
    expect(buttonClassName({ size: 'icon' }).split(' ')).toContain('size-11');
  });
});
