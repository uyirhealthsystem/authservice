import { Errors } from "./errors";

// "Which app did you come through, and which role(s) does that app serve."
// A fixed in-code map, no DB table. Two shapes of portal:
//
//  - single-role portals (patient, admin, super-admin): the role is implied
//    by the clientId. Registering assigns it; nothing to pick.
//  - the multi-role service-provider portal: one app for every professional
//    role. The role is NOT implied - the user picks it at registration
//    (`role` in the register body, must be one of `roles` below) and it is
//    stored on the account permanently. Login just reads it back so the
//    mobile app can route to the right role-based UI.
//
// Login always re-checks the account's stored role is one this portal
// serves (`roles.includes(user.role)`), so a DOCTOR account can't log in
// through patient-app and a PATIENT can't log in through service-provider-app.
export const SERVICE_PROVIDER_ROLES = ["DOCTOR", "HOSPITAL", "LS", "AMBULANCE_DRIVER","PRO"] as const;
export type ServiceProviderRole = (typeof SERVICE_PROVIDER_ROLES)[number];

export interface PortalConfig {
  clientId: string;
  name: string;
  // The role(s) this portal serves. One entry = implied at registration.
  // Many entries = the user picks one at registration.
  roles: string[];
  allowedProviders: ("PASSWORD" | "GOOGLE")[];
  accessTokenTtlMin: number;
  refreshTokenTtlDays: number;
  // When false, a newly registered account is created status=PENDING and
  // cannot log in until an ADMIN / SUPER_ADMIN approves it. When true it is
  // ACTIVE immediately: patient apps (self-service, nothing to vet) and the
  // super-admin portal (bootstrap - nobody sits above it to approve it).
  autoApprove: boolean;
  // Native mobile client (React Native / Flutter / native). These have no
  // browser cookie jar, so login/refresh/logout carry the refresh token in
  // the JSON body instead of an httpOnly cookie, and Google sign-in uses the
  // native ID-token endpoint (POST /auth/google/native) rather than the
  // browser redirect flow. Web portals keep the cookie.
  nativeApp: boolean;
}

export const PORTALS: Record<string, PortalConfig> = {
  // ---- Patient: its own app (and web portal), separate from everything else.
  "patient-app": {
    clientId: "patient-app",
    name: "Patient App",
    roles: ["PATIENT"],
    allowedProviders: ["PASSWORD", "GOOGLE"],
    accessTokenTtlMin: 15,
    refreshTokenTtlDays: 90,
    autoApprove: true,
    nativeApp: true,
  },
  "patient-portal": {
    clientId: "patient-portal",
    name: "Patient Web Portal",
    roles: ["PATIENT"],
    allowedProviders: ["PASSWORD", "GOOGLE"],
    accessTokenTtlMin: 15,
    refreshTokenTtlDays: 30,
    autoApprove: true,
    nativeApp: false,
  },

  // ---- One app for every professional. Role is chosen at registration
  //      (one of SERVICE_PROVIDER_ROLES) and then fixed on the account.
  //      Every such account is PENDING until an admin approves it.
  "service-provider-app": {
    clientId: "service-provider-app",
    name: "Service Provider App",
    roles: [...SERVICE_PROVIDER_ROLES],
    // Google is allowed, but because this portal is multi-role the OAuth
    // start request must carry `role` (see auth-google.routes.ts) - a
    // redirect flow otherwise has nowhere to say which kind of provider.
    allowedProviders: ["PASSWORD", "GOOGLE"],
    accessTokenTtlMin: 15,
    refreshTokenTtlDays: 90,
    autoApprove: false,
    nativeApp: true,
  },

  // ---- Back-office, web-only, single-role. Kept separate from the service
  //      provider app on purpose: role here is never self-selected.
  "admin-portal": {
    clientId: "admin-portal",
    name: "Admin Portal",
    roles: ["ADMIN"],
    allowedProviders: ["PASSWORD"],
    accessTokenTtlMin: 15,
    refreshTokenTtlDays: 7,
    // An ADMIN registers PENDING and must be approved by a SUPER_ADMIN.
    autoApprove: false,
    nativeApp: false,
  },
  "superadmin-portal": {
    clientId: "superadmin-portal",
    name: "Super Admin Portal",
    roles: ["SUPER_ADMIN"],
    allowedProviders: ["PASSWORD"],
    accessTokenTtlMin: 15,
    refreshTokenTtlDays: 7,
    // Bootstrap account - nothing sits above it to approve it.
    autoApprove: true,
    nativeApp: false,
  },
};

export function getPortal(clientId: string): PortalConfig {
  const portal = PORTALS[clientId];
  if (!portal) throw Errors.badRequest("UNKNOWN_PORTAL", `Unknown portal clientId "${clientId}".`);
  return portal;
}

// Decide the role a new account gets when registering through `portal`.
// Single-role portal: that role, `requestedRole` is ignored. Multi-role
// portal: `requestedRole` is required and must be one the portal serves.
export function resolveRegistrationRole(portal: PortalConfig, requestedRole?: string): string {
  if (portal.roles.length === 1) return portal.roles[0];

  if (!requestedRole) {
    throw Errors.badRequest(
      "ROLE_REQUIRED",
      `Portal "${portal.clientId}" needs a role - one of: ${portal.roles.join(", ")}.`,
    );
  }
  if (!portal.roles.includes(requestedRole)) {
    throw Errors.badRequest(
      "ROLE_NOT_ALLOWED",
      `Role "${requestedRole}" is not offered by portal "${portal.clientId}".`,
    );
  }
  return requestedRole;
}

// Login-time check: is this account's stored role one this portal serves?
export function portalServesRole(portal: PortalConfig, role: string): boolean {
  return portal.roles.includes(role);
}
