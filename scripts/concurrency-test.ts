/**
 * TESTE DE ACESSOS SIMULTÂNEOS AO CHECKOUT
 * ------------------------------------------
 * Uso:
 *   npm run test:concurrency:naive
 *   npm run test:concurrency:pessimistic
 *   npm run test:concurrency:optimistic
 *
 * Pré-requisitos: servidor rodando (`npm run dev`) e banco "resetado"
 * com `npm run prisma:seed` (estoque inicial = 50).
 *
 * O que o script faz:
 *   1. Lê o estoque inicial do produto (deve ser 50, via seed).
 *   2. Dispara CONCURRENT_REQUESTS requisições de checkout em PARALELO
 *      (Promise.all), cada uma pedindo QUANTITY_PER_REQUEST unidades.
 *   3. Ao final, verifica se:
 *        estoque_final == estoque_inicial - (pedidos_confirmados * qty)
 *      e se estoque_final nunca ficou negativo.
 *   4. Reporta quantos checkouts foram CONFIRMADOS vs REJEITADOS
 *      (estoque insuficiente) vs ERRO.
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const PRODUCT_ID = Number(process.env.PRODUCT_ID ?? 1);
const CONCURRENT_REQUESTS = Number(process.env.CONCURRENT_REQUESTS ?? 60);
const QUANTITY_PER_REQUEST = Number(process.env.QUANTITY_PER_REQUEST ?? 1);

type Strategy = "naive" | "pessimistic" | "optimistic";

async function getProduct(id: number): Promise<{ id: number; stock: number }> {
  const res = await fetch(`${BASE_URL}/products/${id}`);
  return (await res.json()) as { id: number; stock: number };
}

async function checkout(strategy: Strategy) {
  const res = await fetch(`${BASE_URL}/checkout/${PRODUCT_ID}?strategy=${strategy}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quantity: QUANTITY_PER_REQUEST }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function main() {
  const strategy = (process.argv[2] as Strategy) ?? "pessimistic";
  console.log(`\n=== Teste de concorrência — estratégia: ${strategy.toUpperCase()} ===`);

  const before = await getProduct(PRODUCT_ID);
  console.log(`Estoque inicial: ${before.stock}`);
  console.log(`Disparando ${CONCURRENT_REQUESTS} requisições simultâneas de checkout (qty=${QUANTITY_PER_REQUEST} cada)...`);

  const start = Date.now();
  const results = await Promise.all(
    Array.from({ length: CONCURRENT_REQUESTS }, () => checkout(strategy))
  );
  const elapsedMs = Date.now() - start;

  const confirmed = results.filter((r) => r.status === 201).length;
  const rejected = results.filter((r) => r.status === 409).length;
  const errored = results.filter((r) => r.status >= 500).length;

  const after = await getProduct(PRODUCT_ID);

  const expectedStock = before.stock - confirmed * QUANTITY_PER_REQUEST;
  const isConsistent = after.stock === expectedStock && after.stock >= 0;

  console.log(`\nTempo total: ${elapsedMs}ms`);
  console.log(`Checkouts CONFIRMADOS : ${confirmed}`);
  console.log(`Checkouts REJEITADOS  : ${rejected} (estoque insuficiente)`);
  console.log(`Checkouts com ERRO    : ${errored}`);
  console.log(`Estoque final observado : ${after.stock}`);
  console.log(`Estoque final esperado  : ${expectedStock}  (inicial - confirmados*qty)`);
  console.log(
    isConsistent
      ? "\n✅ RESULTADO: estoque CONSISTENTE. Nenhuma venda além do disponível, nenhum valor negativo."
      : "\n❌ RESULTADO: INCONSISTÊNCIA DETECTADA! (estoque negativo ou vendido a mais do que existia)"
  );

  process.exit(isConsistent ? 0 : 1);
}

main().catch((err) => {
  if (err?.cause?.code === "ECONNREFUSED" || err?.message === "fetch failed") {
    console.error(
      `\n❌ Não foi possível conectar em ${BASE_URL}.\n` +
        `Verifique se o servidor está rodando (npm run dev) e sem erros no terminal dele,\n` +
        `e se o produto com id=${PRODUCT_ID} existe (npm run prisma:seed).`
    );
  } else {
    console.error("Falha ao executar o teste de concorrência:", err);
  }
  process.exit(1);
});
