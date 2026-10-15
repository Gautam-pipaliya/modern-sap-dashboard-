# Peak Level Deployment

## Requirements

- Docker Engine with the Compose plugin
- A reachable SAP system using HTTPS
- A trusted SAP TLS certificate (or its CA certificate installed in the Node container)
- A strong dashboard username and password
- An OpenAI API key if ChatGPT responses are required

## Configure and start

1. Copy `.env.example` to `.env` and replace every SAP and dashboard placeholder with real values. Keep `.env` out of source control.
2. Start the services with `docker compose up --build -d`.
3. Check service status with `docker compose ps` and logs with `docker compose logs -f dashboard chatbot`.
4. The dashboard is bound to `127.0.0.1:3000` by default. Put it behind a TLS-terminating reverse proxy with rate limiting before allowing remote access.

## Client presentation without SAP access

Run `npm run demo` from the project directory and open `http://127.0.0.1:3000`. This starts a clearly labeled, read-only presentation environment with fictional catalog and business records. Demo mode makes no SAP requests, disables transaction launches, and rejects OData writes. It demonstrates the UI and API-read workflow; it is not evidence that the customer's SAP system or authorizations are connected. Use `npm start` only when the SAP endpoint, credentials, and trusted CA are configured for live use.

The dashboard and chatbot share a private Compose network. The browser calls `/api/chat` on the dashboard origin; it never needs a connection to the chatbot container or a visitor-local port. The chatbot service is not published on the host.

## ABAP drafts when SAP is unavailable

In SE38, **Create Local Draft** opens an editable ABAP buffer saved in this browser, and **Local Drafts** lists drafts to display or change. Drafts are stored in browser local storage on this device; they are not sent to SAP and cannot be syntax-checked or activated until SAP is connected. Local editing autosaves; **Ctrl+S** saves immediately. The editor shows line numbers and cursor position, supports indentation with Tab/Shift+Tab and Enter, and keeps up to three recovery points for drafts up to 10,000 characters. Use **Import .abap** to open a source file or **Download .abap** to export the draft.

When run directly with `python app.py`, the chatbot binds to `127.0.0.1:8000` by default. Compose overrides this to `0.0.0.0:8000` only inside its private service network; do not publish that container port to the host.

## Private SAP CA certificate with Docker Compose

The base Compose file does not copy certificates into either image. If SAP uses a private CA, keep the PEM file outside the project and run Compose with the certificate override. Set `SAP_CA_CERT_HOST_PATH` in your shell or local `.env` to the absolute path of the PEM CA file; this file and `.env` are ignored by Git and Docker build contexts.

```powershell
$env:SAP_CA_CERT_HOST_PATH = 'C:\certs\sap-root-ca.pem'
docker compose -f docker-compose.yml -f docker-compose.ca.yml up --build -d
```

The override mounts the CA read-only at `/run/secrets/sap-ca.pem` and configures `SAP_CA_CERT` inside the dashboard container. Keep `SAP_TLS_REJECT_UNAUTHORIZED=true`. For a public CA trusted by Node.js, use the base Compose file without the override.

## Configuration

