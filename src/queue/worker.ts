import "dotenv/config";
import { Worker, Job } from "bullmq";
import { createRedisConnection } from "./connection";
import { NOTIFICATION_QUEUE_NAME, NotificationJobData } from "./notification.queue";
import { processNotificationJob } from "../services/notification.processor";

const worker = new Worker<NotificationJobData>(
  NOTIFICATION_QUEUE_NAME,
  async (job: Job<NotificationJobData>) => processNotificationJob(job),
  {
    connection: createRedisConnection(),
    concurrency: 5,
  }
);

worker.on("ready", () => {
  console.log("[worker] Conectado ao Redis. Aguardando jobs de notificação...");
});

worker.on("completed", (job) => {
  console.log(`[worker] Job ${job.id} (order ${job.data.orderId}) processado com sucesso.`);
});

worker.on("failed", (job, err) => {
  console.warn(
    `[worker] Job ${job?.id} (order ${job?.data.orderId}) falhou (tentativa ${job?.attemptsMade}): ${err.message}`
  );
});

process.on("unhandledRejection", (reason) => {
  console.error("[worker][unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[worker][uncaughtException]", err);
});

process.on("SIGTERM", async () => {
  console.log("[worker] Encerrando...");
  await worker.close();
  process.exit(0);
});
