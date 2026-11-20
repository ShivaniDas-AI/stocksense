/**
 * StockSense REST API, version 1. Mounted at /api/v1 (the base URL in the
 * user guide) and at /v1. Spec: GET /api/v1/openapi.json; docs: /docs.
 */
import { Router } from "express";
import { openApiSpec } from "../../openapi";
import { authenticate, errorHandler, fail, rateLimit, Req, requestId } from "./core";
import { registerCatalog } from "./catalog";
import { registerOps } from "./ops";
import { registerAssistants } from "./assistants";

export const v1Router = Router();

v1Router.get("/openapi.json", (_req, res) => res.json(openApiSpec()));
v1Router.use(requestId);
v1Router.use(authenticate);
v1Router.use(rateLimit);

registerCatalog(v1Router);
registerOps(v1Router);
registerAssistants(v1Router);

v1Router.use((req: Req, res) => fail(res, 404, "not_found", "route_not_found", `No route ${req.method} ${req.originalUrl}. See /docs.`));
v1Router.use(errorHandler);
