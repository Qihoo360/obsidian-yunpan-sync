export const PRODUCTION_OPENAPI_URL = "https://openapi.eyun.360.cn/intf.php";

export function assertProductionOpenApiUrl(value: string): URL {
  const url = new URL(value);
  if (url.href !== PRODUCTION_OPENAPI_URL) throw new Error("OpenAPI endpoint is not approved");
  return url;
}
