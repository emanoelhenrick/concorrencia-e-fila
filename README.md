# Simulação de Concorrência no Estoque de Produtos

Trabalho da disciplina **Computação Concorrente e Paralela**. Stack: Node.js, TypeScript, Express e Prisma (PostgreSQL).

O objetivo é reproduzir, de forma controlada, uma condição de corrida (*race condition*) clássica de e-commerce — **duas ou mais requisições de checkout disputando o mesmo item de estoque ao mesmo tempo** — e demonstrar uma solução formal para o problema.

## Integrantes

<table width="100%">
  <tr>
    <td align="center" width="33%">
      <a href="https://github.com/emanoelhenrick">
        <img src="https://github.com/emanoelhenrick.png" width="90px" style="border-radius:50%;" alt="Emanoel Henrick"/><br />
        <b>Emanoel Henrick</b>
      </a>
    </td>
    <td align="center" width="33%">
      <a href="https://github.com/jenniferzeferino">
        <img src="https://github.com/jenniferzeferino.png" width="90px" style="border-radius:50%;" alt="Jennifer Zeferino"/><br />
        <b>Jennifer Zeferino</b>
      </a>
    </td>
    <td align="center" width="33%">
      <a href="https://github.com/RaieleLeite">
        <img src="https://github.com/RaieleLeite.png" width="90px" style="border-radius:50%;" alt="Raiele Leite"/><br />
        <b>Raiele Leite</b>
      </a>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%">
      <a href="https://github.com/RayssaRR">
        <img src="https://github.com/RayssaRR.png" width="90px" style="border-radius:50%;" alt="Rayssa Santana"/><br />
        <b>Rayssa Santana</b>
      </a>
    </td>
    <td align="center" width="33%">
      <a href="https://github.com/FelipeLV12">
        <img src="https://github.com/FelipeLV12.png" width="90px" style="border-radius:50%;" alt="Felipe Lopes"/><br />
        <b>Felipe Lopes</b>
      </a>
    </td>
    <td align="center" width="33%">
      <a href="https://github.com/injuje">
        <img src="https://github.com/injuje.png" width="90px" style="border-radius:50%;" alt="José Leandro"/><br />
        <b>José Leandro</b>
      </a>
    </td>
  </tr>
</table>

---

## 1. Identificação dos pontos concorrentes

Em um fluxo de checkout, dois pontos são concorrentes por natureza, pois múltiplos clientes podem acioná-los ao mesmo tempo sobre o **mesmo recurso compartilhado** (a linha `Product` no banco):

| Ponto concorrente | Onde está no código | Por que é crítico |
|---|---|---|
| **Baixa de estoque** | `src/services/stock.*.service.ts` — leitura de `product.stock` seguida da escrita `stock - quantity` | Entre o `SELECT` e o `UPDATE` existe uma janela de tempo (*race window*) em que duas requisições podem ler o mesmo valor de estoque e ambas decidirem que há saldo suficiente, gerando venda acima do disponível ou estoque negativo. Este é o clássico problema **check-then-act / lost update**. |
| **Checkout (criação do pedido)** | `src/routes/checkout.routes.ts` → serviços de checkout | O checkout precisa que a baixa de estoque e a criação do `Order`/`OrderItem` sejam **atômicas**: não pode existir pedido confirmado sem a baixa correspondente, nem baixa de estoque sem pedido registrado. |

Esses dois pontos foram unificados em uma única transação de banco de dados (ver seção 3), pois no domínio do problema eles formam uma **única operação lógica**: *"reservar N unidades de um produto e confirmar o pedido"*.

---

## 2. Como a inconsistência é reproduzida (baseline sem controle)

O arquivo `src/services/stock.naive.service.ts` implementa o checkout **sem nenhum mecanismo de concorrência**, apenas para servir de prova/comparação no relatório:

```ts
const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
if (product.stock < quantity) throw new Error("ESTOQUE_INSUFICIENTE");
// <-- RACE WINDOW: outra requisição pode ler o mesmo product.stock aqui
await prisma.product.update({ where: { id: productId }, data: { stock: product.stock - quantity } });
```

Rodando o teste de concorrência (seção 5) contra essa versão com `stock = 50` e 60 requisições simultâneas de 1 unidade cada, o resultado esperado é **estoque final diferente do esperado (às vezes negativo)** — a prova da condição de corrida.

