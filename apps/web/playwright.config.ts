// E2E do estágio 7 (US-079 — RN-FND-27): Playwright + axe-core contra o build de produção do web,
// com a infraestrutura do Compose da US-078 de pé (`pnpm env:up && pnpm env:seed`), Authentik real.
// Rodar: pnpm turbo run test:e2e (o Turborepo faz o build antes).
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.WEB_PORT ?? 3000);
const CI = process.env.CI === 'true' || process.env.CI === '1';

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    trace: 'retain-on-failure',
  },
  metadata: {
    // Issuer do Authentik do Compose (o mesmo do .env.example).
    oidcIssuer: process.env.OIDC_ISSUER_URL ?? 'http://localhost:9080/application/o/contrataflow/',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec next start --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !CI,
    timeout: 120_000,
  },
});
