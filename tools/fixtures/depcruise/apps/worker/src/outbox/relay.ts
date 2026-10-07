// Permitido: relay usa o papel de plataforma e a fachada de um módulo.
import { ProcessFacade } from '../../../api/src/modules/process/application/process.facade.js';
import { SystemPrismaService } from '../../../api/src/shared/database/system-prisma.service.js';

export const dependencies = [ProcessFacade, SystemPrismaService];