---

## 3. Mecanismo formal de controle de concorrência escolhido

### Técnica principal: **Pessimistic Locking via `SELECT ... FOR UPDATE` + Transação com isolamento de banco**

Implementado em `src/services/stock.pessimistic.service.ts`.

```ts
return prisma.$transaction(async (tx) => {
  const rows = await tx.$queryRaw`SELECT id, stock FROM "Product" WHERE id = ${productId} FOR UPDATE`;
  // ... valida estoque ...
  await tx.product.update({ where: { id: productId }, data: { stock: product.stock - quantity } });
  await tx.order.create({ data: { /* ... */ } });
});
```

**Como funciona:** `FOR UPDATE` faz o PostgreSQL colocar um **lock exclusivo de linha** (*row-level lock*) no registro do produto assim que ele é lido, dentro da transação. Qualquer outra transação concorrente que tente ler essa mesma linha com `FOR UPDATE` (ou escrevê-la) **fica bloqueada e em espera** até a primeira transação terminar (`COMMIT` ou `ROLLBACK`). Isso transforma o trecho crítico, que era paralelo, em **serializado** — exatamente o mesmo papel que um `Mutex` cumpre em memória compartilhada, só que no nível do banco de dados e válido entre múltiplos processos/instâncias do servidor (o que um mutex em memória de um único processo Node não garantiria).

### Justificativa técnica da escolha

| Critério | Por que Pessimistic Locking (`FOR UPDATE`) foi escolhido |
|---|---|
| **Correção sob alta contenção** | O cenário de checkout com estoque baixo (ex.: últimas unidades de um produto em promoção) é justamente um caso de **alta contenção** — muitas requisições disputando o mesmo registro. Sob alta contenção, lock pessimista tende a ter *throughput* mais previsível que otimista, que sofreria muitos retries/aborts (ver comparação abaixo). |
| **Atomicidade real** | O lock e a baixa de estoque acontecem **dentro da mesma transação** que cria o pedido. Se qualquer etapa falhar, o Prisma faz `ROLLBACK` automático — nunca existe pedido órfão sem baixa, nem baixa sem pedido. |
| **Simplicidade de raciocínio** | Diferente do lock otimista, não é necessário implementar lógica de retry/backoff nem lidar com conflitos de versão na camada de aplicação — o próprio banco resolve a exclusão mútua. Isso reduz a superfície de bugs de concorrência no código da aplicação. |
| **Escopo do domínio** | Estoque é um recurso onde a leitura desatualizada é inaceitável (não pode "vender" o que não existe). Diferente de outros domínios (ex.: edição colaborativa de perfil), aqui a espera de uma requisição pela outra é aceitável e até desejável. |
| **Equivalente a um Mutex distribuído** | Como o servidor pode ter múltiplas instâncias (múltiplos processos Node), um `Mutex` em memória (ex.: `async-mutex`) **não protegeria** contra concorrência entre processos/instâncias diferentes. O lock a nível de linha no banco funciona corretamente mesmo com múltiplas réplicas da aplicação, pois o ponto de exclusão mútua é o próprio SGBD, compartilhado por todas as instâncias. |

### Técnica alternativa implementada para comparação: **Optimistic Locking (controle de versão)**

Implementado em `src/services/stock.optimistic.service.ts`, usando um campo `version` incrementado a cada escrita e a condição `WHERE id = ? AND version = ?` no `UPDATE`. Se `0` linhas forem afetadas, é sinal de conflito (outra requisição já alterou o registro) e a operação é reexecutada (retry com pequeno backoff).

**Trade-off observado nos testes:** sob baixa contenção (poucos clientes disputando produtos diferentes), o otimista tende a ter melhor desempenho, pois não bloqueia ninguém enquanto "pensa". Sob alta contenção no **mesmo produto** (o cenário testado aqui), ele gera muitos retries, aumentando a latência e, em casos extremos, esgotando `maxRetries`. Por isso o pessimista foi escolhido como solução principal para este problema específico.

---

## 4. Modelagem (Prisma)

