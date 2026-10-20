import { defineConfig, mergeConfig } from 'vitest/config';
import type { ViteUserConfig } from 'vitest/config';

import integrationConfig from './vitest.integration.config.js';

// Suíte de performance com Testcontainers (`test:perf` — medida no endurecimento, DEC-087): um
// arquivo por vez, sem disputar CPU com as suítes de integração paralelas. O `include` é substituído (o
// `mergeConfig` concatenaria com o dos testes unitários e de integração).
const merged: ViteUserConfig = mergeConfig(
  integrationConfig,
  defineConfig({ test: { fileParallelism: false } }),
);

export default defineConfig({
  ...merged,
  test: { ...merged.test, include: ['test/**/*.perf.ts'] },
});
