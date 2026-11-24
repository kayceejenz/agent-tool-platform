# Agent Tool Platform

A platform for analysing CSV datasets with language-model agents, running generated Python in a Docker sandbox, and evaluating the results against reference answers.

Users upload a dataset, configure an agent, ask a question and inspect the answer alongside its code, tool calls and generated files. MCP connections and manual tool benchmarks are optional extensions.

- [Backend API documentation](https://api.agent.kayceejenz.dev/docs)

## Main workflow

1. Create an account using a valid invitation code and open a project.
2. Upload CSV files in **Datasets**. Inspect their headers and sample records in the file tree.
3. Create an agent and choose a model. Custom prompts and MCP tools are optional.
4. Open **Playground → Run**. The first available dataset is selected by default.
5. Enter a question and, optionally, paste expected-answer JSON for that run.
6. Inspect the readable final answer, structured answer fields, execution trace and downloadable outputs.
7. Use **Evaluate** to run a saved question suite with one or five attempts per question.

Dataset analysis does not require an MCP server. The built-in tools are:

| Tool             | Purpose                                                                              |
| ---------------- | ------------------------------------------------------------------------------------ |
| `list_files`     | List the selected dataset's files, paths, sizes and hashes.                          |
| `read_file`      | Read a bounded preview of an input or workspace file.                                |
| `execute_python` | Run Python to calculate summaries, query data and generate CSV, JSON or PNG outputs. |

## Local setup

### Prerequisites

- Python 3.12 or newer and `uv`.
- Node.js compatible with `apps/web-client/package.json` and pnpm 10.33.4.
- A PostgreSQL database with migration-owner and runtime credentials.
- Docker with the engine running.
- A server-side API key for the selected model provider.

### Configure the backend

From the repository root:

```sh
cd apps/server
uv sync --locked
cp -n .env.example .env
```

Edit `.env` before starting services:

- Set `AGENT_DATABASE_URL` and `AGENT_MIGRATION_DATABASE_URL` for your PostgreSQL database. The example targets port 5433. The migration login needs permission to create the application schema and apply migrations.
- Set the API key for the provider you intend to use: `AGENT_OPENAI_API_KEY`, `AGENT_GOOGLE_API_KEY` or `AGENT_ANTHROPIC_API_KEY`.
- Generate `AGENT_JWT_SECRET` and `AGENT_AUTH_PROXY_SECRET`, for example with `openssl rand -hex 32`.
- Set `AGENT_REGISTRATION_INVITATION_CODE` for account creation.
- Generate `AGENT_MCP_CREDENTIAL_KEY` using the command in `.env.example`. This protects optional stored MCP credentials.
- Keep `AGENT_FILE_STORAGE_BACKEND=local` for local file storage.

Apply migrations before starting the API and worker:

```sh
uv run --locked agent-platform-migrate --status
uv run --locked agent-platform-migrate
```

Applied migrations are checksum-verified. Add a new migration for schema changes instead of editing an applied file.

### Build the analysis sandbox

From the repository root:

```sh
docker build -t agent-analysis:phase2 apps/server/sandbox
```

The tag must match `AGENT_SANDBOX_IMAGE`. The default is `agent-analysis:phase2`. Docker access is needed for the local API's image check and the worker's sandbox execution.

### Start the API and worker

Run these in separate terminals, each from `apps/server`:

```sh
uv run --locked agent-platform-api
```

```sh
uv run --locked agent-platform-worker
```

The API defaults to `http://127.0.0.1:8001`. `/health` checks liveness, `/ready` checks database readiness, and `/docs` exposes the API documentation.

### Start the frontend

From the repository root:

```sh
cd apps/web-client
pnpm install --frozen-lockfile
cp -n .env.example .env.local
pnpm dev
```

Set `AUTH_PROXY_SECRET` to the same value as backend `AGENT_AUTH_PROXY_SECRET`. The defaults use `SERVER_API_URL=http://127.0.0.1:8001` and `APP_ORIGIN=http://localhost:3001`. Open `http://localhost:3001`.

Restart the API and worker after backend code or environment changes. Restart the frontend after changing its environment.

## Checks

Backend, from `apps/server`:

```sh
uv run --locked ruff check --select E4,E7,E9,F src
uv run --locked pytest -m 'not integration and not sandbox' -q
```

Database integration tests require `AGENT_TEST_DATABASE_URL` pointing to a dedicated database whose name ends in `_test`. Existing grant tests also expect an `agent_platform_api` role. Docker sandbox tests additionally require `RUN_SANDBOX_TESTS=1` and the test image configuration used in [.github/workflows/ci.yml](.github/workflows/ci.yml).

Frontend, from `apps/web-client`:

```sh
pnpm lint
pnpm typecheck
pnpm test:metrics
```

`test:metrics` builds the frontend and runs evaluation UI and transport tests against a local mock API without calling a model. For a production preview, use `pnpm build` followed by `pnpm start`.



## Optional MCP capabilities

MCP is useful when an agent needs external systems in addition to uploaded data. Projects can connect MCP servers, discover tools and schemas, enable selected tools, test calls manually and inspect their history. Tool benchmarks provide separate reference-based tool-use comparisons.

The optional ecommerce demo runs independently:

```sh
cd apps/mcps/ecommerce
uv sync --locked
uv run --locked ecommerce-mcp
```

Its local endpoint is `http://127.0.0.1:8012/mcp` using Streamable HTTP without authentication. Starting this demo is not required for the dataset workflow.