```prisma
model Product {
  id        Int      @id @default(autoincrement())
  name      String
  stock     Int      @default(0)
  version   Int      @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  orderItems OrderItem[]
}

model Order {
  id        Int      @id @default(autoincrement())
  status    String   @default("CONFIRMED")
  createdAt DateTime @default(now())

  items         OrderItem[]
  notifications Notification[]
}

model OrderItem {
  id        Int @id @default(autoincrement())
  orderId   Int
  productId Int
  quantity  Int

  order   Order   @relation(fields: [orderId], references: [id])
  product Product @relation(fields: [productId], references: [id])
}

model Notification {
  id          Int      @id @default(autoincrement())
  orderId     Int
  channel     String
  status      String   @default("PENDING")
  message     String
  attempts    Int      @default(0)
  createdAt   DateTime @default(now())
  processedAt DateTime? 

  order Order @relation(fields: [orderId], references: [id])
}
```

---

## 5. Como rodar o experimento

### Pré-requisitos
- Node.js 18+
- Docker (para subir um PostgreSQL local) **ou** uma instância PostgreSQL já disponível

### Passo a passo

```bash
# 1. Instalar dependências
npm install

# 2. Subir o banco Postgres local
docker compose up -d

# 3. Configurar variáveis de ambiente
cp .env.example .env

# 4. Criar as tabelas
npm run prisma:migrate

# 5. Popular o banco com o produto de teste (estoque = 50)
npm run prisma:seed

# 6. Subir a API
npm run dev
```

Em outro terminal, com a API rodando, execute o teste de concorrência para cada estratégia (rode `npm run prisma:seed` entre um teste e outro para reiniciar o estoque em 50):

```bash
npm run test:concurrency:naive         # baseline SEM controle -> espera-se inconsistência
npm run prisma:seed
npm run test:concurrency:pessimistic   # técnica principal -> espera-se consistência
npm run prisma:seed
npm run test:concurrency:optimistic    # técnica alternativa -> espera-se consistência (com mais retries)
```

Variáveis opcionais do teste (podem ser sobrescritas via env):

```bash
CONCURRENT_REQUESTS=100 QUANTITY_PER_REQUEST=1 npm run test:concurrency:pessimistic
```

### O que o script de teste faz e como ler o resultado

`scripts/concurrency-test.ts`:
1. Lê o estoque inicial do produto.
2. Dispara `CONCURRENT_REQUESTS` chamadas `POST /checkout/1` **em paralelo** (`Promise.all`), cada uma pedindo `QUANTITY_PER_REQUEST` unidades.
3. Ao final, calcula o estoque **esperado** (`inicial - confirmados * quantidade`) e compara com o estoque **real** lido do banco.
4. Imprime `✅ CONSISTENTE` ou `❌ INCONSISTÊNCIA DETECTADA`, além da contagem de checkouts confirmados/rejeitados/com erro.

**Resultado esperado (baseline `naive`):** possível estoque negativo e/ou `estoque final ≠ estoque esperado` — evidenciando a race condition.

**Resultado esperado (`pessimistic` e `optimistic`):** estoque final sempre igual ao esperado e nunca negativo — nenhuma venda além da quantidade disponível, independentemente da quantidade de requisições simultâneas.

### Script alternativo: teste de carga/concorrência com K6

