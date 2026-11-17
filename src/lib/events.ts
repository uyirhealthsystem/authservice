import { publishEvent, publishEventOrThrow } from "./kafka";

// Domain events authservice emits to the "auth.events" Kafka topic. Consumers
// (today just notification-service) subscribe and decide what to do with each
// eventType. Envelope shape is a contract - bump `eventVersion` on a breaking
// change rather than mutating v1.
export const AUTH_EVENTS_TOPIC = "auth.events";

interface EventEnvelope<T> {
  eventType: string;
  eventVersion: number;
  occurredAt: string;
  data: T;
}

function envelope<T>(eventType: string, eventVersion: number, data: T): EventEnvelope<T> {
  return { eventType, eventVersion, occurredAt: new Date().toISOString(), data };
}

export interface PasswordResetRequestedData {
  userId: string;
  email: string;
  otp: string; // 6-digit code, raw (only its hash is persisted)
  expiresAt: string;
}

export async function emitPasswordResetRequested(data: PasswordResetRequestedData): Promise<void> {
  await publishEvent(AUTH_EVENTS_TOPIC, data.userId, envelope("PasswordResetRequested", 1, data));
}

// Emitted after every successful login (email/password or Google) so the user
// gets a "new sign-in to your account" notification. Not emitted for token
// refresh - only when a brand-new session is started.
export interface UserLoggedInData {
  userId: string;
  email: string;
  role: string;
  portalId: string; // clientId the user logged in through
  portalName: string;
  method: "PASSWORD" | "GOOGLE";
  ip: string | null;
  userAgent: string | null;
  loggedInAt: string;
}

export async function emitUserLoggedIn(data: UserLoggedInData): Promise<void> {
  await publishEvent(AUTH_EVENTS_TOPIC, data.userId, envelope("UserLoggedIn", 1, data));
}

// Emitted when email/password login needs its second step: carries the raw
// 6-digit sign-in code for notification-service to email. Like the reset code,
// it's a live credential - auth.events has 1h retention and the consumer
// redacts `otp` before dead-lettering.
export interface LoginOtpRequestedData {
  userId: string;
  email: string;
  otp: string;
  expiresAt: string;
  portalName: string;
  ip: string | null;
  userAgent: string | null;
}

// Unlike the other emitters this one reports failure: without the email the
// user can't finish logging in, so the caller must know. Returns false when
// Kafka isn't configured; throws when it is but the send failed.
export async function emitLoginOtpRequested(data: LoginOtpRequestedData): Promise<boolean> {
  return publishEventOrThrow(AUTH_EVENTS_TOPIC, data.userId, envelope("LoginOtpRequested", 1, data));
}
