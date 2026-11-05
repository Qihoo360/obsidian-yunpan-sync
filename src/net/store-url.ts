const STORE_HOST_SUFFIXES = [".yunpan.360.cn", ".yunpan.com", ".yunpan.cn"];

export function assertStoreUrl(value: string): URL {
  let url: URL;
  try {
    const candidate = value.trim();
    url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
  } catch {
    throw new Error("Store returned an invalid URL");
  }
  if (url.protocol !== "https:") throw new Error("Store URL must use HTTPS");
  const hostname = url.hostname.toLowerCase();
  const approved = STORE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length);
  if (!approved || /^(?:qa|test|staging|dev)/i.test(hostname) || url.port || url.username || url.password) throw new Error("Store URL host is not approved");
  if (url.pathname === "/") url.pathname = "/intf.php";
  return url;
}
