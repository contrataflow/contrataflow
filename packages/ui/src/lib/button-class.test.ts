import { describe, expect, it } from 'vitest';

import { buttonClassName } from './button-class.js';

describe('buttonClassName', () => {
  // O axe do E2E reprovou o "Salvar" sob o cursor: `hover:opacity-90` levava o primário a 4,1:1.
  it.each(['primary', 'secondary', 'ghost', 'destructive'] as const)(
    'o hover de %s não esmaece nem muda o brilho do par texto/fundo',
    (variant) => {
      const hoverClasses = buttonClassName({ variant })
        .split(' ')
        .filter((name) => name.startsWith('hover:'));
      expect(hoverClasses.some((name) => /opacity|brightness/.test(name))).toBe(false);
    },
  );
});
