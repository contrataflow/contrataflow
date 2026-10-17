import { Injectable } from '@nestjs/common';

import type { SupplierUsageProvider } from './supplier-ports.js';
import { SupplierUsageRegistry } from './supplier-usage.registry.js';

/**
 * API pública do módulo `supplier` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório.
 */
@Injectable()
export class SupplierFacade {
  constructor(private readonly usage: SupplierUsageRegistry) {}

  /**
   * `price-research` (US-026) registra, no `onModuleInit`, quem sabe se um fornecedor está
   * referenciado por `PriceSource` não excluída — a exclusão (SUP-05) é recusada enquanto estiver
   * (RN-PRICE-19). Módulos de nível superior chamam; `supplier` não conhece quem usa.
   */
  registerUsageProvider(provider: SupplierUsageProvider): void {
    this.usage.register(provider);
  }
}
