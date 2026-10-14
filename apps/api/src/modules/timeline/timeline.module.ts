import { Module } from '@nestjs/common';

import { TimelineFacade } from './application/timeline.facade.js';

/** Módulo `timeline` (DEC-040): outros módulos usam somente a fachada exportada. */
@Module({
  providers: [TimelineFacade],
  exports: [TimelineFacade],
})
export class TimelineModule {}
