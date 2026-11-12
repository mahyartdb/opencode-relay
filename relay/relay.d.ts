/**
 * The relay, as it is deployed to Vercel.
 *
 * The file is plain JavaScript on purpose: it is uploaded as it is and runs on
 * Vercel's Bun runtime, where the TLS handshake it makes is what OpenCode Free
 * accepts. This declaration only describes the shape for the rest of the code.
 */
declare const relay: {
  readonly fetch: (request: Request) => Promise<Response>
}

export default relay