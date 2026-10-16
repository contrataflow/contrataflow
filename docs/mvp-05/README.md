# MVP 5 — Inteligência e IA

> **Status: reservado.** Este MVP será especificado em profundidade somente após o fechamento do MVP anterior e a validação de dependências, entidades existentes, impactos, mudanças de arquitetura e migrações necessárias (governança descrita em [../product/roadmap.md](../product/roadmap.md) e [../mvp-01/risks-and-decisions.md §12](../mvp-01/risks-and-decisions.md#12-validação-para-iniciar-o-mvp-2)).

## Escopo previsto (do briefing do produto)

Assistente contextual; Validação automática (ex.: "Quantidade divergente entre ETP e TR"; "Garantia divergente"); Saúde do processo; Recomendações; Busca de contratações similares; Benchmark de preços; Detecção de gargalos; Previsão de atraso.

**Saiu do escopo deste MVP (2026-10-16, DEC-037):** a **geração** de documentos com IA — rascunho completo e ajuste por seção de DFD, ETP, mapa de riscos e TR — foi antecipada para o MVP 1 (EP-020, US-115..US-122). Continuam aqui: validações cruzadas, saúde do processo, recomendações, benchmark, busca semântica, detecção de gargalos, previsão de atraso e o assistente conversacional.

## Telas previstas

Assistente IA (40)

## Impactos já identificados no modelo do MVP 1

- Camada `AiProvider`, módulo `ai`, fila `ai-generation` e registro `AiGeneration` **já existem desde o MVP 1** (DEC-079; provedor em ADR-013). Este MVP acrescenta `AIAnalysis` (avaliar estender `AiGeneration` e alinhar o nome — DOM-01), `ValidationResult` e `Embedding` (pgvector)
- Reaproveitar do MVP 1: rastreabilidade (modelo, versão do prompt, entradas, tokens, custo), limites por órgão (`ai.*`), `AI_GENERATE`/POL-18, marcações "gerado por IA"/[a confirmar] e revisão humana (US-122), conjunto de avaliação `pnpm ai:eval`
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
