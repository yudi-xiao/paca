import {
  MAX_AUTHORIZATION_TTL_SECONDS,
  MAX_CONNECTION_TTL_SECONDS,
  type TicketClaims,
  ticketClaimsSchema,
} from "./protocol";

const TOKEN_PREFIX = "v1";
const MAX_TOKEN_BYTES = 4096;

export class TicketError extends Error {
  constructor(readonly code: "TICKET_CONFIG_INVALID" | "TICKET_INVALID" | "TICKET_EXPIRED") {
    super(code);
    this.name = "TicketError";
  }
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TicketError("TICKET_INVALID");
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new TicketError("TICKET_INVALID");
  }
}

async function signingKey(secret: string): Promise<CryptoKey> {
  const bytes = new TextEncoder().encode(secret);
  if (bytes.byteLength < 32 || bytes.byteLength > 1024) {
    throw new TicketError("TICKET_CONFIG_INVALID");
  }
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function signTicket(claims: TicketClaims, secret: string): Promise<string> {
  const parsed = ticketClaimsSchema.parse(claims);
  const payload = bytesToBase64url(new TextEncoder().encode(JSON.stringify(parsed)));
  const message = `${TOKEN_PREFIX}.${payload}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    new TextEncoder().encode(message),
  );
  const token = `${message}.${bytesToBase64url(new Uint8Array(signature))}`;
  if (new TextEncoder().encode(token).byteLength > MAX_TOKEN_BYTES) {
    throw new TicketError("TICKET_CONFIG_INVALID");
  }
  return token;
}

export async function verifyTicket(
  token: string,
  secret: string,
  now: Date = new Date(),
): Promise<TicketClaims> {
  if (new TextEncoder().encode(token).byteLength > MAX_TOKEN_BYTES) {
    throw new TicketError("TICKET_INVALID");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1] || !parts[2]) {
    throw new TicketError("TICKET_INVALID");
  }
  const message = `${TOKEN_PREFIX}.${parts[1]}`;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await signingKey(secret),
    base64urlToBytes(parts[2]),
    new TextEncoder().encode(message),
  );
  if (!valid) throw new TicketError("TICKET_INVALID");

  let claims: TicketClaims;
  try {
    claims = ticketClaimsSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64urlToBytes(parts[1]))),
    );
  } catch (error) {
    if (error instanceof TicketError) throw error;
    throw new TicketError("TICKET_INVALID");
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (
    claims.expiresAt <= nowSeconds ||
    claims.issuedAt > nowSeconds ||
    Math.floor(claims.issuedAtMs / 1000) !== claims.issuedAt ||
    claims.expiresAt <= claims.issuedAt ||
    claims.expiresAt - claims.issuedAt > MAX_CONNECTION_TTL_SECONDS ||
    claims.authorizationExpiresAt < claims.expiresAt ||
    claims.authorizationExpiresAt - claims.issuedAt > MAX_AUTHORIZATION_TTL_SECONDS
  ) {
    throw new TicketError("TICKET_EXPIRED");
  }
  return claims;
}

export function ticketProtocolFromRequest(request: Request): string | null {
  const protocolTokens = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.startsWith("paca-ticket."));
  return protocolTokens.length === 1 ? (protocolTokens[0] ?? null) : null;
}

export function accessTokenFromRequest(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer ([A-Za-z0-9._-]+)$/u)?.[1] ?? null;
  const selectedProtocol = ticketProtocolFromRequest(request);
  const protocol = selectedProtocol?.slice("paca-ticket.".length) ?? null;
  if (bearer && protocol && bearer !== protocol) return null;
  return bearer ?? protocol;
}
