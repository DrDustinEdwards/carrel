-- contract: Dustin's drive.file refresh token moves from two base64 columns (refresh_token, iv) to
-- site-runtime secret-box's one sealed value in refresh_token (`v1:keyId:ivHex:cipherHex`, under the same
-- GOOGLE_TOKEN_KEY), which names its key so the key can rotate. A migration cannot run the crypto to
-- reseal the stored token, and the table holds one grant, the Owner's own, made again with one "Connect
-- Google" from the home page. So the grant is deleted, not resealed, and the iv column dropped. Run by
-- hand before the deploy that ships the sealed format: npm run db:migrate:remote.
DELETE FROM google_tokens;
ALTER TABLE google_tokens DROP COLUMN iv;
