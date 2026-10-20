// Repositório em memória do TR para os testes de rota de outros módulos (ex.: o rascunho do TR com
// IA — US-120). Fica fora de `src/modules` para que os specs não importem a infraestrutura de outro
// módulo (DEC-041 · dependency-cruiser); não é código de produção.
import { InMemoryTermRepository } from '#modules/term/infrastructure/term.repositories.js';

import type { TestApi } from './api-test-app.js';

export function termRepositoryOf(api: TestApi): InMemoryTermRepository {
  return api.app.get(InMemoryTermRepository, { strict: false });
}
