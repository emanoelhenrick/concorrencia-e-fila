import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";

export async function checkoutPessimistic(productId: number, quantity: number) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {

    const rows = await tx.$queryRaw<
      { id: number; stock: number }[]
    >(Prisma.sql`SELECT id, stock FROM "Product" WHERE id = ${productId} FOR UPDATE`);

    const product = rows[0];
    if (!product) {
      throw new Error("PRODUTO_NAO_ENCONTRADO");
    }

    if (product.stock < quantity) {
      throw new Error("ESTOQUE_INSUFICIENTE");
    }

    await new Promise((r) => setTimeout(r, 15));

    const updated = await tx.product.update({
      where: { id: productId },
      data: { stock: product.stock - quantity },
    });

    const order = await tx.order.create({
      data: {
        status: "CONFIRMED",
        items: { create: [{ productId, quantity }] },
      },
    });

    return { order, stockAfter: updated.stock };
  });
}
