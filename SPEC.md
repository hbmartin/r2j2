# Journal API Specification

## Endpoints

All endpoints are `GET` only and authenticate via a `password` query parameter.

### Add Journal Entry
- **Method**: GET
- **Path**: `/` (root)
- **Purpose**: Append a timestamped journal entry to R2 storage

### Retrieve Journal Contents
- **Method**: GET
- **Path**: `/csv`
- **Purpose**: Retrieve journal contents as CSV

### Count Journal Entries
- **Method**: GET
- **Path**: `/count`
- **Purpose**: Return the number of journal entries as JSON

## Parameters

### Root Endpoint (`/`)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `password` | string | Yes | Authentication password (must match `SECRET_PASSWORD` secret) |
| `text` | string | Yes | Journal entry text (URL-decoded once by standard query parsing) |

### CSV Endpoint (`/csv`)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `password` | string | Yes | Authentication password |
| `since` | integer | No | Only return entries with a Unix timestamp strictly greater than this value |
| `limit` | integer | No | Return at most this many entries (oldest first); must be a positive integer |

### Count Endpoint (`/count`)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `password` | string | Yes | Authentication password |
| `since` | integer | No | Only count entries with a Unix timestamp strictly greater than this value |

## Environment

- `SECRET_PASSWORD` (secret): the authentication password, set via `wrangler secret put SECRET_PASSWORD`
- `ENTRIES_PREFIX` (var, default `entries/`): R2 key prefix under which one object per entry is stored
- `LEGACY_JOURNAL_KEY` (var, default `journal.txt`): key of a pre-existing single-file journal that is merged into read results
- `JOURNAL_BUCKET` (R2 binding): the journal bucket
- `RATE_LIMITER` (rate limit binding): per-IP request rate limiting

## Request Flow

1. Reject non-GET requests with 405.
2. Check the per-IP rate limit (keyed on `CF-Connecting-IP`); reject with 429 when exceeded.
3. Authenticate: compare the SHA-256 digest of the `password` parameter against the digest of `SECRET_PASSWORD` using a constant-time comparison. A missing or wrong password returns 401 with an empty body. Authentication happens before routing, so unauthenticated requests cannot probe which paths exist.
4. Route by path; unknown paths return 404.

### Write path (`/`)

1. Read `text` from the query string (standard single URL-decode; the worker never calls `decodeURIComponent` again).
2. Missing or empty `text` returns 400 with an empty body.
3. Generate a Unix timestamp (seconds).
4. Write the raw text as a **new R2 object** with key `{ENTRIES_PREFIX}{timestamp padded to 12 digits}-{8 random hex chars}`. One object per entry makes writes atomic: concurrent requests can never lose data the way a read-modify-write of a shared file could, and keys sort chronologically.
5. Return 200 with JSON body `{"timestamp": <unix_timestamp>}`.

### Read path (`/csv`)

1. Validate `since`/`limit`; invalid values return 400.
2. List entry objects under `ENTRIES_PREFIX` (paginated; `startAfter` is used to skip keys at or before `since`).
3. Read the legacy single-file journal at `LEGACY_JOURNAL_KEY` (if present) and parse its `timestamp,text` lines.
4. Merge, filter by `since` (exclusive), sort ascending by timestamp, and apply `limit`.
5. Serialize as CSV with `Content-Type: text/csv; charset=utf-8`. Each row is `{timestamp},{text}`; text containing commas, double quotes, or line breaks is quoted and escaped per RFC 4180.

### Count path (`/count`)

Returns 200 with JSON body `{"count": <number>}` counting entry objects plus legacy lines, honoring `since`.

## Response Codes

- **200 OK**: success (`/` returns JSON, `/csv` returns CSV, `/count` returns JSON)
- **400 Bad Request**: missing `text`, or invalid `since`/`limit` (empty body)
- **401 Unauthorized**: missing or wrong `password` (empty body)
- **404 Not Found**: authenticated request to an unknown path
- **405 Method Not Allowed**: non-GET request (plain text body)
- **429 Too Many Requests**: per-IP rate limit exceeded (plain text body)
- **500 Internal Server Error**: unexpected error, e.g. an R2 failure (plain text body with the error message; also logged to console)

## Example Requests

### Add an entry
```
GET /?password=mySecretPass&text=Hello%20World%21
```
Response: `200 OK`
```json
{"timestamp": 1640995200}
```

### Read the journal
```
GET /csv?password=mySecretPass
```
Response: `200 OK`
```
1640995200,Hello World!
1640995260,"an entry, with a comma"
```

### Read entries newer than a timestamp, at most 100
```
GET /csv?password=mySecretPass&since=1640995200&limit=100
```

### Count entries
```
GET /count?password=mySecretPass
```
Response: `200 OK`
```json
{"count": 2}
```

## Backward Compatibility

Deployments that previously stored the whole journal in a single `journal.txt` object keep working: that file is never modified, and its lines are merged into `/csv` and `/count` results alongside per-object entries. Legacy lines are re-escaped on output, and a malformed legacy line (no leading integer timestamp) is preserved with timestamp `0` rather than dropped.
