# MVP 2 — Governança e Controle

> **Status: reservado.** Este MVP será especificado em profundidade somente após o fechamento do MVP anterior e a validação de dependências, entidades existentes, impactos, mudanças de arquitetura e migrações necessárias (governança descrita em [../product/roadmap.md](../product/roadmap.md) e [../mvp-01/risks-and-decisions.md §12](../mvp-01/risks-and-decisions.md#12-validação-para-iniciar-o-mvp-2)).

## Escopo previsto (do briefing do produto)

PCA; Dotação orçamentária; Jurídico (status aguardando, em análise, diligência, favorável, favorável com ressalvas, desfavorável; parecer e devolução por diligência); Controle Interno; Edital; SLA; Indicadores; Gargalos; Regras condicionais.

## Telas previstas

PCA (18), Jurídico (19), Controle Interno (20), Edital (21), Relatórios (27), Relatório detalhado (28), Regras — biblioteca completa (35)

## Impactos já identificados no modelo do MVP 1

- Nova versão do workflow padrão com Dotação, Jurídico e Controle Interno entre as etapas 6 e 7 (DEC-015)
- Entidades `Pca`, `PcaItem`, `BudgetAllocation`, `LegalReview`, `InternalControlReview`, `Tender`; FK `pcaItemId` em `Process` e `Dfd` com reconciliação das referências do MVP 1 (DEC-029)
- `Approval.decisionPolicy` (múltiplos aprovadores — PEND-13) e migração de processos entre versões de workflow (DT-02)
- Read model de indicadores (tempo por etapa/unidade, gargalos) a partir de `ProcessStage`, `ProcessAssignment` e `ProcessMovement`

## Arquivos que serão produzidos

Mesma estrutura do MVP 1: `overview.md`, `epics.md`, `features.md`, `entities.md`, `api.md`, `screens.md`, `permissions.md`, `events.md`, `acceptance-criteria.md`, `tests.md`, `delivery-plan.md`, `risks-and-decisions.md`, `release-checklist.md`, além dos cards em `../backlog/` com numeração global contínua (EP/FT/US).

## Checklist de validação antes de detalhar

- [ ] MVP anterior liberado e estável nos pilotos
- [ ] Dependências funcionais e técnicas confirmadas
- [ ] Entidades existentes reutilizadas (sem duplicar conceitos — [domains.md](../architecture/domains.md))
- [ ] Impactos em workflow, permissões, eventos e telas mapeados
- [ ] Mudanças de arquitetura registradas em ADR
- [ ] Migrações necessárias planejadas (expand/contract)
