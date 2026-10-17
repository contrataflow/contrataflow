import { InMemoryTenantSettingsRepository } from '#modules/tenancy/infrastructure/in-memory-tenant-settings.repository.js';

import type { TestApi } from './api-test-app.js';

/**
 * Configurações do tenant em memória (modo de identidade fake) para semear `settings` nos testes
 * de outros módulos — que não podem importar o `tenancy` (níveis de módulo · architecture.md §3.3).
 */
export function inMemoryTenantSettings(api: TestApi): InMemoryTenantSettingsRepository {
  return api.app.get(InMemoryTenantSettingsRepository, { strict: false });
}
