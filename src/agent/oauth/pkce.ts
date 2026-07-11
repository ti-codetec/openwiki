import { createHash, randomBytes } from "node:crypto";

/**
 * URL-safe base64 without padding.
 */
export function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

/**
 * Generates a PKCE verifier and its S256 challenge.
 */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}
