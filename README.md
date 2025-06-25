# Journal API Worker

A Cloudflare Worker that provides a secure API endpoint for logging timestamped journal entries to R2 storage.

## Setup Instructions

### 1. Create R2 Bucket

First, create an R2 bucket:

```bash
npx wrangler r2 bucket create your-bucket-name
```

### 2. Configure Environment Variables

Set the secret password for API authentication:

```bash
npx wrangler secret put SECRET_PASSWORD
```

When prompted, enter your desired password. This will be stored securely in Cloudflare's environment.

### 3. Verify Configuration

The R2 bucket binding is already configured in `wrangler.jsonc`:

```json
"r2_buckets": [
  {
    "binding": "JOURNAL_BUCKET",
    "bucket_name": "your-bucket-name"
  }
]
```

### 4. Deploy

Deploy the worker to Cloudflare:

```bash
npm run deploy
```

## Usage

### API Endpoint

- **Method**: GET
- **Path**: `/`
- **Parameters**:
  - `password` (required): Must match your `SECRET_PASSWORD`
  - `text` (required): Journal entry text (will be URL decoded)

### Example Request

```bash
curl "https://your-worker.your-subdomain.workers.dev/?password=your-secret&text=Hello%20World%21"
```

### Response Codes

- `200`: Entry successfully saved
- `400`: Missing required parameters
- `401`: Invalid password
- `500`: Server error

## Development

### Local Development

```bash
npm run dev
```

### Testing Locally

The worker will be available at `http://localhost:8787` when running locally.

**Note**: Local development requires setting up R2 bucket access. You may need to configure local R2 credentials or use `--remote` flag:

```bash
npm run dev -- --remote
```

### File Format

Entries are stored in `journal.txt` with the format:
```
{unix_timestamp},{url_decoded_text}
{unix_timestamp},{url_decoded_text}
...
```

## Continuous Deployment

The repository includes a GitHub Action that automatically deploys to Cloudflare Workers when changes are pushed to the `main` branch.

### Setup GitHub Secrets

Add these secrets to your GitHub repository settings:

1. **CLOUDFLARE_API_TOKEN**: Create an API token at https://dash.cloudflare.com/profile/api-tokens
   - Use the "Custom token" template
   - Permissions: `Zone:Zone:Read`, `Zone:Zone Settings:Edit`, `Account:Cloudflare Workers:Edit`
   - Account Resources: Include your account
   - Zone Resources: Include your zones (if any)

2. **CLOUDFLARE_ACCOUNT_ID**: Found in the right sidebar of your Cloudflare dashboard

### Manual Deployment

You can still deploy manually using:

```bash
npm run deploy
```

## Security Notes

- The `SECRET_PASSWORD` is stored as a Cloudflare Worker secret (encrypted at rest)
- Authentication failures return empty responses to avoid information leakage
- All errors are logged to console for debugging while returning generic error messages to clients
