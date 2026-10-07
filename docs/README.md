# ContrataFlow — Documentação de Produto e Engenharia

> **Status:** Especificação da fundação + MVP 1 (Planejamento e Tramitação).
> MVPs 2 a 5 estão descritos apenas em nível de visão no [roadmap](product/roadmap.md) e serão detalhados um de cada vez, após validação de dependências, entidades existentes, impactos, mudanças de arquitetura e migrações necessárias.
> **Nenhum código de produção deve ser escrito sem que o card correspondente esteja especificado neste repositório.**

## 1. Como navegar

| Pasta | Conteúdo | Comece por |
|---|---|---|
| [`product/`](product/) | Visão do produto, personas, roadmap dos 5 MVPs, terminologia | [product-overview.md](product/product-overview.md) |
| [`architecture/`](architecture/) | Arquitetura, domínios e ERD, multi-tenancy, segurança, autenticação, storage, filas, observabilidade, **registro de decisões** | [decisions.md](architecture/decisions.md) |
| [`adr/`](adr/) | Architecture Decision Records | [adr-001](adr/adr-001-modular-monolith.md) |
| [`engineering/`](engineering/) | Versões fixadas da stack e política de atualização (padrões de código em [`CONTRIBUTING.md`](../CONTRIBUTING.md)) | [versions.md](engineering/versions.md) |
| [`mvp-01/`](mvp-01/) | Especificação completa do MVP 1 | [overview.md](mvp-01/overview.md) |
| [`backlog/`](backlog/) | Épicos, features e stories (cards) no padrão oficial | [backlog/README.md](backlog/README.md) |
| `mvp-02/` … `mvp-05/` | Reservadas — serão preenchidas na ordem do roadmap | — |

### Fontes canônicas (em caso de conflito, estas prevalecem)

1. [`architecture/decisions.md`](architecture/decisions.md) — decisões vinculantes (DEC-NNN).
2. [`mvp-01/entities.md`](mvp-01/entities.md) — modelo de dados (nomes de entidades, campos, enums).
3. [`mvp-01/permissions.md`](mvp-01/permissions.md) — catálogo de permissões e perfis padrão.
4. [`mvp-01/events.md`](mvp-01/events.md) — catálogo de eventos de domínio.
5. [`mvp-01/api.md`](mvp-01/api.md) — contrato da API REST.

Qualquer card, tela ou teste que cite um nome que não exista nessas fontes está **errado** e deve ser corrigido (ou a fonte canônica deve ser atualizada primeiro, com registro em `decisions.md`).

## 2. Convenções de documentação

### 2.1 Idioma
- Documentação, interface, mensagens ao usuário e e-mails: **português (pt-BR)**.
- Identificadores técnicos (entidades, campos, enums, permissões, eventos, filas, rotas da API, chaves de configuração): **inglês**. Siglas brasileiras de domínio são mantidas (DFD, ETP, PCA, TR → `Dfd`, `Etp`, `Pca`, `TermOfReference`).
- O mapeamento termo de negócio ↔ identificador técnico está em [`product/terminology.md`](product/terminology.md).

### 2.2 Identificadores de documentação

| Artefato | Formato | Exemplo | Arquivo |
|---|---|---|---|
| Épico | `EP-NNN` | EP-001 | `backlog/epic-001-process.md` |
| Feature | `FT-NNN` | FT-001 | `backlog/feature-001-create-process.md` |
| Story (card) | `US-NNN` | US-001 | `backlog/story-001-create-process.md` |
| Decisão | `DEC-NNN` | DEC-013 | `architecture/decisions.md` |
| Decisão pendente | `PEND-NN` | PEND-02 | `architecture/decisions.md` |
| ADR | `ADR-NNN` | ADR-002 | `adr/adr-002-multi-tenancy.md` |
| Regra de negócio | `RN-<área>-NN` | RN-PROC-03 | dentro do card/feature |
| Tela | `SCR-NNN` | SCR-006 | `mvp-01/screens.md` |

A numeração de EP/FT/US é **global e contínua** entre MVPs (o MVP 2 continua a partir do último número usado no MVP 1). IDs nunca são reutilizados; itens descartados são marcados como `Cancelado`.

### 2.3 Padrões de card
- Modelos oficiais: [`backlog/_templates/`](backlog/_templates/).
- Toda story segue **exatamente** as 28 seções do padrão de card (Título … Prioridade).
- Critérios de aceite sempre em **Gherkin** (palavras-chave `Given/When/Then/And/But` em inglês, texto em pt-BR), cobrindo no mínimo: sucesso, validação, falta de permissão, tenant incorreto, duplicidade, concorrência, falha de banco e falha de integração.
- Estimativa: `XS` (≤ ½ dia), `S` (1–2 dias), `M` (3–5 dias), `L` (6–10 dias), `XL` (> 10 dias — deve ser quebrada antes de entrar em sprint).
- Prioridade: `P0` (bloqueia o MVP), `P1` (necessária para o release do MVP), `P2` (desejável; pode ir para o release seguinte), `P3` (oportunidade).

### 2.4 Diagramas
Diagramas em **Mermaid** dentro dos próprios arquivos Markdown (renderizam no GitHub/GitLab e em IDEs).

## 3. Mapa de documentos

```
docs/
├── README.md                      ← você está aqui
├── product/
│   ├── product-overview.md
│   ├── personas.md
│   ├── roadmap.md
│   └── terminology.md
├── architecture/
│   ├── architecture.md
│   ├── domains.md                 ← bounded contexts + ERD conceitual (todos os MVPs)
│   ├── multi-tenancy.md
│   ├── security.md
│   ├── authentication.md
│   ├── storage.md
│   ├── queues.md
│   ├── observability.md
│   └── decisions.md               ← registro canônico de decisões
├── adr/
│   └── adr-NNN-*.md
├── engineering/
│   └── versions.md                ← versões fixadas, política de atualização e medições de build (US-077)
├── mvp-01/
│   ├── overview.md                ← objetivo, escopo, fechamento do MVP
│   ├── epics.md
│   ├── features.md
│   ├── entities.md
│   ├── api.md                     ← convenções, erros, catálogo (269 operações) e índice do §4
│   ├── api/                       ← §4: detalhe por endpoint, um arquivo por seção do catálogo (01..15)
│   ├── screens.md
│   ├── permissions.md
│   ├── events.md
│   ├── acceptance-criteria.md
│   ├── tests.md
│   ├── delivery-plan.md           ← backlog priorizado, dependências, ordem, sequência de implementação
│   ├── risks-and-decisions.md     ← riscos, débitos, ambiguidades, regras configuráveis, decisões pendentes
│   └── release-checklist.md       ← DoD, itens postergados, checklist de release
├── mvp-02/ … mvp-05/              ← reservadas
└── backlog/
    ├── README.md                  ← índice navegável de EP/FT/US
    ├── _templates/
    ├── epic-NNN-*.md
    ├── feature-NNN-*.md
    └── story-NNN-*.md
```
