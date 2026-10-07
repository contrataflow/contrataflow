# @contrataflow/eslint-config

ESLint 9 (_flat config_) compartilhado. Cada pacote tem um `eslint.config.mjs` que chama a
fábrica adequada com o próprio diretório:

```js
import { nest } from '@contrataflow/eslint-config/nest';

export default nest({ tsconfigRootDir: import.meta.dirname });
```

| Export      | Uso                                                                         |
| ----------- | --------------------------------------------------------------------------- |
| `base`      | TypeScript _type-checked_ estrito + import-x + segurança (todas as demais). |
| `node`      | Pacotes e scripts Node.js.                                                  |
| `nest`      | `apps/api`, `apps/worker`.                                                  |
| `react`     | `packages/ui` (jsx-a11y estrito + react-hooks).                             |
| `next`      | `apps/web` (react + `@next/eslint-plugin-next`).                            |
| `storybook` | Ajustes para `*.stories.tsx` (o plugin oficial entra com a US-086).         |
| `security`  | Somente as proibições da RN-FND-06 (usado pelas _fixtures_ de violação).    |

## Proibições de segurança (RN-FND-06)

| Regra                                           | Proíbe                                     | Permitido em                                    |
| ----------------------------------------------- | ------------------------------------------ | ----------------------------------------------- |
| `contrataflow/no-unsafe-raw-query`              | `$queryRawUnsafe` / `$executeRawUnsafe`    | —                                               |
| `contrataflow/no-dangerous-html`                | `dangerouslySetInnerHTML`                  | `**/sanitized-html-preview.tsx`                 |
| `contrataflow/no-console`                       | `console.*`                                | arquivos `*.config.*`; scripts de `tools/`      |
| `contrataflow/no-process-env`                   | `process.env`                              | `**/src/config/**`, arquivos `*.config.*`       |
| `contrataflow/no-dynamic-code`                  | `eval`, `new Function`, timers com string  | —                                               |
| `contrataflow/no-direct-redis`                  | `ioredis`, `redis`, `@redis/*`, `iovalkey` | `**/shared/cache/**`, `**/modules/platform/**`  |
| `contrataflow/no-prisma-outside-infrastructure` | `@prisma/client`                           | `**/infrastructure/**`, `**/shared/database/**` |
| `contrataflow/require-server-only`              | arquivo do BFF sem `import 'server-only'`  | obrigatório em `**/src/bff/**`                  |

Também: `@typescript-eslint/no-explicit-any` e `@typescript-eslint/ban-ts-comment`
(`@ts-expect-error` só com descrição ≥ 10 caracteres). As _fixtures_ de violação ficam em
`tools/fixtures/lint/**` e são verificadas pelos testes de `@contrataflow/tools`.
