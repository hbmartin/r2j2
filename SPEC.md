# Journal API Specification

## Endpoint
- **Method**: GET
- **Path**: `/` (root)
- **Purpose**: Authenticate and append timestamped journal entries to R2 storage

## Parameters
Both parameters are required query parameters:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `password` | string | Yes | Authentication password (must match `SECRET_PASSWORD` env var) |
| `text` | string | Yes | Journal entry text (will be URL decoded) |

## Environment Variables
- `SECRET_PASSWORD`: The authentication password stored securely in Cloudflare Worker environment

## R2 Configuration
- **R2 Bucket Binding**: `JOURNAL_BUCKET` (bound to bucket `harold-martin`)

## Request Flow
1. Extract `password` and `text` query parameters
2. Validate `password` against `SECRET_PASSWORD` environment variable
3. If authentication fails, return 401 with no body
4. If authentication succeeds:
   - URL decode the `text` parameter
   - Generate Unix timestamp
   - Format entry as: `{timestamp},{decoded_text}\n`
   - Append to `journal.txt` in R2 bucket `harold-martin`
5. Return appropriate response based on operation result

## Response Codes

### Success
- **200 OK**: Entry successfully saved
- **Body**: Empty

### Client Errors
- **400 Bad Request**: Missing required parameters (`password` or `text`)
- **Body**: Empty
- **401 Unauthorized**: Password parameter doesn't match `SECRET_PASSWORD`
- **Body**: Empty

### Server Errors
- **500 Internal Server Error**: R2 operation failed
- **Body**: Plain text error message describing the failure

## File Format
Entries in `journal.txt` follow this format:
```
{unix_timestamp},{url_decoded_text}
{unix_timestamp},{url_decoded_text}
...
```

## Example Requests

### Successful Request
```
GET /?password=mySecretPass&text=Hello%20World%21
```
Response: `200 OK` (empty body)

### Authentication Failure
```
GET /?password=wrongpass&text=Hello%20World%21
```
Response: `401 Unauthorized` (empty body)

### Missing Parameters
```
GET /?password=mySecretPass
```
Response: `400 Bad Request` (empty body)

## Implementation Notes
- The worker should handle URL decoding of the `text` parameter
- Unix timestamps should be generated at the time of processing
- R2 operations should append to existing file or create if it doesn't exist
- **R2 Append Strategy**: Use R2's put operation with new content only - don't read existing file to minimize operations and costs
- All R2 errors should be caught and returned as 500 responses with error details
- Internal errors should be logged to console for debugging
