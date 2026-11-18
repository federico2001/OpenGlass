/** The inspection tools' origin (apps/checkup), which Caddy serves at checkup.<site address>. */
export function checkupUrlFor(publicUrl: string): string {
  try {
    const u = new URL(publicUrl);
    return `${u.protocol}//checkup.${u.host}`;
  } catch {
    return "https://checkup.localhost";
  }
}
