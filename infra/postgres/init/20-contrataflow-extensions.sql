-- RN-FND-14 · DEC-050 · DEC-057 — extensões só no banco da aplicação (o banco `authentik` não
-- recebe nenhuma). O schema da aplicação nasce das migrações do Prisma (US-081).
\connect contrataflow

CREATE EXTENSION IF NOT EXISTS vector;   -- pgvector (busca semântica — MVP 5)
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- número/código/título (DEC-057)
CREATE EXTENSION IF NOT EXISTS unaccent; -- FTS `portuguese` sem acento (DEC-057)
CREATE EXTENSION IF NOT EXISTS citext;   -- e-mails (entities.md)
