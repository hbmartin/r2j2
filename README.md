# Journal API Worker

A Cloudflare Worker that provides a password-protected API for logging timestamped journal entries to R2 storage.

Each entry is stored as its own R2 object (under the `entries/` prefix), so concurrent writes are atomic and can never overwrite each other. A pre-existing single-file journal (`journal.txt`) from older versions of this worker is still read and merged into results. See [SPEC.md](SPEC.md) for the full API specification.

## Setup Instructions

### 1. Create R2 Bucket

```bash
npx wrangler r2 bucket create <your-bucket-name>
```

Then set `bucket_name` in `wrangler.jsonc` to match (this repo deploys to a bucket named `harold-martin`):

```jsonc
"r2_buckets": [
	{
		"binding": "JOURNAL_BUCKET",
		"bucket_name": "harold-martin"
	}
]
```

### 2. Configure the Secret

Set the password used for API authentication:

```bash
npx wrangler secret put SECRET_PASSWORD
```

When prompted, enter your desired password. It is stored securely in Cloudflare and compared in constant time on every request.

### 3. Optional Configuration

`wrangler.jsonc` exposes two vars you can override per deployment:

| Var | Default | Purpose |
|-----|---------|---------|
| `ENTRIES_PREFIX` | `entries/` | R2 key prefix for per-entry objects |
| `LEGACY_JOURNAL_KEY` | `journal.txt` | Single-file journal from older versions, merged into reads |

It also configures a `RATE_LIMITER` binding (100 requests per minute per IP) to slow down password brute-forcing.

### 4. Deploy

```bash
pnpm run deploy
```

Pushes to `main` also deploy automatically via GitHub Actions (`.github/workflows/deploy.yml`), using the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.

## Usage

All endpoints are `GET` and take the password as a `password` query parameter.

> Note: the password travels in the URL by design (this API is meant to be callable from anywhere a URL can go). Be aware that URLs can end up in logs and browser history; the per-IP rate limit and constant-time comparison mitigate brute-forcing, but treat any URL containing the password as sensitive.

### Add Journal Entry

- **Path**: `/`
- **Parameters**: `password` (required), `text` (required)

```bash
curl "https://your-worker.your-subdomain.workers.dev/?password=your-secret&text=Hello%20World%21"
```

Returns `200` with a JSON body:

```json
{"timestamp": 1640995200}
```

### Retrieve Journal Contents

- **Path**: `/csv`
- **Parameters**: `password` (required), `since` (optional Unix timestamp, exclusive), `limit` (optional positive integer)

```bash
curl "https://your-worker.your-subdomain.workers.dev/csv?password=your-secret&since=1640995200&limit=100"
```

Returns `200` with `text/csv` content, oldest first. Text containing commas, quotes, or newlines is escaped per RFC 4180:

```
1640995200,Hello World!
1640995260,"an entry, with a comma"
```

### Count Journal Entries

- **Path**: `/count`
- **Parameters**: `password` (required), `since` (optional Unix timestamp, exclusive)

```bash
curl "https://your-worker.your-subdomain.workers.dev/count?password=your-secret"
```

Returns `200` with a JSON body:

```json
{"count": 2}
```

### Response Codes

- `200`: Success
- `400`: Missing `text`, or invalid `since`/`limit`
- `401`: Missing or invalid password
- `404`: Unknown path (authenticated requests only; unauthenticated requests always get 401)
- `405`: Method not allowed (non-GET requests)
- `429`: Rate limit exceeded
- `500`: Server error

## Development

```bash
pnpm install
pnpm dev            # local dev server at http://localhost:8787
pnpm test           # tests in watch mode
pnpm test:run       # tests once
pnpm typecheck      # tsc over src and test
pnpm lint           # biome check
pnpm format         # biome check --write
pnpm cf-typegen     # regenerate worker-configuration.d.ts after changing wrangler.jsonc
```

For local dev, put a development password in `.dev.vars` (gitignored):

```
SECRET_PASSWORD=dev-password
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck, a check that `worker-configuration.d.ts` is up to date, and the test suite on pushes to `main` and on pull requests.
