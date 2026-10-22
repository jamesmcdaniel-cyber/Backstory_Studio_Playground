-- Snowflake key-pair (signed JWT) and programmatic-access-token HTTP auth.
--
-- http_credentials.authType is free text (validated by the API's enum), but
-- credential_resolvers pins the auth type with a CHECK so a binding can never
-- swap a resolver's authority to another scheme. Widen that list to the two
-- new types; nothing else changes.
ALTER TABLE "credential_resolvers" DROP CONSTRAINT "credential_resolvers_auth_type_check";
ALTER TABLE "credential_resolvers" ADD CONSTRAINT "credential_resolvers_auth_type_check"
  CHECK ("authType" IN ('basic', 'bearer', 'custom', 'digest', 'header', 'oauth1', 'oauth2', 'query', 'snowflake_keypair', 'snowflake_pat'));
