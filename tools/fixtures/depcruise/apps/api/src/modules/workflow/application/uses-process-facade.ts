// Violação: module-levels (workflow, nível 2, não depende de process, nível 3).
import { ProcessFacade } from '../../process/application/process.facade.js';

export const facade = ProcessFacade;
