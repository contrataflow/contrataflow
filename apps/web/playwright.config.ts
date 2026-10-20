// E2E do estágio 7 (US-079 — RN-FND-27): Playwright + axe-core contra o build de produção do web,
// com a infraestrutura do Compose da US-078 de pé (`pnpm env:up && pnpm env:seed`), Authentik real.
// O shell (US-086) roda contra a API simulada de test/e2e/support/mock-api.mjs e o provedor de
// identidade fake (FA-06), sem depender do Authentik.
// Rodar: pnpm turbo run test:e2e (o Turborepo faz o build antes).
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.WEB_PORT ?? 3000);
const MOCK_API_PORT = Number(process.env.MOCK_API_PORT ?? 4010);
const CI = process.env.CI === 'true' || process.env.CI === '1';
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  // Um servidor web e uma API simulada para todos: com mais workers a máquina local satura (o BFF
  // responde 500 por falta de CPU) e os testes ficam instáveis. 2 é o que o runner do CI usa.
  workers: 2,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  use: {
    baseURL: BASE_URL,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    trace: 'retain-on-failure',
  },
  metadata: {
    // Issuer do Authentik do Compose (o mesmo do .env.example).
    oidcIssuer: process.env.OIDC_ISSUER_URL ?? 'http://localhost:9080/application/o/contrataflow/',
    // API simulada do E2E do shell (US-086).
    mockApiUrl: `http://localhost:${MOCK_API_PORT}`,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `node test/e2e/support/mock-api.mjs ${MOCK_API_PORT}`,
      url: `http://localhost:${MOCK_API_PORT}/__mock/health`,
      reuseExistingServer: !CI,
      timeout: 30_000,
    },
    {
      command: `pnpm exec next start --port ${PORT}`,
      url: BASE_URL,
      reuseExistingServer: !CI,
      timeout: 120_000,
      env: {
        APP_ENV: 'test',
        APP_BASE_URL: BASE_URL,
        API_INTERNAL_URL: `http://localhost:${MOCK_API_PORT}`,
        TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
        OIDC_ISSUER_URL:
          process.env.OIDC_ISSUER_URL ?? 'http://localhost:9080/application/o/contrataflow/',
        OIDC_FAKE_SIGNING_KEY: 'dev-only-fake-jwt-signing-key-000000000000',
        // RN-IAM-10 limita a 10 sessões por pessoa; quase todo cenário entra como "ana" e, em
        // paralelo, o 11º login encerraria a sessão de um teste ainda em andamento.
        SESSION_MAX_PER_USER: '1000',
      },
    },
  ],
});
