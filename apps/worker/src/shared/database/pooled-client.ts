import type pg from 'pg';

/*
 * Cliente retirado do pool `pg` com listener de `'error'` (US-082). Enquanto o cliente está em uso,
 * o `pg.Pool` tira dele o próprio listener de ociosidade: se o backend cair no meio da transação
 * (`pg_terminate_backend`, failover, rede), o `pg.Client` rejeita a query em voo E emite `'error'`
 * — sem ouvinte, o Node converte em `uncaughtException` e derruba o processo do worker. Quem
 * retira o cliente escuta até devolvê-lo; a falha chega ao chamador pela rejeição da query, e o
 * cliente que emitiu erro sai do pool (é destruído em vez de voltar ocioso).
 */

export interface CheckedOutClient {
  readonly connection: pg.PoolClient;
  /** `true` se o cliente emitiu `'error'` enquanto estava em uso. */
  readonly failed: boolean;
  /** Devolve ao pool; descarta o cliente se `broken` ou se ele emitiu `'error'`. */
  release(broken: boolean): void;
}

export async function checkoutClient(pool: pg.Pool): Promise<CheckedOutClient> {
  const connection = await pool.connect();
  let failed = false;
  const onError = (): void => {
    failed = true;
  };
  connection.on('error', onError);
  return {
    connection,
    get failed() {
      return failed;
    },
    release(broken: boolean): void {
      connection.off('error', onError);
      connection.release(broken || failed);
    },
  };
}
