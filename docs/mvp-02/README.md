# MVP 2 — Governança e Controle

> **Status: reservado.** Este MVP será especificado em profundidade somente após o fechamento do MVP anterior e a validação de dependências, entidades existentes, impactos, mudanças de arquitetura e migrações necessárias (governança descrita em [../product/roadmap.md](../product/roadmap.md) e [../mvp-01/risks-and-decisions.md §12](../mvp-01/risks-and-decisions.md#12-validação-para-iniciar-o-mvp-2)).

## Escopo previsto (do briefing do produto)

PCA; Dotação orçamentária; Jurídico (status aguardando, em análise, diligência, favorável, favorável com ressalvas, desfavorável; parecer e devolução por diligência); Controle Interno; Edital; SLA; Indicadores; Gargalos; Regras condicionais.

**Geração com IA (DEC-037):** quando existirem, o **parecer jurídico** e o **edital** ganham geração assistida por IA — rascunho completo e ajuste por seção — sobre a camada do MVP 1 (EP-020): mesmos princípios (a IA não decide; nada inventado, com [a confirmar]; revisão humana obrigatória; rastreabilidade; limites por órgão), novos geradores e prompts versionados.

## Telas previstas

PCA (18), Jurídico (19), Controle Interno (20), Edital (21), Relatórios (27), Relatório detalhado (28), Regras — biblioteca completa (35)

## Impactos já identificados no modelo do MVP 1

- Nova versão do workflow padrão com Dotação, Jurídico e Controle Interno entre as etapas 6 e 7 (DEC-015)
- Entidades `Pca`, `PcaItem`, `BudgetAllocation`, `LegalReview`, `InternalControlReview`, `Tender`; FK `pcaItemId` em `Process` e `Dfd` com reconciliação das referências do MVP 1 (DEC-029)
- `Approval.decisionPolicy` (múltiplos aprovadores — PEND-13) e migração de processos entre versões de workflow (DT-02)
- Read model de indicadores (tempo por etapa/unidade, gargalos) a partir de `ProcessStage`, `ProcessAssignment` e `ProcessMovement`
- IA: `targetModule` de `AiGeneration` passa a aceitar os tipos de parecer e edital (hoje `DFD`, `ETP`, `RISK_MAP`, `TERM_OF_REFERENCE`); geradores `draft.legal_opinion`/`draft.tender` com entradas em cadeia (TR, pesquisa de preços, riscos); permissões de edição dos novos tipos entram na POL-18

## Arquivos que serão produzidos

Mesma estrutura do MVP 1: `overview.md`, `epics.md`, `features.md`, `entities.md`, `api.md`, `screens.md`, `permissions.md`, `events.md`, `acceptance-criteria.md`, `tests.md`, `delivery-plan.md`, `risks-and-decisions.md`, `release-checklist.md`, além dos cards em `../backlog/` com numeração global contínua (EP/FT/US).

## Checklist de validação antes de detalhar

- [ ] MVP anterior liberado e estável nos pilotos
- [ ] Dependências funcionais e técnicas confirmadas
- [ ] Entidades existentes reutilizadas (sem duplicar conceitos — [domains.md](../architecture/domains.md))
- [ ] Impactos em workflow, permissões, eventos e telas mapeados
- [ ] Mudanças de arquitetura registradas em ADR
- [ ] Migrações necessárias planejadas (expand/contract)
