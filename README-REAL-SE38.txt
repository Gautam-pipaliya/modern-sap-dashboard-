SAP WEB DEVELOPMENT WORKBENCH — GOD MODE BUILD

What changed
1. Package F4 value help against SAP ADT repository search.
2. Transport F4 value help against the current user's modifiable SAP requests.
3. F4 keyboard support on Package and Transport fields.
4. Universal command bar: type SE38, SE11, PA20, SM30, Z... or any authorized T-code.
5. Known workbench T-codes open the purpose-built local web screen.
6. Unknown/arbitrary T-codes open SAP GUI for HTML through the Node server proxy, allowing standard/custom transactions without hardcoding every T-code.
7. Existing real SE38 Display/Create/Save/Syntax/Activate integration is preserved.

Run
1. Replace backend/server.js and frontend/index.html with this build.
2. Keep the existing .env; never put the SAP password in frontend code.
3. npm run dev
4. http://localhost:3000

Important
- Universal arbitrary T-code support requires SAP GUI for HTML / ITS WebGUI to be active and authorized in the SAP system. If /sap/bc/gui/sap/its/webgui is not active, the command bar cannot render a GUI screen because ADT alone does not expose SAP GUI transaction dynpros.
- New transport creation is still subject to the SAP system's CTS configuration. Existing modifiable requests are the safest object-assignment path.
- TLS certificate verification is intentionally disabled for the existing DEV test; install/trust the SAP CA certificate before using this design beyond controlled DEV.
- The reverse proxy is a local development convenience. Add authentication, allowlists and network controls before exposing the Node server beyond localhost.
