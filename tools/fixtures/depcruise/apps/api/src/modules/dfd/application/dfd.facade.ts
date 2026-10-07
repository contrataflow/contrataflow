// Permitido: fachada e módulo Nest de nível inferior (dfd → process).
import { ProcessFacade } from '../../process/application/process.facade.js';
import { ProcessModule } from '../../process/process.module.js';

export const dependencies = [ProcessFacade, ProcessModule];
