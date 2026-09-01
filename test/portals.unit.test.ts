import { describe, it, expect } from "vitest";
import {
  getPortal,
  resolveRegistrationRole,
  portalServesRole,
  PORTALS,
} from "../src/lib/portals";

// Pure unit tests - no database. This map is the whole authorization model,
// so it is worth pinning hard.
describe("portal / role resolution", () => {
  const codeOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (err) {
      return (err as { code?: string }).code ?? String(err);
    }
    throw new Error("expected the call to throw");
  };

  it("rejects an unknown clientId", () => {
    expect(codeOf(() => getPortal("nope"))).toBe("UNKNOWN_PORTAL");
  });

  it("single-role portals imply their role and ignore a requested one", () => {
    expect(resolveRegistrationRole(PORTALS["patient-app"], "DOCTOR")).toBe("PATIENT");
    expect(resolveRegistrationRole(PORTALS["admin-portal"])).toBe("ADMIN");
    expect(resolveRegistrationRole(PORTALS["superadmin-portal"])).toBe("SUPER_ADMIN");
  });

  it("the multi-role service-provider portal requires a valid role", () => {
    const sp = PORTALS["service-provider-app"];
    expect(codeOf(() => resolveRegistrationRole(sp))).toBe("ROLE_REQUIRED");
    expect(codeOf(() => resolveRegistrationRole(sp, "PATIENT"))).toBe("ROLE_NOT_ALLOWED");
    expect(resolveRegistrationRole(sp, "DOCTOR")).toBe("DOCTOR");
    expect(resolveRegistrationRole(sp, "AMBULANCE_DRIVER")).toBe("AMBULANCE_DRIVER");
  });

  it("portalServesRole enforces the portal <-> role boundary", () => {
    expect(portalServesRole(PORTALS["patient-app"], "PATIENT")).toBe(true);
    expect(portalServesRole(PORTALS["patient-app"], "DOCTOR")).toBe(false);
    expect(portalServesRole(PORTALS["service-provider-app"], "DOCTOR")).toBe(true);
    expect(portalServesRole(PORTALS["service-provider-app"], "PATIENT")).toBe(false);
  });

  it("only patient + super-admin portals auto-approve", () => {
    const auto = Object.values(PORTALS).filter((p) => p.autoApprove).map((p) => p.clientId).sort();
    expect(auto).toEqual(["patient-app", "patient-portal", "superadmin-portal"]);
  });
});
