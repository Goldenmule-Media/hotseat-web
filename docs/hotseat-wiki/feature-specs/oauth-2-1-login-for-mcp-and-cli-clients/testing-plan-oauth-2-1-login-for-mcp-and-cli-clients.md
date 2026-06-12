# Testing plan — OAuth 2.1 login for MCP and CLI clients

**Status:** draft

## Planned
_None._

## Passed
- Metadata: GET /.well-known/oauth-authorization-server returns issuer=publicUrl, authorization_endpoint=/auth/authorize, token_endpoint=/auth/token, registration_endpoint=/auth/register, code_challenge_methods_supported=["S256"], grant_types including refresh_token — with NO Authorization header and CORS headers present; same for /.well-known/oauth-protected-resource (authorization_servers=[publicUrl]); both still reachable while data-plane paths 401.
- Registration: POST /auth/register with redirect_uris ["http://127.0.0.1:0/callback"] returns a wsid1 client_id whose blob round-trips; https URIs accepted; non-loopback http (http://evil.com/cb) rejected 400 invalid_redirect_uri.
- Authorize → code dance (githubStub + injected nowSeconds): GET /auth/authorize with response_type=code, a registered wsid1 client_id, a loopback redirect_uri, an S256 code_challenge, and state=xyz 302s to GitHub with a wst1 state embedding the pending OAuth request and sets the nonce cookie; /auth/github/callback (cookie matching) 302s to the client redirect_uri with ?code=wsc1…&state=xyz — and the plain (non-OAuth) login flow still returns the token in the URL FRAGMENT unchanged.
- Authorize rejections: missing code_challenge or method≠S256 → 400 invalid_request; redirect_uri not in the wsid1 blob → 400 with no redirect; tampered client_id → 400 invalid_client; user not in allowedUsers → 403 at the callback with no code minted.
- Token exchange: POST /auth/token (form-encoded) grant_type=authorization_code with the right code_verifier returns {access_token: wsv1…, token_type: Bearer, expires_in: accessTokenTtlSeconds, refresh_token: wsr1…}; wrong verifier → 400 invalid_grant; expired code (clock advanced past 120s) → invalid_grant; code redeemed with a different client_id or redirect_uri → invalid_grant; the minted access token then authorizes a data-plane proxy request AND /auth/me.
- Refresh grant: grant_type=refresh_token returns a fresh wsv1 + a rotated wsr1 whose exp does NOT exceed the original refresh exp; tampered/expired wsr1 → invalid_grant; a user removed from WIKI_SERVER_AUTH_USERS is refused at refresh; rotating the session secret invalidates code, refresh, and access tokens alike (extend auth-tokens.test.ts tamper/expiry suite for wsc1/wsr1/wsid1).
- Discovery on 401: an unauthenticated data-plane request's www-authenticate equals Bearer realm="wiki-server", resource_metadata="<publicUrl>/.well-known/oauth-protected-resource"; auth-wiring.test.ts asserts the embedded MCP endpoint's 401 carries realm="wiki-mcp" plus resource_metadata, and the MCP listener serves its own protected-resource document.
- CLI credentials + refresh (RecordingProxy pattern from wiki-mirror/test/token-header.test.ts): CredentialsStore round-trips ~/.wiki/credentials.json with mode 0600 and atomic writes; oauthHeaders() sends the cached access token, then after the clock passes accessTokenExp the NEXT stream request carries a new wsv1 minted via an observed POST /auth/token refresh — proving per-request evaluation through the engine's headerOpts() seam; a static WIKI_MIRROR_TOKEN still wins over stored credentials.
- migrate-workspace: with no --source-token/--dest-token and credentials present for both origins, streamConfig() produces function-valued authorization headers; explicit flags still produce the static header (current behavior preserved).
- Loopback login (unit, no real browser): loginLoopback() produces an /auth/authorize URL containing a fresh S256 challenge, accepts the redirect on its 127.0.0.1 listener, exchanges the code, and persists ServerCredentials — driven end-to-end against the gateway test harness with the GitHub stub.

## Failed
_None._

## References
_None._

## Child pages
_None._
