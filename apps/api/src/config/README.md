# Configuração (`src/config/`)

Único lugar onde `process.env` pode ser lido (RN-FND-06).

- `env.ts` — schema Zod único das variáveis da API (RN-FND-30) e `loadConfig()`: variável ausente ou
  inválida impede o boot com `api.config_invalid keys=…` (só as chaves, nunca os valores).
- `config.module.ts` — `ConfigModule` global; injete com `@Inject(APP_CONFIG) config: AppConfig`.

Variável nova: acrescente ao `envSchema`, exponha em `AppConfig` e documente em
`docs/architecture/architecture.md` §10.2 e no `.env.example`.
