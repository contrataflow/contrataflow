// Repositórios em memória do ETP para os testes de rota de outros módulos (ex.: o rascunho do ETP
// com IA — US-118). Fica fora de `src/modules` para que os specs não importem a infraestrutura de
// outro módulo (DEC-041 · dependency-cruiser); não é código de produção.
import { InMemoryEtpAlternativeRepository } from '#modules/etp/infrastructure/etp-alternative.repositories.js';
import { InMemoryEtpRepository } from '#modules/etp/infrastructure/etp.repositories.js';

import type { TestApi } from './api-test-app.js';

export function etpRepositoryOf(api: TestApi): InMemoryEtpRepository {
  return api.app.get(InMemoryEtpRepository, { strict: false });
}

export function etpAlternativeRepositoryOf(api: TestApi): InMemoryEtpAlternativeRepository {
  return api.app.get(InMemoryEtpAlternativeRepository, { strict: false });
}
