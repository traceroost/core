import * as crypto from 'crypto'

/** CSP nonce for a webview's `<script>` tags — cryptographically random, fresh per render. */
export function getNonce(): string {
  return crypto.randomBytes(24).toString('base64url')
}

/**
 * JSON for embedding in an inline `<script>` block. Span data (prompts, tool output, model names)
 * is attacker-influenced, so `</script>` / `<!--` must not survive into the HTML parser.
 */
export function safeJsonForScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/<\//g, '<\\/')
    .replace(/<!--/g, '<\\!--')
    .replace(/\$\{/g, '\\${')
}

/** Escapes text for an HTML element body or a quoted attribute value. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
