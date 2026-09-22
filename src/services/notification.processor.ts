import { Job } from "bullmq";
import { prisma } from "../prisma";
import { NotificationJobData } from "../queue/notification.queue";

export async function processNotificationJob(job: Job<NotificationJobData>) {
  const { orderId, channel, message } = job.data;

  const notification = await prisma.notification.create({
    data: { orderId, channel, message, status: "PENDING", attempts: job.attemptsMade + 1 },
  });

  await new Promise((resolve) => setTimeout(resolve, 1000));

  await prisma.notification.update({
    where: { id: notification.id },
    data: {
      status: "SENT",
      attempts: job.attemptsMade + 1,
      processedAt: new Date(),
    },
  });

  return { notificationId: notification.id };
}
