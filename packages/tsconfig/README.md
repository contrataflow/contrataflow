# @contrataflow/tsconfig

Bases TypeScript estritas (RN-FND-03). Todo pacote estende uma delas:

| Base           | Uso                                                                  |
| -------------- | -------------------------------------------------------------------- |
| `base.json`    | Opções estritas comuns (nunca usada diretamente).                    |
| `node.json`    | `apps/api`, `apps/worker`, `tools` — ESM com `NodeNext`, `ES2024`.   |
| `library.json` | `packages/*` compilados com declarações (`.d.ts`).                   |
| `next.json`    | `apps/web` — `moduleResolution: Bundler`, `jsx: preserve`, sem emit. |

`any` explícito, `@ts-ignore` e `@ts-nocheck` são barrados pelo ESLint (`@contrataflow/eslint-config`).
