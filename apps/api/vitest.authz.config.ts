import { defineConfig } from 'vitest/config';

import { AUTHZ_BATTERY } from './test/authz/battery.js';
import unitConfig from './vitest.config.js';

// Bateria de autorização (permissions.md §10 · `pnpm --filter @contrataflow/api test:authz` · CI
// "Matriz de autorização"): sem banco nem contêiner. `mergeConfig` concatenaria o `include` dos
// unitários; aqui a lista é só a da bateria.
export default defineConfig({
  ...unitConfig,
  test: {
    ...unitConfig.test,
    include: [...AUTHZ_BATTERY],
  },
});
