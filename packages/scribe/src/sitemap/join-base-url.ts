/** Join site origin and pathname without double slashes. */
export function joinBaseUrl(baseUrl: string, pathname: string): string {
  const origin = baseUrl.replace(/\/$/, "");
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${origin}${path}`;
}
