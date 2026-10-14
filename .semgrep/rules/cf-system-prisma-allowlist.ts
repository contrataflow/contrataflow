// Casos de teste da regra (semgrep --test .semgrep/rules).
// ruleid: cf-system-prisma-allowlist
import { SystemPrismaService } from '#shared/database/system-prisma.service.js';

declare const tenantPrisma: { process: { findMany: () => Promise<unknown[]> } };

export class ProcessRepository {
  constructor(private readonly systemPrisma: SystemPrismaService) {}

  list() {
    // ruleid: cf-system-prisma-allowlist
    return this.systemPrisma.process.findMany();
  }

  listForTenant() {
    // ok: cf-system-prisma-allowlist
    return tenantPrisma.process.findMany();
  }
}
