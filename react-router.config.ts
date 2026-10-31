import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  // An import map with every chunk's hash and integrity on each modulepreload, for Integrity-Policy (site-runtime ./csp).
  // It carries the request's nonce like React Router's other inline scripts.
  subResourceIntegrity: true,
} satisfies Config;
