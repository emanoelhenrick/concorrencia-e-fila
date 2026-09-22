import { prisma } from "../prisma";

export async function checkoutNaive(productId: number, quantity: number) {
  const product = await prisma.product.findUniqueOrThrow({
    where: { id: productId },
  });

  if (product.stock < quantity) {
    throw new Error("ESTOQUE_INSUFICIENTE");
  }

  await new Promise((r) => setTimeout(r, 15));

  const updated = await prisma.product.update({
    where: { id: productId },
    data: { stock: product.stock - quantity },
  });

  const order = await prisma.order.create({
    data: {
      status: "CONFIRMED",
      items: { create: [{ productId, quantity }] },
    },
  });

  return { order, stockAfter: updated.stock };
}
