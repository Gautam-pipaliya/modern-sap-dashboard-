# Peak Level SAP Developer Workbench

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Gautam-pipaliya/modern-sap-dashboard-)

See [DEPLOYMENT.md](DEPLOYMENT.md) for live hosting setup and required SAP/OpenAI secrets.

A browser workbench for SAP ABAP development, SAP Gateway/OData exploration, and SAP GUI for HTML. The application keeps SAP credentials on the server and separates repository development through ADT, business APIs through OData, and classic transactions through WebGUI.

## Run the presentation demo

```powershell
npm run demo
```

Open `http://127.0.0.1:3000`. Demo mode uses fictional, read-only data and makes no SAP requests.

## Connect to SAP

1. Copy `.env.example` to `.env` and configure the SAP HTTPS endpoint, client, user, and password.
2. Configure dashboard authentication and install a trusted SAP CA certificate if required.
3. Start with `npm start` for local development or `docker compose up --build -d` for Compose deployment.

See [DEPLOYMENT.md](DEPLOYMENT.md) for TLS, Docker, chatbot, and SAP service configuration.
See the [SAP Developer Chatbot Guide](docs/SAP_CHATBOT_GUIDE.md) for chat setup, file analysis, ABAP report generation, memory commands, and troubleshooting.

## Peak Level capabilities

- ADT workspaces for ABAP programs, dictionary objects, packages, transports, and related development flows.
- Offline SE38 authoring with browser autosave, line numbers, cursor/document metrics, indentation shortcuts, bounded recovery history for smaller drafts, local display/change, `.abap` import/export, and Ctrl+S; offline drafts are explicitly separate from SAP repository objects.
- Live SAP Gateway service discovery and curated business API portfolio.
- Metadata-driven OData exploration: entity fields, keys, and navigation relationships; typed filters; sorting; projection; related-entity expansion; offset and SAP continuation-link paging; optional counts; search; and an encoded request preview.
- Browser-local named query presets plus CSV/JSON exports for the current page or up to 10,000 records across pages, with cancellation.
- Current-page data profiling for missing values, distinct counts, common values, and numeric/date ranges.
- Guarded writes for curated APIs with SAP CSRF handling and explicit browser confirmation. Demo mode rejects writes.
- SAP GUI for HTML transaction launch and a server-side ABAP copilot service.
- A searchable functional T-code directory for HCM, MM, SD, PP/QM, and FI/CO, with launch links through the configured SAP GUI for HTML connection.

Live availability depends on SAP release, activated services, network/TLS setup, and the configured user's authorizations. This label describes the workbench feature set; it does not mean every SAP API or transaction is available in every system.
