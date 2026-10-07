# ADR-001 — Monólito modular com DDD pragmático

| Campo | Valor |
|---|---|
| **Status** | Aceito |
| **Data** | 2026-10-06 |
| **Decisores** | Arquitetura/Tech Lead, Produto |
| **Decisões relacionadas** | DEC-040, DEC-041 |
| **Documentos** | [architecture.md](../architecture/architecture.md) §3-6, §14.1 · [domains.md](../architecture/domains.md) §2 · [ADR-002](adr-002-multi-tenancy.md) · [ADR-005](adr-005-workflow-engine.md) |

## Contexto

- O ContrataFlow é um SaaS B2G de contratações públicas (Lei 14.133/2021) com domínio grande e crescente: 23 módulos (bounded contexts) e 58 entidades já no MVP 1 (domains.md §2.1), com mais ~15 módulos reservados para os MVPs 2–5 (`pca`, `budget`, `legal-review`, `tender`, `publication`, `signature`, `integration`, `contract`, `ai`, entre outros — DEC-040).
- O "Processo de Contratação" é o agregado central (DEC-010) e várias operações de negócio alteram mais de um agregado na mesma ação do usuário — ex.: tramitação + aprovação + documento ao encaminhar um processo — exigindo atomicidade transacional entre módulos (DEC-041).
- A equipe é pequena e a infraestrutura precisa ser cloud-agnostic (ADR-004/DEC-058): qualquer estilo que multiplique deploys, bancos ou peças de infraestrutura por módulo tem custo operacional desproporcional neste estágio.
- Ao mesmo tempo, sem fronteiras explícitas entre contextos, um domínio deste tamanho tende ao "big ball of mud" conforme os módulos futuros forem chegando — a decisão precisa equilibrar velocidade do MVP 1 com disciplina de longo prazo, e deixar aberto um caminho de evolução para extrair módulos como serviços quando (e só quando) houver motivo medido.

## Decisão

1. **Monólito modular:** um único deploy por app (`apps/api`, `apps/web`, `apps/worker`), dividido internamente em módulos com **dono único por entidade** (DEC-040) — os 23 módulos/bounded contexts do MVP 1 (domains.md §2), organizados em níveis N0 (infraestrutura compartilhada) a N5 (leitura e efeitos colaterais), com regra de dependência unidirecional: um módulo não importa de um nível acima do seu.
2. **Camadas obrigatórias por módulo** (DEC-041): `domain/` (entidades, value objects, regras puras, eventos — sem NestJS, Prisma ou qualquer infraestrutura), `application/` (casos de uso, DTOs, políticas e a fachada pública `<modulo>.facade.ts`), `infrastructure/` (repositórios Prisma, adapters externos), `presentation/` (controllers REST, guards, OpenAPI).
3. **Comunicação entre módulos só por fachada pública ou eventos:** proibido importar `infrastructure/` ou `domain/` de outro módulo; um módulo só importa `application/<m>.facade.ts` (e seus DTOs) de outro módulo, respeitando os níveis.
4. **Transação única quando necessário:** chamadas síncronas entre fachadas ocorrem dentro da mesma Unit of Work do chamador; operações que alteram mais de um agregado (tramitação + aprovação + documento) usam uma única transação coordenada por um caso de uso — aceitável e desejável dentro de um monólito modular (DEC-041).
5. **Fronteiras verificadas no CI, não por convenção:** `dependency-cruiser` + ESLint bloqueiam o build em violações (`domain-is-pure`, `cross-module-only-via-facade`, `no-circular`, `worker-never-loads-presentation`, `system-prisma-allowlist`, `web-never-imports-api`), com a matriz de níveis gerada a partir de `tools/module-levels.json`.
6. **Caminho de extração explícito e condicionado:** um módulo só é extraído como serviço quando **todas** as pré-condições (fachada sem FKs cruzadas, contrato estável há ≥ 2 releases, observabilidade propagada, time dono capaz de operar) e **pelo menos um** motivador medido (perfil de carga distinto, isolamento de segurança, cadência de deploy própria, tecnologia diferente, conflito recorrente entre times) se confirmarem (architecture.md §14.1); o caminho é *strangler* — fachada vira cliente HTTP/gRPC, eventos saem por broker, tabelas migram de schema e depois de banco, mantendo `tenant_id` e RLS (ADR-002).

## Alternativas consideradas

