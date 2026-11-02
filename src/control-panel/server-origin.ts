export function validateServerUrl(value: unknown): string {
  if(typeof value!=="string") throw new Error("Server URL is required");
  const url=new URL(value);
  const secureRemote=url.protocol==="https:" && value.startsWith("https://");
  const localDevelopment=url.protocol==="http:" && url.hostname==="127.0.0.1" && value.startsWith("http://");
  if((!secureRemote&&!localDevelopment) || url.username || url.password || url.pathname!=="/" || url.search || url.hash) throw new Error("Use an HTTPS server origin or http://127.0.0.1:PORT, with no path, query or credentials");
  return url.origin;
}
