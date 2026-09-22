import { prisma } from "../prisma";

export async function checkoutOptimistic(
  productId: number,
  quantity: number,
  maxRetries = 8
) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: productId },
    });

    if (product.stock < quantity) {
      throw new Error("ESTOQUE_INSUFICIENTE");
    }

    await new Promise((r) => setTimeout(r, 15));

    try {
      const result = await prisma.product.updateMany({
        where: { id: productId, version: product.version },
        data: {
          stock: product.stock - quantity,
          version: { increment: 1 },
        },
      });

      if (result.count === 0) {
        await new Promise((r) => setTimeout(r, 10 * attempt));
        continue;
      }

      const order = await prisma.order.create({
        data: {
          status: "CONFIRMED",
          items: { create: [{ productId, quantity }] },
        },
      });

      const fresh = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
      return { order, stockAfter: fresh.stock, attempts: attempt };
    } catch (err) {
      throw err;
    }
  }

  throw new Error("CONFLITO_DE_CONCORRENCIA_MAX_RETRIES");
}
