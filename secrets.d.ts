/**
 * Bindings that `wrangler types` cannot discover from wrangler.jsonc,
 * declared manually via interface merging with worker-configuration.d.ts.
 *
 * SECRET_PASSWORD is set with `wrangler secret put SECRET_PASSWORD`.
 */
interface Env {
	SECRET_PASSWORD: string;
}

declare namespace Cloudflare {
	interface Env {
		SECRET_PASSWORD: string;
	}
}
