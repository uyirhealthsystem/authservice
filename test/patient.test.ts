import { describe, it, expect, beforeEach } from "vitest";
import { api, resetDb, activeUserAccessToken } from "./helpers";

const PROFILE = "/api/v1/auth/patients/me/profile";
const FAMILY = "/api/v1/auth/patients/me/family-members";

const patientToken = async () => (await activeUserAccessToken({ clientId: "patient-app" })).accessToken;
const bearer = (t: string) => `Bearer ${t}`;

describe("patient profile + family members", () => {
  beforeEach(resetDb);

  it("profile: 404 before create, 201 on create, 200 on replace", async () => {
    const t = await patientToken();

    expect((await api.get(PROFILE).set("Authorization", bearer(t))).status).toBe(404);

    const created = await api
      .put(PROFILE)
      .set("Authorization", bearer(t))
      .send({ fullName: "Ravi Kumar", dateOfBirth: "1990-05-14", gender: "MALE", bloodGroup: "O+", phone: "9876543210", district: "Chennai", pinCode: "600001" });
    expect(created.status).toBe(201);
    expect(created.body.profile).toMatchObject({ fullName: "Ravi Kumar", gender: "MALE", bloodGroup: "O+", district: "Chennai", pinCode: "600001" });

    const replaced = await api.put(PROFILE).set("Authorization", bearer(t)).send({ fullName: "Ravi K" });
    expect(replaced.status).toBe(200);
    expect(replaced.body.profile).toMatchObject({ fullName: "Ravi K", gender: null, phone: null, district: null, pinCode: null });

    const got = await api.get(PROFILE).set("Authorization", bearer(t));
    expect(got.status).toBe(200);
    expect(got.body.profile.id).toBe(created.body.profile.id);
  });

  it("profile validates input", async () => {
    const t = await patientToken();
    const res = await api.put(PROFILE).set("Authorization", bearer(t)).send({ fullName: "", bloodGroup: "Z+" });
    expect(res.status).toBe(400);

    const badPin = await api.put(PROFILE).set("Authorization", bearer(t)).send({ fullName: "A", pinCode: "60001" });
    expect(badPin.status).toBe(400);
  });

  it("family members: create, list, update, delete", async () => {
    const t = await patientToken();

    const created = await api
      .post(FAMILY)
      .set("Authorization", bearer(t))
      .send({ fullName: "Lakshmi", relationship: "MOTHER", dateOfBirth: "1962-01-02", district: "Madurai", pinCode: "625001" });
    expect(created.status).toBe(201);
    expect(created.body.familyMember).toMatchObject({ district: "Madurai", pinCode: "625001" });
    const id = created.body.familyMember.id;

    const list = await api.get(FAMILY).set("Authorization", bearer(t));
    expect(list.body.familyMembers).toHaveLength(1);

    const patched = await api.patch(`${FAMILY}/${id}`).set("Authorization", bearer(t)).send({ bloodGroup: "B+", pinCode: "625002" });
    expect(patched.status).toBe(200);
    expect(patched.body.familyMember).toMatchObject({ fullName: "Lakshmi", relationship: "MOTHER", bloodGroup: "B+", district: "Madurai", pinCode: "625002" });

    expect((await api.delete(`${FAMILY}/${id}`).set("Authorization", bearer(t))).status).toBe(204);
    expect((await api.get(FAMILY).set("Authorization", bearer(t))).body.familyMembers).toHaveLength(0);
  });

  it("a patient cannot touch another patient's family member", async () => {
    const owner = await patientToken();
    const other = await patientToken();
    const created = await api
      .post(FAMILY)
      .set("Authorization", bearer(owner))
      .send({ fullName: "Arun", relationship: "SON" });
    const id = created.body.familyMember.id;

    expect((await api.patch(`${FAMILY}/${id}`).set("Authorization", bearer(other)).send({ fullName: "x" })).status).toBe(404);
    expect((await api.delete(`${FAMILY}/${id}`).set("Authorization", bearer(other))).status).toBe(404);
    expect((await api.get(FAMILY).set("Authorization", bearer(other))).body.familyMembers).toHaveLength(0);
  });

  it("PATIENT role only: 401 without a token, 403 for other roles", async () => {
    expect((await api.get(PROFILE)).status).toBe(401);

    const doctor = (await activeUserAccessToken({ clientId: "service-provider-app", role: "DOCTOR" })).accessToken;
    const admin = (await activeUserAccessToken({ clientId: "superadmin-portal" })).accessToken;
    for (const t of [doctor, admin]) {
      expect((await api.get(PROFILE).set("Authorization", bearer(t))).status).toBe(403);
      expect((await api.post(FAMILY).set("Authorization", bearer(t)).send({ fullName: "a", relationship: "SON" })).status).toBe(403);
    }
  });
});
