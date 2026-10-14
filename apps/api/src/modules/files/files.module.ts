import { Module } from '@nestjs/common';

import { FilesFacade } from './application/files.facade.js';

/** Módulo `files` (DEC-040): outros módulos usam somente a fachada exportada. */
@Module({
  providers: [FilesFacade],
  exports: [FilesFacade],
})
export class FilesModule {}
