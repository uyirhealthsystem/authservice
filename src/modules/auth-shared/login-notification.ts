import { emitUserLoggedIn } from "../../lib/events";
import type { PortalConfig } from "../../lib/portals";

// Tells notification-service (via auth.events) that a login just happened, so
// it can send the user a sign-in alert. Fire-and-forget: publishEvent() never
// throws, and we don't make the user wait on Kafka to finish logging in.
// An account without an email (Google with an unverified address) has nowhere
// to send the alert, so nothing is emitted.
export function notifyLogin(
  user: { id: string; email: string | null; role: string },
  portal: PortalConfig,
  method: "PASSWORD" | "GOOGLE",
  meta: { userAgent?: string; ip?: string },
): void {
  if (!user.email) return;
  void emitUserLoggedIn({
    userId: user.id,
    email: user.email,
    role: user.role,
    portalId: portal.clientId,
    portalName: portal.name,
    method,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
    loggedInAt: new Date().toISOString(),
  });
}
