# Connecting Databricks and Snowflake

Flows and agents reach Databricks and Snowflake through two built-in connections:

| Connection | Tools | Read or write |
| --- | --- | --- |
| Databricks | `databricks_sql_query`, `databricks_run_job`, plus the workspace-API tools listed under [Databricks operations](#databricks-operations) | A query is a read when it is `SELECT`, `SHOW`, `DESCRIBE` or `WITH … SELECT`. Any other statement is a write, and so is every job run. The other tools are reads when they list, get, query, download or ask. Uploads, deletes, creates, updates and upserts are writes. |
| Snowflake | `snowflake_sql_query` | Same rule as Databricks SQL. |

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
- **Jobs.** For `databricks_run_job` with a `jobId`, grant `CAN MANAGE RUN` on each job the flows start.
  - The job runs under its own *Run as* identity, not as the principal.
  - A one-time run (`runSpec`) runs as the principal. It needs the *Allow cluster creation* entitlement for a `new_cluster`, or `CAN ATTACH TO` on the `existing_cluster_id`, plus read access to the notebook or file it runs.

Grant only the groups your flows use. The minimal grants for the workspace-API tools are:

| Group | Minimal permissions for the service principal |
| --- | --- |
| Files | `USE CATALOG` and `USE SCHEMA` on the volume's parents, then `READ VOLUME` on the volume for download, list and metadata. Add `WRITE VOLUME` for upload, delete, mkdir and rmdir. |
| Genie | `CAN RUN` (or higher) on the Genie space. `CAN USE` on the space's SQL warehouse, and `SELECT` on the tables the space covers. Genie answers with the principal's own data access. |
| Model Serving | `CAN QUERY` on each endpoint queried. Listing and reading endpoints shows only the endpoints the principal has `CAN VIEW` (or higher) on. |
| Unity Catalog | Reads need `USE CATALOG` / `USE SCHEMA` on the parents, and only show the objects the principal has a privilege on. Creating needs `CREATE CATALOG` on the metastore, `CREATE SCHEMA` on the catalog, or `CREATE TABLE` / `CREATE VOLUME` / `CREATE FUNCTION` on the schema. External tables and volumes also need `CREATE EXTERNAL TABLE` / `CREATE EXTERNAL VOLUME` on the external location. Updating and deleting need ownership of the object, or `MANAGE`. |
| Vector Search | Querying needs `SELECT` on the index, plus `USE CATALOG` / `USE SCHEMA` on its parents. Listing and reading need `CAN USE` on the endpoint. Creating an index needs `CREATE TABLE` on the schema, `CAN USE` on the endpoint, and `SELECT` on a Delta Sync source table. Upserting and deleting rows need `MODIFY` on a Direct Access index. |

---

## Databricks operations

Every tool below takes an optional `host`. The tools run on the same saved credential as SQL, through the same guarded request:

- the address is checked against private networks;
- redirects are refused;
- each request times out after two minutes;
- every response is size-capped while it streams.

Files never travel inside flow data as bytes:

- A **download** is saved to the workspace's file store and returned as a file reference: `{ fileId, filename, mimeType, size, url }`. Text-like files also carry their text as `content`. Downloads are limited to 10 MB, or 200 MB for `.csv` / `.tsv`.
- An **upload** takes a file reference from an earlier step, or plain text as `content`.

| Group | Tool | Databricks API | Read / write |
| --- | --- | --- | --- |
| Files | `databricks_files_upload` | `PUT /api/2.0/fs/files/Volumes/…?overwrite=` | write |
| | `databricks_files_download` | `GET /api/2.0/fs/files/Volumes/…` | read |
| | `databricks_files_delete` | `DELETE /api/2.0/fs/files/Volumes/…` | write |
| | `databricks_files_get_metadata` | `HEAD /api/2.0/fs/files/Volumes/…` | read |
| | `databricks_files_list` | `GET /api/2.0/fs/directories/Volumes/…` | read |
| | `databricks_files_mkdir` / `databricks_files_rmdir` | `PUT` / `DELETE /api/2.0/fs/directories/Volumes/…` | write |
| Genie | `databricks_genie_ask` | `POST …/genie/spaces/{space}/start-conversation`, or `…/conversations/{c}/messages` for a follow-up. Then polls the message until it is `COMPLETED` or `FAILED` (10 minutes by default) and fetches the query's rows. | read |
| | `databricks_genie_get_space`, `databricks_genie_get_message`, `databricks_genie_get_query_result` | `GET` the space, the message, or `…/attachments/{a}/query-result` | read |
| | `databricks_genie_execute_query` | `POST …/attachments/{a}/execute-query`. Re-runs the read-only query Genie wrote. | read |
| Model Serving | `databricks_serving_query` | `POST /serving-endpoints/{name}/invocations` with a chat, completions, embeddings or dataframe body | read |
| | `databricks_serving_list`, `databricks_serving_get` | `GET /api/2.0/serving-endpoints[/{name}]` | read |
| Unity Catalog | `databricks_unity_catalog_list`, `databricks_unity_catalog_get` | `GET /api/2.1/unity-catalog/{catalogs, schemas, tables, volumes, functions}` | read |
| | `databricks_unity_catalog_create` | `POST` the same collections. Tables are external Delta tables only, because that is the API's limit. Use `databricks_sql_query` for a managed table. | write |
| | `databricks_unity_catalog_update` | `PATCH` a catalog or a schema: comment, owner, new name | write |
| | `databricks_unity_catalog_delete` | `DELETE` any of the five object types. `force` applies to catalogs and schemas. | write |
| Vector Search | `databricks_vector_search_query` | `POST /api/2.0/vector-search/indexes/{index}/query`, by text or by vector, ANN or HYBRID, with an optional reranker. Matches come back as records under `rows`. | read |
| | `databricks_vector_search_list_indexes`, `…_get_index`, `…_list_endpoints` | `GET /api/2.0/vector-search/{indexes, endpoints}` | read |
| | `databricks_vector_search_create_index` | `POST /api/2.0/vector-search/indexes` (Delta Sync or Direct Access) | write |
| | `databricks_vector_search_upsert`, `databricks_vector_search_delete_data` | `POST …/upsert-data`, `DELETE …/delete-data` on a Direct Access index | write |
| Jobs | `databricks_run_job` | `POST /api/2.1/jobs/run-now` (`jobId`) or `/api/2.1/jobs/runs/submit` (`runSpec`), then polls `runs/get` | write |

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
| Databricks: File → Upload / Download / Delete / Get File Metadata / List Directory / Create Directory / Delete Directory | `databricks_files_upload` / `_download` / `_delete` / `_get_metadata` / `_list` / `_mkdir` / `_rmdir`. An upload takes the file the previous step produced, which replaces n8n's binary field. A download returns a file reference, which replaces n8n's binary data. |
| Databricks: Genie → Start Conversation / Create Conversation Message | `databricks_genie_ask`, with a `conversationId` for a follow-up. The step waits for the answer. n8n returned as soon as the question was accepted, so any Wait plus Get Message loop after it is no longer needed. |
| Databricks: Genie → Get Conversation Message / Get Genie Space / Get Query Results / Execute Message SQL Query | `databricks_genie_get_message` / `_get_space` / `_get_query_result` / `_execute_query` |
| Databricks: Model Serving → Query Endpoint | `databricks_serving_query`. The endpoint is taken from any locator mode (list, name or `/ml/endpoints/` URL), and the request body is carried over as JSON. |
| Databricks: Unity Catalog → List / Get / Create / Delete × Catalog, Table, Volume, Function, and Update Catalog | `databricks_unity_catalog_list` / `_get` / `_create` / `_delete` / `_update`, with `objectType` set |
| Databricks: Vector Search → Query Index / Get Index / List Indexes / Create Index | `databricks_vector_search_query` / `_get_index` / `_list_indexes` / `_create_index` |
| Databricks: an operation n8n's node does not define (for example, from a newer n8n version) | Kept on the Databricks connection with no action selected, and flagged as an error in the report. Every operation in n8n's Databricks node v1 maps to a tool, so this only happens for operations the node doesn't define. |
| HTTP Request POST to `…/api/2.0/sql/statements` or `…snowflakecomputing.com/api/v2/statements` | The matching warehouse tool. Statements that ran past n8n's wait, or that return several result chunks, still come back in full. |
| HTTP Request POST to `…/api/2.x/jobs/run-now` or `…/api/2.x/jobs/runs/submit` | `databricks_run_job`, because n8n has no Jobs operation. `job_id`, `job_parameters` and `notebook_params` (or the whole submit body) carry over. The step waits for the run to finish. Other run-now fields, such as `python_params`, are listed in the report for review. A manual `runs/get` poll stays an HTTP step. |
| AI Agent → Snowflake / Databricks tool | The agent gets that connection's tools. |
| AI Agent → HTTP Request tool | The agent gets the HTTP API connection plus one configured endpoint per tool. The endpoint authenticates with the saved credential for its host. |

Query results come back as records under `rows`, for example `{ rows: [{ ID: 1, NAME: "Acme" }], columns, rowCount, truncated }`. Steps that n8n ran once per row run once per item here. A step that runs only once reads the first row.
