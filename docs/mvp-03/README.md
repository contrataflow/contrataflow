# MVP 3 — Integrações e Publicação

> **Status: reservado.** Este MVP será especificado em profundidade somente após o fechamento do MVP anterior e a validação de dependências, entidades existentes, impactos, mudanças de arquitetura e migrações necessárias (governança descrita em [../product/roadmap.md](../product/roadmap.md) e [../mvp-01/risks-and-decisions.md §12](../mvp-01/risks-and-decisions.md#12-validação-para-iniciar-o-mvp-2)).

## Escopo previsto (do briefing do produto)

Publicações; PNCP; Diário Oficial; assinatura eletrônica; API pública; Webhooks; adapters de integração; retries; idempotência. Interface `PublicationProvider` com `PNCPProvider`, `DiarioOficialProvider` e `PortalMunicipalProvider`.

## Telas previstas

Publicações (16), Nova publicação (17), Integrações (38)

## Impactos já identificados no modelo do MVP 1

- Transição `COMPLETED → PUBLISHED` (DEC-013) e entidades `Publication`, `PublicationAttempt`
- `SignatureRequest` e `DocumentRendition` do tipo `SIGNED`; avaliação de PDF/A (PEND-09)
- `Integration` (credenciais criptografadas por tenant), `Webhook`/`WebhookDelivery` consumindo o outbox, `ApiClient` com vínculo `SERVICE`
- Contratos de eventos públicos versionados separadamente dos eventos internos (events.md §8)

## Arquivos que serão produzidos

Mesma estrutura do MVP 1: `overview.md`, `epics.md`, `features.md`, `entities.md`, `api.md`, `screens.md`, `permissions.md`, `events.md`, `acceptance-criteria.md`, `tests.md`, `delivery-plan.md`, `risks-and-decisions.md`, `release-checklist.md`, além dos cards em `../backlog/` com numeração global contínua (EP/FT/US).

## Checklist de validação antes de detalhar

- [ ] MVP anterior liberado e estável nos pilotos
- [ ] Dependências funcionais e técnicas confirmadas
- [ ] Entidades existentes reutilizadas (sem duplicar conceitos — [domains.md](../architecture/domains.md))
- [ ] Impactos em workflow, permissões, eventos e telas mapeados
- [ ] Mudanças de arquitetura registradas em ADR
- [ ] Migrações necessárias planejadas (expand/contract)
