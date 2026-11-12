/**
 * Keeping a secret out of a message.
 *
 * A failure that mentions a token is a failure that hands the token to whoever
 * reads the message, so every message that can carry one goes through here
 * first. The helper lives in one place so a second copy cannot forget a case.
 */

/** Takes every secret out of a text, so it can be shown or logged. */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text
  for (const secret of secrets) {
    if (!secret || secret.length === 0) continue
    out = out.split(secret).join("***")
  }
  return out
}