/**
 * Display names exactly as the server stores them: apps/server/src/limits.ts sanitizeText with
 * MAX_NAME_LENGTH. The server removes control characters, invisible direction marks and angle
 * brackets, collapses whitespace and caps the length; a name that comes out empty is refused with
 * 400 "name is required". The game cleans names the same way before it accepts them, so that what
 * it shows, sends and compares with the leader's name is what the server keeps.
 * (apps/web/test/tighter-review-rules.test.ts checks this copy against the server's function.)
 */
export const MAX_NAME_LENGTH = 40;

export function sanitizeName(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
}
