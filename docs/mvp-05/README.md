# MVP 5 — Inteligência e IA

> **Status: reservado.** Este MVP será especificado em profundidade somente após o fechamento do MVP anterior e a validação de dependências, entidades existentes, impactos, mudanças de arquitetura e migrações necessárias (governança descrita em [../product/roadmap.md](../product/roadmap.md) e [../mvp-01/risks-and-decisions.md §12](../mvp-01/risks-and-decisions.md#12-validação-para-iniciar-o-mvp-2)).

## Escopo previsto (do briefing do produto)

Assistente contextual; Validação automática (ex.: "Quantidade divergente entre ETP e TR"; "Garantia divergente"); Saúde do processo; Recomendações; Busca de contratações similares; Benchmark de preços; Detecção de gargalos; Previsão de atraso.

## Telas previstas

Assistente IA (40)

## Impactos já identificados no modelo do MVP 1

- Camada `AiProvider` (OpenAI, Anthropic, Azure OpenAI), entidades `AIAnalysis`, `ValidationResult`, `Embedding` (pgvector)
- Validações cruzadas sobre `DocumentItem` por `processItemId` (DEC-019) e campos tipados (ex.: `productWarrantyMonths`)
- IA sempre assistiva: nenhuma decisão sem aprovação humana (princípio 16); registro de prompts/versões e custos

## Arquivos que serão produzidos

Mesma estrutura do MVP 1: `overview.md`, `epics.md`, `features.md`, `entities.md`, `api.md`, `screens.md`, `permissions.md`, `events.md`, `acceptance-criteria.md`, `tests.md`, `delivery-plan.md`, `risks-and-decisions.md`, `release-checklist.md`, além dos cards em `../backlog/` com numeração global contínua (EP/FT/US).

## Checklist de validação antes de detalhar

- [ ] MVP anterior liberado e estável nos pilotos
- [ ] Dependências funcionais e técnicas confirmadas
- [ ] Entidades existentes reutilizadas (sem duplicar conceitos — [domains.md](../architecture/domains.md))
- [ ] Impactos em workflow, permissões, eventos e telas mapeados
- [ ] Mudanças de arquitetura registradas em ADR
- [ ] Migrações necessárias planejadas (expand/contract)
