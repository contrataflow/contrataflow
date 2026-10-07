import { PERMISSION_CODES } from '../../types/src/index.js';
import { schema } from '../../validation/src/index.js';

export const editorSchemaVersion = [PERMISSION_CODES, schema].length;