- `SAP_BASE_URL`, `SAP_CLIENT`, `SAP_USERNAME`, and `SAP_PASSWORD` are required in production. The SAP URL must use HTTPS.
- To connect this deployment to another SAP system or SAP client, update those four values in `.env` and restart the app (or recreate the Compose services). The backend uses that configured SAP identity for all dashboard visitors; individual visitors do not each get separate SAP credentials. Every visitor must have access to the dashboard, and the configured SAP user must have the needed SAP authorizations.
- Sales Order form defaults are optional and can also be set in `.env`: `SAP_SALES_ORDER_TYPE`, `SAP_SALES_ORGANIZATION`, `SAP_DISTRIBUTION_CHANNEL`, `SAP_DIVISION`, `SAP_SOLD_TO_PARTY`, `SAP_DEFAULT_MATERIAL`, `SAP_DEFAULT_UNIT`, `SAP_DEFAULT_PLANT`, and `SAP_DEFAULT_STORAGE_LOCATION`. They must be valid in that SAP system. Leave a value blank to enter it on the form; creating orders is a real SAP write.
- `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` protect the dashboard and all API routes except `/api/health` using HTTP Basic authentication. Use TLS at the reverse proxy; do not expose Basic authentication over plain HTTP.
- `SAP_TLS_REJECT_UNAUTHORIZED` defaults to `true`. Do not disable it. The npm start, demo, and dev commands run Node with `--use-system-ca`, and the SAP HTTPS agent also includes the OS trust store. Use Node.js 22.19.0 or later. If SAP uses a private CA that is not trusted by the OS, mount its PEM file and set `SAP_CA_CERT` (relative paths are resolved from the project root), or have SAP Basis install the approved CA in the OS trust store. If `SAP_BASE_URL` uses an IP or alias that differs from the certificate name, set `SAP_TLS_SERVERNAME` to the DNS name on the certificate. `NODE_EXTRA_CA_CERTS` is also supported when set before Node starts.
- Ambient `HTTP_PROXY` and `HTTPS_PROXY` settings are not used for SAP API calls. Set `SAP_HTTP_PROXY` when API traffic must use a proxy. SAP GUI for HTML uses the direct SAP connection.
- SAP GUI for HTML also requires the `/sap/bc/gui/sap/its/webgui` ICF service to be active and authorized in SAP.
- `OPENAI_API_KEY` is required for AI chat. SAP workbench functions remain available without it. The server-side chatbot service keeps this key out of the browser.
- The SAP Copilot chat keeps the last six exchanges in the current browser session and accepts up to five PDF, DOCX, text/code, or screenshot attachments (6 MB total per message). Image understanding depends on the configured model/provider supporting vision. For a functional specification, ask for a complete executable ABAP report and provide the report name; use **Open generated code as local SE38 draft** to review it. Then ask the chat to create the named report in your package and transport, confirm the values in SE38, create it in SAP, and save the draft source. This does not skip SAP authorization, syntax check, or your review.
- `OPENAI_MODEL` defaults to `gpt-4.1` for stronger coding responses. Set it to any model supported by your configured OpenAI-compatible provider; `OPENAI_MODEL` takes precedence over the `CHATGPT_MODEL` alias.
- `OPENAI_TRUST_ENV` defaults to `true`, which lets the chatbot use system proxy and certificate environment settings. Set it to `false` to bypass inherited `HTTP_PROXY`/`HTTPS_PROXY` settings when direct HTTPS access is available; restart the chatbot after changing it.
- `OPENAI_TIMEOUT_SECONDS` defaults to 60 and must be 1–90 seconds. The Node chat proxy allows 120 seconds for long functional-specification and code-generation requests. Provider retries are disabled.
- The OData cockpit reads the live Gateway service catalog and can query services exposed to the configured SAP user. Use the module filter (MM, SD, PP/QM, HCM, FI/CO) and `Discover Entity Sets` to browse a selected service's metadata. Service availability, data visibility, and supported operations depend on the SAP release, activated Gateway services, and the user's authorizations. Generic catalog discovery is read-only; writes remain restricted to the curated APIs.
- OData reads support `$filter`, `$select`, `$orderby`, `$skip`/`$top` paging, optional total counts, and `$search` when the selected SAP service implements it. Use the OData cockpit query fields; paging is capped at 1,000 rows per request and offsets at 100,000. Check the entity metadata for property names and the specific API documentation for supported query options.
- When SAP returns an OData continuation link, the workbench validates that it stays on the same SAP host, client, and entity endpoint before following it. The Next/Previous controls use native continuation links when available and offset paging otherwise.
- The OData explorer's **Load Fields & Keys** action reads the selected entity type from `$metadata`, then lets you construct typed filters from discovered properties. Results render as a table with expandable raw JSON; CSV and JSON exports include the currently loaded page. Demo mode uses fictional records and sample schemas.
- The OData cockpit can save up to 30 named query presets in this browser's local storage. Presets store the service/entity and read options only; they do not contain SAP credentials or record results.
- Metadata discovery includes navigation relationships. Select valid relationships to use OData `$expand`; service depth and allowed expansions are still controlled by SAP. Export all reads at most 10,000 rows in pages of up to 1,000 and can be cancelled from the cockpit.
- The current-page profiler summarizes missing fields, distinct counts, frequent values, and numeric/date ranges locally in the browser; it profiles only the rows currently displayed.
- The Functional T-code Directory provides common HCM, MM, SD, PP/QM, and FI/CO transactions, searchable by code, task, or area. Launches use SAP GUI for HTML. A listed T-code still must exist in the connected system, be supported by WebGUI, and be authorized for the configured SAP user. SAP Basis may also need to activate and authorize `/sap/bc/gui/sap/its/webgui`.
- Teach persistent chatbot memory with `Remember that ...`; retrieve matching memories in later answers. Use `Memory list` or `Memory list sap` to review saved facts, `Memory search: <words>` to find matches, and `Correct memory: <exact saved fact> -> <corrected fact>` to update one. Use `Forget: <exact saved fact>`, `Forget category: sap`, or `Forget all` to remove saved knowledge. Factual statements in prompts may also be stored automatically; generated answers are not automatically treated as truth. The Compose volume `copilot_memory` preserves this memory across container restarts.
- `PUBLIC_PORT` changes the host-side loopback port; the internal application port remains `3000`.

For a non-container deployment, use Node.js 22.19.0 or later, install with `npm ci`, install Python dependencies from `requirements.txt`, and run the Node app and `app.py` as separate supervised services. Set `CHATBOT_API_URL` to the private chatbot service URL.

CI checks backend and inline frontend JavaScript syntax, compiles the Python service, and builds both container images on pushes and pull requests. A successful CI run verifies packaging and syntax; it does not establish SAP connectivity or authorization.

This repository does not include organization-specific SSO, role-based authorization, centralized audit logging, or SAP CA material. Add those controls at the deployment boundary before using the workbench in a shared or internet-facing environment.
