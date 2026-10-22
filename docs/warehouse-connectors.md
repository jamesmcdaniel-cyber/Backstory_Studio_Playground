# Connecting Databricks and Snowflake

Flows and agents reach Databricks and Snowflake through two built-in connections:

| Connection | Tools | Read or write |
| --- | --- | --- |
| Databricks | `databricks_sql_query`, `databricks_run_job` | A query is a read when it is `SELECT`, `SHOW`, `DESCRIBE` or `WITH … SELECT`. Any other statement is a write, and so is every job run. |
| Snowflake | `snowflake_sql_query` | Same rule as Databricks. |

Neither connection needs an integration install. Each one runs on an **HTTP credential that is restricted to the warehouse's host**. You save it once on the **Credentials** page (`/credentials` → **New credential**, with the API URL set to the warehouse host). Every step and agent in the workspace then finds it by host, so nobody types a token into a flow. If the workspace has a credential for exactly one Databricks host (or one Snowflake account), steps can leave `host` out. If it has credentials for several, each step must pass `host`.

The credential is checked against the API when you save it. After that it is stored encrypted and is only applied to requests sent to that host. A step that can't find a credential fails with a message telling you what to save, for example: "Save a credential for acme.snowflakecomputing.com in Integrations".

Writes are audited. An agent with **Require approval** turned on queues each write for a person to approve. A step with a read-only tool policy refuses writes outright.

---

## Databricks

**Host:** your workspace URL without `https://`. Examples: `dbc-1234abcd-5678.cloud.databricks.com`, `adb-1234567890123456.7.azuredatabricks.net`, `1234567890123456.7.gcp.databricks.com`.

**Credential.** Choose one:

1. **Bearer Auth**, holding a personal access token. This is the simplest option. Create the token as a service principal, not as a person: *Settings → Identity and access → Service principals → (the SP) → Secrets / Tokens*. Use a person's token only for a trial.
2. **OAuth2 API**, using client credentials (machine-to-machine). Use this when tokens must rotate.
   - Token URL: `https://<host>/oidc/v1/token`
   - Client ID and secret: the service principal's OAuth secret
   - Scope: `all-apis`

When you save the credential, verify it against `https://<host>/api/2.0/sql/warehouses` with method GET.

**Minimal permissions for the service principal:**

- **Workspace access.** The service principal needs the *Workspace access* entitlement and *Databricks SQL access*.
- **SQL warehouse.** Grant `CAN USE` on the warehouse the flows will query.
  - Steps can leave `warehouseId` out when the principal can see exactly one warehouse, or exactly one running warehouse.
- **Data (Unity Catalog).** Grant `USE CATALOG` on the catalog, `USE SCHEMA` on the schema, and `SELECT` on the tables that are read.
  - Add `MODIFY` only on tables that flows write to.
- **Jobs.** For `databricks_run_job`, grant `CAN MANAGE RUN` on each job the flows start.
  - The job runs under its own *Run as* identity, not as the principal.

---

## Snowflake

**Host:** `<account_identifier>.snowflakecomputing.com`. Examples: `myorg-myaccount.snowflakecomputing.com`, or a legacy locator such as `xy12345.us-east-1.snowflakecomputing.com`.

**Credential.** Choose one. Snowflake's SQL API does **not** accept a username and password, so an n8n "Password" Snowflake credential cannot be reused.

1. **Snowflake Key Pair.** Recommended for service users.

   Generate a key pair:
   ```sh
   openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out rsa_key.p8
   openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub
   ```
   Assign the public key to the user (paste the key body without its header lines):
   ```sql
   ALTER USER BACKSTORY_SVC SET RSA_PUBLIC_KEY='MIIBIjANBgkq…';
   ```
   In the credential, enter:
   - the account identifier (for example `myorg-myaccount`)
   - the user
   - the private key (the full `.p8` PEM)
   - the passphrase, if the key is encrypted

   For each request we sign a one-hour JWT with the key. The key itself never leaves the credential store.

2. **Snowflake Access Token.** A programmatic access token (PAT) created for the user: *Settings → Authentication → Programmatic access tokens*, or `ALTER USER … ADD PROGRAMMATIC ACCESS TOKEN`. If the account requires it, the user also needs a network policy that allows our egress.

3. **OAuth2 API.** For accounts that already use Snowflake OAuth.
   - Token URL: `https://<account>.snowflakecomputing.com/oauth/token-request`
   - Client ID and secret: from the OAuth security integration
   - Refresh token
   - Plain **Bearer Auth** with an OAuth access token also works until the token expires.

When you save the credential, verify it against `https://<account>.snowflakecomputing.com/api/v2/statements` with method GET. Any answer other than 401 or 403 means the credential was accepted.

**Minimal permissions.** Create a dedicated role and user:

```sql
CREATE ROLE BACKSTORY_READER;
GRANT USAGE ON WAREHOUSE ANALYTICS_WH TO ROLE BACKSTORY_READER;
GRANT USAGE ON DATABASE ANALYTICS TO ROLE BACKSTORY_READER;
GRANT USAGE ON SCHEMA ANALYTICS.PUBLIC TO ROLE BACKSTORY_READER;
GRANT SELECT ON ALL TABLES IN SCHEMA ANALYTICS.PUBLIC TO ROLE BACKSTORY_READER;
GRANT SELECT ON FUTURE TABLES IN SCHEMA ANALYTICS.PUBLIC TO ROLE BACKSTORY_READER;

CREATE USER BACKSTORY_SVC TYPE = SERVICE
  DEFAULT_ROLE = BACKSTORY_READER
  DEFAULT_WAREHOUSE = ANALYTICS_WH;
GRANT ROLE BACKSTORY_READER TO USER BACKSTORY_SVC;
```

- **Default warehouse.** Set `DEFAULT_WAREHOUSE`, or pass `warehouse` on each step. A step that has neither fails with *"No active warehouse selected"*.
- **Writes.** Add `INSERT` / `UPDATE` on specific tables only where flows write to them, for example an imported n8n insert or update node.

---

## Importing n8n workflows

The workflow's credentials never come across, because n8n exports only references to them. The import report lists every warehouse step and the credential to save. If a matching credential already exists, the report says which host the steps will use instead.

| n8n node | Imported as |
| --- | --- |
| Snowflake: Execute Query | `snowflake_sql_query`. Expressions that stood for values become bind variables. |
| Snowflake: Insert / Update | `snowflake_sql_query` with a generated `INSERT` / `UPDATE`. Every value is bound from the incoming item. |
| Databricks: Databricks SQL → Execute Query | `databricks_sql_query`. Keeps the warehouse and the `:name` query parameters. |
| Databricks: Files, Genie, Model Serving, Unity Catalog, Vector Search | Kept on the Databricks connection with no action selected, and flagged as an error in the report. Rebuild it with `databricks_sql_query` or an HTTP step. |
| HTTP Request POST to `…/api/2.0/sql/statements` or `…snowflakecomputing.com/api/v2/statements` | The matching warehouse tool. Statements that ran past n8n's wait, or that return several result chunks, still come back in full. |
| AI Agent → Snowflake / Databricks tool | The agent gets that connection's tools. |
| AI Agent → HTTP Request tool | The agent gets the HTTP API connection plus one configured endpoint per tool. The endpoint authenticates with the saved credential for its host. |

Query results come back as records under `rows`, for example `{ rows: [{ ID: 1, NAME: "Acme" }], columns, rowCount, truncated }`. Steps that n8n ran once per row run once per item here. A step that runs only once reads the first row.
