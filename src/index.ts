// Must stay the first import: it populates process.env before any module below
// it (notably ./lib/auth, via ./routes/routes) reads it. See src/env.ts.
import "./env";

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { router } from "./routes/routes";
import { isAllowedOrigin } from "./lib/origins";
import { createServer } from "http";
import { prisma } from "./utils/db";
import { errorHandler } from "./middlewares/errorHandler";
import { handleDodoWebhook } from "./controllers/dodoWebhookController";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./utils/swagger";

const app = express();

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// The allow-list lives in ./lib/origins so that Better Auth's own origin check
// cannot disagree with this one. `origin` is a predicate rather than an array
// because in development it has to accept whichever port Vite settled on.
app.use(
  cors({
    origin: (origin, callback) => {
      // No Origin header at all: same-origin navigation, curl, a health probe.
      // These are not cross-origin requests, so there is nothing to deny.
      if (!origin) return callback(null, true);

      if (isAllowedOrigin(origin)) return callback(null, true);

      // Answer without the Allow-Origin header instead of throwing. Throwing
      // hands the request to the error handler, which returns a 500 that the
      // browser still reports as a CORS error — a misleading log line on the
      // server and no better a message in the console.
      console.warn(`⚠️  Blocked cross-origin request from ${origin}`);
      return callback(null, false);
    },
    credentials: true,
  })
);

app.use(cookieParser());

// Mounted ahead of express.json() on purpose. Dodo signs the exact bytes it sends,
// so this handler needs the untouched body; once express.json() has parsed a
// request, the original bytes are gone. body-parser marks the request as already
// read, so the JSON parser below leaves this route alone.
app.post(
  "/api/webhooks/dodo",
  express.raw({ type: "application/json" }),
  handleDodoWebhook
);

app.use(express.json());

app.use("/api", router);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.use(errorHandler as unknown as express.ErrorRequestHandler);

const server = createServer(app);

const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    await prisma.$connect();
    console.log("✅ Successfully connected to the database");

    server.listen(PORT, () => {
      console.log(`✅ HTTP server running on http://localhost:${PORT}`);
    });

    const shutdown = async () => {
      console.log("🛑 Shutting down server...");
      await prisma.$disconnect();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error("Failed to connect to the database:", error);
    process.exit(1);
  }
}
startServer();
