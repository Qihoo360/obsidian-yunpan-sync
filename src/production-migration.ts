import { PRODUCTION_OPENAPI_URL } from "./net/production-url.js";

export function requiresProductionReset(persisted: unknown): boolean {
  if (persisted == null) return false;
  if (typeof persisted !== "object") return true;
  const value = persisted as { environment?: unknown; openapiBaseUrl?: unknown };
  return value.environment !== "production" || value.openapiBaseUrl !== PRODUCTION_OPENAPI_URL;
}