Além do script Node (`scripts/concurrency-test.ts`), o mesmo experimento foi reproduzido em `scripts/concurrency-test.k6.ts`, usando [K6](https://k6.io/) — ferramenta dedicada a testes de carga/concorrência, citada explicitamente no requisito do trabalho. Ele cobre o mesmo cenário (requisições simultâneas de checkout + verificação de consistência de estoque), mas com concorrência real via múltiplos VUs (*virtual users*) do K6 em vez de `Promise.all` no event loop do Node.

**Instalação do K6** (uma vez só):

```bash
# macOS
brew install k6

# Linux (Debian/Ubuntu)
curl -fsSL https://dl.k6.io/key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/k6-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

Requer **K6 v0.57+**, que roda arquivos `.ts` nativamente (`k6 run script.ts`), sem build step.

**Como rodar** (com a API já no ar e o banco recém-populado via `npm run prisma:seed`):

```bash
npm run test:concurrency:k6:naive         # baseline SEM controle
npm run prisma:seed
npm run test:concurrency:k6:pessimistic   # técnica principal
npm run prisma:seed
npm run test:concurrency:k6:optimistic    # técnica alternativa
```

Variáveis opcionais (mesmo espírito do script Node): `BASE_URL`, `PRODUCT_ID`, `CONCURRENT_REQUESTS`, `QUANTITY_PER_REQUEST`.

**O que o script faz:** cada VU dispara 1 requisição de checkout (`CONCURRENT_REQUESTS` VUs simultâneos, uma iteração cada), contabiliza confirmados/rejeitados/com erro via métricas `Counter`, lê o estoque antes (`setup()`) e depois (`teardown()`) via métricas `Gauge`, e ao final o `handleSummary()` calcula `estoque esperado = inicial - confirmados * quantidade` e imprime `✅ CONSISTENTE` ou `❌ INCONSISTÊNCIA DETECTADA` — mesmo critério do script Node — além de gerar `consistency-report.json` com os números da rodada.

**Resultado esperado:** o mesmo padrão da seção anterior — inconsistência no `naive`, consistência no `pessimistic` e no `optimistic`.

---

## 6. Fila assíncrona de notificações (BullMQ + Redis)

Além do controle de concorrência no estoque, o projeto implementa uma **fila de mensagens desacoplada da requisição HTTP** para processar notificações de confirmação de pedido (ex.: e-mail/SMS ao cliente).

### Por que uma fila e por que BullMQ + Redis

| Critério | Justificativa |
|---|---|
| **Desacoplamento** | Enviar uma notificação normalmente envolve chamar um provedor externo (e-mail, SMS, push) — uma operação **lenta e sujeita a falhas**. Se isso fosse feito dentro do handler do checkout, o cliente ficaria esperando o tempo desse provedor externo para receber a resposta HTTP, e uma falha no envio poderia (erroneamente) parecer uma falha no pedido em si. Colocando esse trabalho em uma fila, o checkout responde assim que o **pedido está confirmado e o estoque baixado**, e o envio da notificação acontece depois, em background. |
| **Mesma stack** | BullMQ é uma biblioteca Node/TypeScript nativa (não exige outro *runtime*), com tipagem forte para o payload dos jobs, se integrando naturalmente ao Express/Prisma já usados no restante do projeto. |
| **Confiabilidade** | BullMQ persiste os jobs no Redis: se o worker cair no meio do processamento, o job não se perde e é reprocessado. Também oferece **retry com backoff exponencial** de forma declarativa (`attempts`, `backoff`). |
| **Escalabilidade horizontal** | O worker roda como um **processo separado** do servidor HTTP (`src/queue/worker.ts` vs `src/server.ts`). É possível escalar os dois independentemente: subir mais réplicas do worker sem tocar na API, ou vice-versa — importante em um cenário de pico de vendas, onde o volume de checkouts pode não crescer na mesma proporção do volume de notificações (ou vice-versa). |
| **Alternativas consideradas** | *Redis Pub/Sub* foi descartado por não persistir mensagens (um assinante offline perde a mensagem — inaceitável para notificação de pedido). *RabbitMQ/SQS* resolveriam o mesmo problema, mas exigiriam infraestrutura adicional fora do ecossistema Node/Redis já usado no projeto; BullMQ sobre Redis foi suficiente para os requisitos e mantém a stack enxuta. |

### Fluxo

```
Cliente -> POST /checkout/:productId
              │
              ▼
     [Transação de estoque]  (pessimistic/optimistic/naive — ver seções 1-3)
              │
              ▼
     notificationQueue.add(...)   <-- apenas PUBLICA o job (operação em Redis, ~ms)
              │
              ▼
     res.status(201).json(...)    <-- resposta HTTP já retorna aqui, SEM esperar o envio
              .
              .  (assíncrono, em outro processo)
              .
              ▼
     [Worker - src/queue/worker.ts]
              │
              ▼
     processNotificationJob()  -> grava Notification (PENDING)
              │
              ▼
     simula chamada a provedor externo (delay de 1s)
              │
              ├── sucesso -> Notification.status = SENT
                        │
                        ▼
              BullMQ reagenda automaticamente (retry com backoff exponencial,
              até 3 tentativas, configurado em notification.queue.ts)
```

### Como rodar

Precisa do Redis rodando (já incluso no `docker-compose.yml`):

```bash
docker compose up -d          # sobe Postgres + Redis
npm run dev                   # terminal 1: API HTTP
npm run worker:dev            # terminal 2: worker da fila (processo separado!)
```

Depois, faça um checkout normalmente:

```bash
curl -X POST "http://localhost:3000/checkout/1?strategy=pessimistic" \
  -H "Content-Type: application/json" \
  -d '{"quantity": 1}'
```

A resposta volta imediatamente com o pedido confirmado. Repare no terminal do **worker** que o job só é processado ~1s depois (chamada ao provedor simulado), de forma totalmente independente da requisição HTTP que já havia terminado.

Para acompanhar o processamento assíncrono via API:

```bash
# status da(s) notificação(ões) daquele pedido (id retornado no checkout)
curl http://localhost:3000/orders/1/notifications

# contadores gerais da fila (waiting/active/completed/failed/delayed)
curl http://localhost:3000/queue/notifications/status
```

Rodando o `curl` de notificações logo após o checkout, é comum ver `status: "PENDING"` (ou nenhum registro ainda, se o worker não pegou o job); repetindo a chamada ~2s depois, o status já estará `SENT` ou `FAILED` (com nova tentativa agendada) — evidência de que o processamento ocorreu **fora** do ciclo da requisição original.

### Arquivos relevantes

```
src/queue/
├── connection.ts          # conexão Redis compartilhada (producer + worker)
├── notification.queue.ts  # definição da fila (nome, tipo do job, retry/backoff)
└── worker.ts               # PROCESSO SEPARADO que consome a fila (rodar com npm run worker:dev)
src/services/
├── notification.service.ts    # producer: enfileira o job a partir da rota HTTP
└── notification.processor.ts  # lógica executada pelo worker para cada job
```

## 7. Uso de IA (Claude) no desenvolvimento

O assistente de IA **Claude (Anthropic)** foi utilizado como apoio ao longo do desenvolvimento deste trabalho, com foco principal em **explicar e detalhar o funcionamento dos mecanismos implementados**:

- **Apoio na estrutura inicial do projeto**: implementação do boilerplate Node + TypeScript + Express + Prisma, além da modelagem das tabelas (`Product`, `Order`, `OrderItem`, `Notification`) e a configuração de build/scripts, sempre revisada e ajustada durante o desenvolvimento.
- **Explicação das técnicas de concorrência**: o principal uso do Claude foi **explicar em detalhes, linha a linha, como cada mecanismo funciona por dentro** nas três versões do checkout (`naive`, `pessimistic`, `optimistic`) — por exemplo, por que `SELECT ... FOR UPDATE` bloqueia outras transações no lock pessimista, e por que o `UPDATE ... WHERE id = ? AND version = ?` do lock otimista funciona como uma escrita condicional atômica capaz de detectar conflitos sem precisar travar a linha antes. Essas explicações foram essenciais para entender **o motivo** de cada abordagem funcionar.
- **Explicação da fila assíncrona**: da mesma forma, ajudou a entender o funcionamento da fila de notificações com BullMQ + Redis: por que o *producer* (rota HTTP) só publica o job e não espera o processamento, por que o *worker* precisa rodar como processo separado, e como o retry com backoff exponencial trata falhas.
- **Depuração de erros de execução**: durante os testes locais, ajudou a diagnosticar e explicar a causa de problemas práticos (ex.: `DATABASE_URL` não carregada no script de seed, crash do servidor por *unhandled promise rejection*, ordem incorreta de `deleteMany()` violando chave estrangeira após a criação da tabela `Notification`, necessidade de rodar `prisma migrate dev` após alterar o schema), o que ajudou a entender a causa raiz de cada erro e não só a corrigi-lo.
- **Documentação**: este próprio `README.md` foi redigido com apoio do Claude.

O papel do Claude foi principalmente o de **explicar o funcionamento interno dos mecanismos de concorrência e da fila assíncrona**, servindo de apoio ao aprendizado dos conceitos da disciplina; todo o código foi revisado, testado e compreendido antes de ser incorporado ao projeto, e as explicações recebidas foram a base para a justificativa técnica documentada na Seção 3.