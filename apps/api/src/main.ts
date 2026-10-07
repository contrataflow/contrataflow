import 'reflect-metadata';

import { httpConfig } from '#config/http.config.js';

import { startApi } from './bootstrap.js';

await startApi({ port: httpConfig.port });
