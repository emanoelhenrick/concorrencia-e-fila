import http, { RefinedResponse, ResponseType } from "k6/http";
import { check } from "k6";
import { Counter, Gauge } from "k6/metrics";
// @ts-ignore
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.2/index.js";

type Strategy = "naive" | "pessimistic" | "optimistic";

interface Product {
  id: number;
  stock: number;
}

interface SetupData {
  initialStock: number;
}

interface ConsistencyReport {
  strategy: Strategy;
  initialStock: number;
  finalStock: number;
  expectedStock: number;
  confirmed: number;
  rejected: number;
  errored: number;
  isConsistent: boolean;
}

const BASE_URL: string = __ENV.BASE_URL ?? "http://localhost:3000";
const PRODUCT_ID: number = Number(__ENV.PRODUCT_ID ?? 1);
const STRATEGY: Strategy = (__ENV.STRATEGY as Strategy) ?? "pessimistic";
const CONCURRENT_REQUESTS: number = Number(__ENV.CONCURRENT_REQUESTS ?? 60);
const QUANTITY_PER_REQUEST: number = Number(__ENV.QUANTITY_PER_REQUEST ?? 1);

export const confirmedCount = new Counter("checkouts_confirmados");
export const rejectedCount = new Counter("checkouts_rejeitados");
export const erroredCount = new Counter("checkouts_com_erro");

// Gauges, e não uma variável de módulo: teardown() e handleSummary() podem
// rodar em VMs JS diferentes dentro do k6, então uma variável comum não é
// garantia de chegar até o handleSummary. Métricas, sim — elas são
// agregadas pelo próprio k6 e ficam disponíveis em data.metrics.
export const initialStockGauge = new Gauge("estoque_inicial");
export const finalStockGauge = new Gauge("estoque_final");

export const options = {
  scenarios: {
    checkout_concorrente: {
      executor: "shared-iterations",
      vus: CONCURRENT_REQUESTS,
      iterations: CONCURRENT_REQUESTS,
      maxDuration: "30s",
    },
  },
};

export function setup(): SetupData {
  const res = http.get(`${BASE_URL}/products/${PRODUCT_ID}`);
  const product = res.json() as unknown as Product;
  console.log(`Estoque inicial: ${product.stock}`);
  initialStockGauge.add(product.stock);
  return { initialStock: product.stock };
}

export default function (): void {
  const res: RefinedResponse<ResponseType> = http.post(
    `${BASE_URL}/checkout/${PRODUCT_ID}?strategy=${STRATEGY}`,
    JSON.stringify({ quantity: QUANTITY_PER_REQUEST }),
    { headers: { "Content-Type": "application/json" } }
  );

  if (res.status === 201) confirmedCount.add(1);
  else if (res.status === 409) rejectedCount.add(1);
  else if (res.status >= 500) erroredCount.add(1);

  check(res, {
    "status é 201 (confirmado) ou 409 (sem estoque)": (r) =>
      r.status === 201 || r.status === 409,
    "não houve erro 5xx": (r) => r.status < 500,
  });
}

export function teardown(data: SetupData): void {
  const res = http.get(`${BASE_URL}/products/${PRODUCT_ID}`);
  const product = res.json() as unknown as Product;
  console.log(`Estoque final: ${product.stock}`);
  finalStockGauge.add(product.stock);
}

export function handleSummary(data: any): Record<string, string> {
  const confirmed: number = data.metrics.checkouts_confirmados?.values?.count ?? 0;
  const rejected: number = data.metrics.checkouts_rejeitados?.values?.count ?? 0;
  const errored: number = data.metrics.checkouts_com_erro?.values?.count ?? 0;

  // Gauge guarda o último valor registrado (data.metrics.<nome>.values.value)
  const initialStock: number = data.metrics.estoque_inicial?.values?.value ?? 0;
  const finalStock: number = data.metrics.estoque_final?.values?.value ?? 0;
  const expectedStock = initialStock - confirmed * QUANTITY_PER_REQUEST;
  const isConsistent = finalStock === expectedStock && finalStock >= 0;

  const report = `
=== Teste de concorrência — estratégia: ${STRATEGY.toUpperCase()} ===
Estoque inicial         : ${initialStock}
Checkouts CONFIRMADOS   : ${confirmed}
Checkouts REJEITADOS    : ${rejected} (estoque insuficiente)
Checkouts com ERRO      : ${errored}
Estoque final observado : ${finalStock}
Estoque final esperado  : ${expectedStock}  (inicial - confirmados*qty)

${
  isConsistent
    ? "✅ RESULTADO: estoque CONSISTENTE. Nenhuma venda além do disponível, nenhum valor negativo."
    : "❌ RESULTADO: INCONSISTÊNCIA DETECTADA! (estoque negativo ou vendido a mais do que existia)"
}
`;

  const jsonReport: ConsistencyReport = {
    strategy: STRATEGY,
    initialStock,
    finalStock,
    expectedStock,
    confirmed,
    rejected,
    errored,
    isConsistent,
  };

  return {
    stdout: textSummary(data, { indent: " ", enableColors: true }) + "\n" + report,
    "consistency-report.json": JSON.stringify(jsonReport, null, 2),
  };
}