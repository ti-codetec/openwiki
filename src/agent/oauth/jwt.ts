/**
 * Decodes a JWT payload without verifying the signature. These are our own
 * credentials, read only for display/bookkeeping. Returns undefined if not a JWT.
 */
export function decodeJwtPayload(
  token: string,
): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return undefined;
  }
  try {
    return JSON.parse(
      Buffer.from(parts[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Reads a non-empty string claim, or undefined.
 */
export function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Reads a nested object claim, or undefined. The `!== null` guard is a runtime
 * check against JavaScript's `typeof null === "object"`, unrelated to the
 * null-vs-undefined API convention.
 */
export function objectClaim(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
