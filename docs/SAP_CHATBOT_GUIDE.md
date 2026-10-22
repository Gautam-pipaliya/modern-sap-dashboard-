# SAP Developer Chatbot Guide

## Purpose

This guide explains how to configure and use the SAP Developer Chatbot in this workbench. It covers normal SAP and ABAP questions, functional-specification uploads, ABAP report generation, local review drafts, SAP workbench actions, memory, and troubleshooting. The chatbot can draft code and help navigate the workbench; it does not replace SAP authorization, developer review, syntax checks, transport controls, or production change procedures.

## What the chatbot can do

- Answer SAP, ABAP, OData, and workbench questions using the configured OpenAI-compatible API.
- Use recent conversation context from the current browser session. The client sends up to the last 12 chat messages with each request.
- Accept up to five attachments per message: PDF and DOCX specifications, text and code files, and PNG, JPEG, WebP, or GIF images. The browser limits each file to 4 MB and each message to 6 MB total.
- Extract text from PDF, DOCX, and supported text/code files. Send supported images to the configured model for vision analysis.
- Generate a complete executable ABAP report from a functional specification when asked. The chat adds an **Open generated code as local SE38 draft** action when it detects ABAP code in the answer.
- Open selected workbench areas and perform supported navigation actions from plain-language instructions.
- Remember, find, correct, and forget saved facts using the memory commands below.

File attachments are included in the chat request when you press **Send**; choosing a file alone does not upload it for analysis. A successful upload and a successful AI analysis are separate: the AI provider must be reachable and have available quota.

## Configure the chatbot

The API key belongs in the project `.env` file on the server. Do not put it in frontend code, screenshots, chat messages, or source control. Use a key from the OpenAI API project that has access to the configured model.

Relevant settings:

| Variable | Purpose | Example |
| --- | --- | --- |
| `AI_PROVIDER` | `auto`, `openai`, `gemini`, or `compatible` | `auto` |
| `AI_API_KEY` | Private key for the selected OpenAI-compatible provider | Provider API key |
| `AI_MODEL` | Model name accepted by that provider | `gemini-3.8-flash` |
| `AI_BASE_URL` | Provider's OpenAI-compatible API base URL | `https://generativelanguage.googleapis.com/v1beta/openai/` |
| `AI_TRUST_ENV` | Whether the Python HTTP client inherits system proxy and certificate variables | `false` for direct HTTPS when an inherited proxy is broken; `true` when your network requires that proxy |
| `AI_TIMEOUT_SECONDS` | Provider request timeout from 1 to 90 seconds | `60` |
| `AI_MAX_OUTPUT_TOKENS` | Maximum generated response length, from 512 to 32,000 tokens; the selected model/provider may impose a lower limit | `12000` |
| `AI_MAX_CONCURRENT_REQUESTS` | Maximum simultaneous provider requests, from 1 to 16; requests wait up to 15 seconds when capacity is full | `4` |
| `CHATBOT_API_URL` | Dashboard-to-chatbot endpoint for a direct local run | `http://127.0.0.1:8000/api/chat` |
| `COPILOT_HOST` / `COPILOT_PORT` | Address and port for the standalone chatbot service | `127.0.0.1` / `8000` |

Use a provider that supports the OpenAI-compatible Chat Completions API and accepts the configured model. `AI_PROVIDER=auto` detects legacy Gemini/OpenAI keys; select `openai` or `gemini` explicitly, or choose `compatible` and set `AI_API_KEY`, `AI_MODEL`, and `AI_BASE_URL` for a compatible gateway. Image analysis depends on the chosen model supporting image inputs. The coding instructions and larger output budget help with complete source generation, but they do not train or fine-tune the provider's model. Existing `GEMINI_*` and `OPENAI_*` variables remain supported. `/health` reports whether a key is configured and which provider/model was selected, without returning secrets. After changing `.env`, restart the chatbot service. In Docker Compose, recreate the services so they receive the new environment. Keep the chatbot port private; the browser should call the dashboard's `/api/chat` route.

### Run locally

Install project dependencies first. Then start each service in its own terminal from the project directory:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

In a second terminal:

```powershell
npm ci
npm start
```

Open `http://127.0.0.1:3000`. To run the container deployment instead, configure `.env` and run `docker compose up --build -d`.

## Use chat and attachments

1. Open the chatbot panel in the workbench.
2. Type a clear question, or choose **Attach** and select one or more supported files.
3. Confirm the selected file names appear beside the input.
4. Press **Send**. For an attachment-only request, the workbench asks the chatbot to review and explain the files.
5. If the answer contains ABAP code, select **Open generated code as local SE38 draft** to review and edit it in the browser.

For the best results, state the expected output, SAP release assumptions if known, required fields, and any constraints. Ask one focused follow-up at a time when refining a report.

### Example questions

- `Explain this ABAP dump and list the most likely causes.`
- `Review the attached ABAP source. Identify correctness and performance issues, then suggest a corrected version.`
- `Summarize the attached functional specification and list unresolved requirements before writing code.`
- `Open SE38.`
- `Create program ZBOM_REPORT in package ZABAP_N.`

