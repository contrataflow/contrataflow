// pnpm --filter @contrataflow/api openapi:generate (turbo run openapi:generate no CI — US-079)
// Escreve o contrato OpenAPI 3.1 versionado em apps/api/openapi/api.v1.json (RN-FND-38).
import 'reflect-metadata';

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Logger } from '@nestjs/common';

import { API_MODULES } from '#modules/index.js';

import { buildOpenApiDocument, serializeOpenApi } from './openapi-document.js';

/** Contrato versionado, relativo a este arquivo (src/openapi ou dist/openapi). */
export const OPENAPI_FILE = new URL('../../openapi/api.v1.json', import.meta.url);

const target = fileURLToPath(OPENAPI_FILE);
mkdirSync(fileURLToPath(new URL('.', OPENAPI_FILE)), { recursive: true });
writeFileSync(target, serializeOpenApi(buildOpenApiDocument(API_MODULES)));
new Logger('OpenAPI').log(`openapi.generated file=${target}`);
