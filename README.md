# ContrataFlow

SaaS B2G multi-tenant para a fase preparatória das contratações públicas (Lei 14.133/2021):
processo → DFD → ETP → pesquisa de preços → mapa de riscos → TR → aprovação da autoridade.

- **Especificação (fonte da verdade):** [`docs/`](docs/README.md)
- **Como contribuir, padrões e scripts:** [`CONTRIBUTING.md`](CONTRIBUTING.md)
- **Versões fixadas:** [`docs/engineering/versions.md`](docs/engineering/versions.md)

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build && pnpm turbo run lint typecheck test
pnpm dev   # web http://localhost:3000 · api http://localhost:4000 · worker
```