## Generate an ABAP report from a specification

Attach the DOCX or PDF functional specification and use a prompt like this:

> Read the attached functional specification. First summarize the business requirement and list any assumptions or missing details. Then generate a complete executable ABAP report named ZBOM_REPORT. Include a selection screen, input validation, required table reads and joins, authorization checks where applicable, clear error handling, and an ALV result. Keep the code compatible with our SAP release. Do not claim it has been run or activated. Put the full source in one fenced ABAP code block.

Replace the example report name and details with the real project requirements. If the SAP release or table definitions are not in the specification, provide them in the prompt or ask the chatbot to flag assumptions instead of inventing production-specific details.

### Review and move generated code into SAP

1. Read the generated summary and assumptions. Verify the report logic against the functional specification.
2. Choose **Open generated code as local SE38 draft**. This opens a browser-local draft; it has not yet been sent to SAP.
3. Review the source, check names and data types against the target system, and save or download the `.abap` draft as needed.
4. To create the program in SAP, ask the workbench to create the named program in the intended package. Confirm the package and transport in the SAP form.
5. Use SAP's syntax check and activation workflow. Review SAP messages and the final activated object before transport or release.

Generated code can contain incorrect assumptions or syntax. The assistant does not run code in SAP, create a transport silently, or certify a report for production.

## Local drafts and SAP actions

Local SE38 drafts are kept in this browser's local storage on this device. They are not SAP repository objects and are not shared with other users. Use the workbench's import and download controls to move source files in or out of the local editor. Browser storage can be removed by clearing site data, so download important drafts.

When you request a SAP write or development action, check the workbench form and SAP response. SAP roles, package permissions, transport configuration, and system release determine what the configured SAP user can do. A chat response is not proof that a SAP change succeeded.

## Saved memory commands

Use these commands in chat:

| Command | Example |
| --- | --- |
| Save a fact | `Remember that our custom reports use package ZABAP_N.` |
| List saved facts | `Memory list` or `Memory list sap` |
| Search saved facts | `Memory search: report package` |
| Correct a fact | `Correct memory: old fact -> corrected fact` |
| Forget one fact | `Forget: exact saved fact` |
| Forget a category | `Forget category: project` |
| Clear all facts | `Forget all` |

Memory is stored by the chatbot service in SQLite and can persist across service restarts. Factual statements in prompts may also be saved automatically. Do not store passwords, API keys, personal data, or other secrets as memories.

## Troubleshooting

| Chat message or symptom | What it means | What to do |
| --- | --- | --- |
| `Cannot connect to the configured AI provider` | The chatbot cannot establish an HTTPS connection to the configured API endpoint. A proxy, firewall, DNS, or outbound network policy may block it. | Check `AI_BASE_URL` and network access. If direct HTTPS is allowed but an inherited proxy is failing, set `AI_TRUST_ENV=false`; if a proxy is required, set it up and keep `AI_TRUST_ENV=true`. Restart the chatbot after changing the setting. |
| AI provider returned HTTP 429 | The provider accepted the connection but rejected the request for quota, billing, or rate-limit reasons. | Check the provider project's usage, billing status, and rate limits. |
| API key or permissions error | The provider rejected the credential or the key's project permissions. | Confirm `AI_API_KEY` is present, active, and allowed to use `AI_MODEL`. Keep the key private. |
| Unsupported or rejected model/request | The configured provider does not accept the model or request settings. | Check `AI_MODEL`, `AI_BASE_URL`, and the provider's supported models and API format. |
| File type or size error | The attachment is unsupported, too large, or could not be read. | Use PDF, DOCX, text/code, or supported images; keep each file at or below 4 MB and the message total at or below 6 MB. |
| A greeting works but detailed questions fail | Greetings are answered locally; normal answers and file analysis require the AI provider. | Resolve the provider connection, key, model, and usage issue. |
| Dashboard chat reports service unavailable | The dashboard cannot reach the private chatbot service. | Check that both services are running and `CHATBOT_API_URL` points to the chatbot service from the dashboard process/container. |

For Docker deployments, check service status and logs with:

```powershell
docker compose ps
docker compose logs --tail 100 dashboard chatbot
```

Do not paste logs that contain credentials into chat. Redact keys, cookies, authorization headers, and SAP passwords first.

## Security and operational limits

- Keep `.env` private and excluded from source control. If a key has been exposed, revoke it and replace it with a new key.
- The chatbot sends the prompt, recent conversation context, and selected file contents to the configured AI provider. Do not attach data that your organization does not permit sending to that provider.
- Keep SAP credentials server-side. Visitors use the SAP identity configured for the deployment; the chatbot does not create a separate SAP identity for each visitor.
- Use HTTPS and appropriate authentication before making the dashboard accessible beyond a trusted local environment.
- Treat AI-generated code as a draft. Apply normal peer review, SAP syntax checks, authorization checks, testing, and transport approvals before production use.
- Provider availability, quota, model support, SAP connectivity, and user authorization are independent requirements. A healthy dashboard alone does not confirm that all four are working.