| Alternativa | Prós | Contras | Motivo da decisão |
|---|---|---|---|
| Microsserviços desde o MVP 1 | Escala e deploy independentes por módulo; isolamento de falha entre contextos | Overhead operacional (N bancos/deploys) incompatível com equipe pequena e infraestrutura cloud-agnostic; transações distribuídas para operações hoje atômicas (tramitação+aprovação+documento); latência de rede entre 23 bounded contexts desde o início | **Rejeitada no MVP 1:** custo operacional não se paga sem motivador medido (§14.1); o caminho de extração por módulo fica preservado para quando fizer sentido |
| Monólito em camadas, sem módulos/DDD | Simplicidade inicial máxima; sem cerimônia de fachada | Sem fronteiras entre os 23 bounded contexts, o acoplamento cresce sem controle à medida que os módulos futuros (MVP 2–5) se somam; impossível medir critérios de extração por falta de limites internos | **Rejeitada:** o tamanho do domínio (58+ entidades, domains.md) exige fronteiras explícitas desde o início, não apenas camadas técnicas |
| Monólito modular com DDD pragmático | Um deploy simples por app; transação única entre agregados relacionados quando necessário; fronteiras de módulo verificadas automaticamente no CI; caminho de extração objetivo e incremental | Exige disciplina de fachada (DTOs, interfaces de repositório) mesmo em módulos pequenos; risco de módulo "deus" se a regra de fachada não for seguida | **Adotada** |

## Consequências

**Positivas**
- Deploy e operação simples (três apps) compatível com equipe pequena e infraestrutura cloud-agnostic.
- Transações atômicas entre agregados relacionados (tramitação, aprovação, documento) sem coreografia distribuída.
- Fronteiras entre os 23 bounded contexts (domains.md §2) são checadas automaticamente no CI, não dependem de revisão manual.
- Caminho de extração para serviço é conhecido antes de ser necessário (critérios objetivos do §14.1), evitando decisão por pressão de prazo.

**Negativas**
- `domain/` puro e fachada obrigatória adicionam cerimônia (DTOs, interfaces de repositório) mesmo em módulos pequenos.
- Falha de um módulo compartilha o mesmo processo e domínio de falha do app inteiro (sem isolamento de processo entre módulos).
- O crescimento previsto para ~38 módulos (23 atuais + futuros) pode pressionar o tempo de build e o tamanho do grafo de dependências.
- "Noisy neighbor" dentro do mesmo processo: um módulo custoso consome recursos de todos os outros.

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Módulo "deus" acumulando lógica de outros módulos | Dono único por entidade (DEC-040); revisão de PR; bloqueio automático de importação cruzada no CI |
| Importação direta de `infrastructure`/`domain` de outro módulo | Regras `domain-is-pure` e `cross-module-only-via-facade` no `dependency-cruiser` (falha o build) |
| Fachada instável quebrando múltiplos consumidores | Contrato de fachada estável exigido antes de qualquer extração (§14.1); testes de contrato |
| Transação longa coordenando muitos agregados | Timeout de transação (10 s) e `statement_timeout` (5 s) por instrução (architecture.md §6.5) |
| Build/CI lento com o crescimento do monólito | Turborepo com cache e pipeline incremental (architecture.md §4.5) |
| Extração de módulo prematura ou tardia | Critérios objetivos e medidos (§14.1) em vez de decisão subjetiva |

## Critérios de revisão

- Um módulo passa a satisfazer todas as pré-condições **e** ao menos um motivador medido do §14.1 → iniciar extração via *strangler*.
- Conflito de deploy recorrente entre dois ou mais times responsáveis pelo mesmo módulo.
- Perfil de carga de um módulo (ex.: `ai`, renderização de documento) exigindo escalar o monólito inteiro com custo mais de 30% acima do necessário.
- Requisito de isolamento de segurança/conformidade para um módulo exposto externamente (`integration`, `public-api`).

## Referências
- DEC-040, DEC-041 — [decisions.md](../architecture/decisions.md).
- [architecture.md](../architecture/architecture.md) §3.3 (componentes/módulos), §4.2–4.4 (responsabilidades, regras de dependência, verificação automática), §5 (estrutura interna de módulo), §6.5 (Unit of Work), §6.7 (fachadas), §14.1 (critérios de extração).
- [domains.md](../architecture/domains.md) §2.1 (bounded contexts × módulos).
- [ADR-002](adr-002-multi-tenancy.md) (isolamento multi-tenant dentro do monólito), [ADR-004](adr-004-outbox-events.md) (eventos entre módulos), [ADR-005](adr-005-workflow-engine.md) (módulo `workflow`).
