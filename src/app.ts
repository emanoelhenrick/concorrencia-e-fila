import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import { checkoutRouter } from "./routes/checkout.routes";

export const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.use(checkoutRouter);

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Erro não tratado em uma requisição:", err);
  if (res.headersSent) return;
  res.status(500).json({ error: "ERRO_INTERNO", detail: err?.message });
});
