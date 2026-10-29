// Repaginação (prd-5 · §3): cada tela migrada troca os controles nativos pelos do kit
// (`Select`, `Checkbox`, `RadioGroup`, `DatePicker` de `@contrataflow/ui`), que têm o mesmo visual
// nos dois temas e em todos os navegadores. Este teste impede controle nativo novo em
// `apps/web/src/features`.
import { describe, expect, it } from 'vitest';

import { filesMatching } from './source-scan';

const NATIVE_CONTROL = /<select\b|type="(checkbox|radio|date)"/;

const FEATURES = 'apps/web/src/features';
const found = filesMatching([FEATURES], NATIVE_CONTROL);

describe('prd-5 · controles de formulário do kit', () => {
  it('nenhum <select>, checkbox, radio ou date nativo em apps/web/src/features', () => {
    const offenders = [...found].map(([file, lines]) => `${file}:${lines.join(',')}`);
    expect(
      offenders,
      'Use Select, Checkbox, RadioGroup ou DatePicker de @contrataflow/ui.',
    ).toEqual([]);
  });
});
