// k6 smoke do estágio 8 — Pós-deploy em staging (US-079 · RN-FND-28). Carga mínima só para provar
// que o deploy responde dentro da meta C2 (leituras p95 ≤ 500 ms) e sem erros.
// Executado pela imagem grafana/k6 em deploy-staging.yml; URLs vêm do ambiente `staging`.
/* global __ENV */
import { check, sleep } from 'k6';
import http from 'k6/http';

const WEB = __ENV.STAGING_URL;
const API = __ENV.STAGING_API_URL || __ENV.STAGING_URL;

export const options = {
  vus: 2,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
    checks: ['rate>0.99'],
  },
};

export default function smoke() {
  const home = http.get(`${WEB}/`);
  check(home, { 'web responde 200': (response) => response.status === 200 });

  const ready = http.get(`${API}/health/ready`);
  check(ready, { 'api pronta (HLT-02)': (response) => response.status === 200 });

  sleep(1);
}
