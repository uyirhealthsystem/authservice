import { describe, it, expect } from "vitest";
import { parseKafkaSettings } from "../src/lib/kafkaConfig";

// Pure unit tests - no database, no broker.
describe("parseKafkaSettings", () => {
  it("is a no-op config when KAFKA_BROKERS is unset", () => {
    expect(parseKafkaSettings({})).toEqual({ brokers: [], clientId: "authservice", ssl: false, sasl: undefined });
  });

  it("splits and trims the broker list", () => {
    expect(parseKafkaSettings({ KAFKA_BROKERS: " b-1:9096, b-2:9096 ,," }).brokers).toEqual(["b-1:9096", "b-2:9096"]);
  });

  it("enables TLS and SASL/SCRAM for a managed cluster (e.g. MSK)", () => {
    const s = parseKafkaSettings({
      KAFKA_BROKERS: "b-1:9096",
      KAFKA_SSL: "true",
      KAFKA_SASL_MECHANISM: "SCRAM-SHA-512",
      KAFKA_SASL_USERNAME: "authservice",
      KAFKA_SASL_PASSWORD: "secret",
    });
    expect(s.ssl).toBe(true);
    expect(s.sasl).toEqual({ mechanism: "scram-sha-512", username: "authservice", password: "secret" });
  });

  it("treats empty SASL values (as copied from .env.example) as no SASL", () => {
    const s = parseKafkaSettings({ KAFKA_SASL_MECHANISM: "", KAFKA_SASL_USERNAME: "", KAFKA_SASL_PASSWORD: "" });
    expect(s.sasl).toBeUndefined();
  });

  it("fails at boot on a mechanism without credentials", () => {
    expect(() => parseKafkaSettings({ KAFKA_SASL_MECHANISM: "plain" })).toThrow(/KAFKA_SASL_USERNAME/);
  });

  it("fails at boot on an unknown mechanism", () => {
    expect(() =>
      parseKafkaSettings({ KAFKA_SASL_MECHANISM: "oauthbearer", KAFKA_SASL_USERNAME: "u", KAFKA_SASL_PASSWORD: "p" }),
    ).toThrow(/must be one of/);
  });
});
