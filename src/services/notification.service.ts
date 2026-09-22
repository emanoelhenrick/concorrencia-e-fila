import { notificationQueue, NotificationJobData } from "../queue/notification.queue";

export async function enqueueOrderConfirmationNotification(params: {
  orderId: number;
  productId: number;
  quantity: number;
}) {
  const data: NotificationJobData = {
    orderId: params.orderId,
    channel: "EMAIL",
    message: `Pedido #${params.orderId} confirmado: ${params.quantity}x produto #${params.productId}.`,
  };

  await notificationQueue.add("order-confirmation", data);
}
