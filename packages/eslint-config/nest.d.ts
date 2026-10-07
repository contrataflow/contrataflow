import type { Linter } from 'eslint';

import type { ConfigOptions } from './base.js';

export declare function nest(options: ConfigOptions): Linter.Config[];
