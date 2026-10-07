# MVP 4 — Gestão Contratual

> **Status: reservado.** Este MVP será especificado em profundidade somente após o fechamento do MVP anterior e a validação de dependências, entidades existentes, impactos, mudanças de arquitetura e migrações necessárias (governança descrita em [../product/roadmap.md](../product/roadmap.md) e [../mvp-01/risks-and-decisions.md §12](../mvp-01/risks-and-decisions.md#12-validação-para-iniciar-o-mvp-2)).

## Escopo previsto (do briefing do produto)

Contratos (número, processo, fornecedor, objeto, valor, início, fim, fiscal, gestor, status rascunho/vigente/suspenso/encerrado/rescindido); Fiscalização; Medições; Ocorrências; Aditivos; Reajustes; Vencimentos (alertas 180/120/90/60/30 dias); Renovação.

## Telas previstas

Contratos (22), Detalhe do contrato (23), Fiscalização (24), Medições (25), Aditivos (26)

## Impactos já identificados no modelo do MVP 1

- Entidades `Contract`, `ContractItem` (a partir de `ProcessItem`), `ContractManager`, `ContractInspector`, `ContractMeasurement`, `ContractOccurrence`, `ContractAmendment`
- Reuso de `Supplier`, `Document`, `Approval`, `Notification` e do job `deadlines` para vencimentos
- Ampliação dos perfis `FISCAL_CONTRATO` e `GESTOR_CONTRATO`

## Arquivos que serão produzidos

Mesma estrutura do MVP 1: `overview.md`, `epics.md`, `features.md`, `entities.md`, `api.md`, `screens.md`, `permissions.md`, `events.md`, `acceptance-criteria.md`, `tests.md`, `delivery-plan.md`, `risks-and-decisions.md`, `release-checklist.md`, além dos cards em `../backlog/` com numeração global contínua (EP/FT/US).

## Checklist de validação antes de detalhar

- [ ] MVP anterior liberado e estável nos pilotos
- [ ] Dependências funcionais e técnicas confirmadas
- [ ] Entidades existentes reutilizadas (sem duplicar conceitos — [domains.md](../architecture/domains.md))
- [ ] Impactos em workflow, permissões, eventos e telas mapeados
- [ ] Mudanças de arquitetura registradas em ADR
- [ ] Migrações necessárias planejadas (expand/contract)
