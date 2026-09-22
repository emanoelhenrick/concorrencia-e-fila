import { Queue } from "bullmq";
import { createRedisConnection } from "./connection";

export const NOTIFICATION_QUEUE_NAME = "notifications";

export interface NotificationJobData {
  orderId: number;
  channel: "EMAIL" | "SMS" | "PUSH";
  message: string;
}

export const notificationQueue = new Queue<NotificationJobData>(
  NOTIFICATION_QUEUE_NAME,
  {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: false,
    },
  }
);
