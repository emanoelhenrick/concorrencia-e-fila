import { Router, Request, Response } from "express";
import { checkoutNaive } from "../services/stock.naive.service";
import { checkoutPessimistic } from "../services/stock.pessimistic.service";
import { checkoutOptimistic } from "../services/stock.optimistic.service";
import { prisma } from "../prisma";
import { asyncHandler } from "../middlewares/asyncHandler";
import { enqueueOrderConfirmationNotification } from "../services/notification.service";
import { notificationQueue } from "../queue/notification.queue";

export const checkoutRouter = Router();

type Strategy = "naive" | "pessimistic" | "optimistic";

checkoutRouter.post("/checkout/:productId", asyncHandler(async (req: Request, res: Response) => {
  const productId = Number(req.params.productId);
  const quantity = Number(req.body?.quantity ?? 1);
  const strategy = (req.query.strategy as Strategy) ?? "pessimistic";

  if (!Number.isInteger(productId) || !Number.isInteger(quantity) || quantity <= 0) {
    return res.status(400).json({ error: "PARAMETROS_INVALIDOS" });
  }

  try {
    let result;
    if (strategy === "naive") {
      result = await checkoutNaive(productId, quantity);
    } else if (strategy === "optimistic") {
      result = await checkoutOptimistic(productId, quantity);
    } else {
      result = await checkoutPessimistic(productId, quantity);
    }

    await enqueueOrderConfirmationNotification({
      orderId: result.order.id,
      productId,
      quantity,
    });

    return res.status(201).json({ strategy, ...result });
  } catch (err: any) {
    const message = err?.message ?? "ERRO_INTERNO";
    const status = message === "ESTOQUE_INSUFICIENTE" ? 409 : 500;
    return res.status(status).json({ strategy, error: message });
  }
}));

checkoutRouter.get("/products/:id", asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "ID_INVALIDO" });
  }
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) return res.status(404).json({ error: "PRODUTO_NAO_ENCONTRADO" });
  return res.json(product);
}));

checkoutRouter.get("/orders/:orderId/notifications", asyncHandler(async (req: Request, res: Response) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId)) {
    return res.status(400).json({ error: "ID_INVALIDO" });
  }
  const notifications = await prisma.notification.findMany({
    where: { orderId },
    orderBy: { id: "asc" },
  });
  return res.json(notifications);
}));

checkoutRouter.get("/queue/notifications/status", asyncHandler(async (_req: Request, res: Response) => {
  const counts = await notificationQueue.getJobCounts(
    "waiting",
    "active",
    "completed",
    "failed",
    "delayed"
  );
  return res.json(counts);
}));
