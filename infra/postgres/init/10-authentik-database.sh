#!/bin/sh
# RN-FND-14 · US-078 — banco lógico do Authentik no mesmo servidor PostgreSQL 17, com papel
# próprio e sem extensões. Executado uma única vez, na inicialização de um volume vazio.
# Sem `set -u`/`set -e` aqui: sem bit de execução (checkout em Linux), o entrypoint da imagem faz
# `source` deste arquivo e as opções vazariam para ele; o ON_ERROR_STOP já interrompe em erro.

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -v pw="$POSTGRES_PASSWORD" <<'SQL'
CREATE ROLE authentik LOGIN PASSWORD :'pw';
CREATE DATABASE authentik OWNER authentik;
SQL
