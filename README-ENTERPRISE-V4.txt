SAP WEB DEVELOPMENT WORKBENCH — PEAK LEVEL

What changed
- Peak Level data explorer discovers entity fields and keys, builds typed filters, pages/sorts/projects results, supports saved local query presets, and exports page results to CSV/JSON.
- Correct V2/V4 OData base paths for the curated APIs.
- Added live SAP system overview (system ID, client, SAP user, ADT health, OData health, WebGUI).
- OData cockpit now combines live service catalog + curated business API portfolio + CRUD workspace + RICEFW architecture map.
- API_BUSINESS_PARTNER remains the first proven API.
- Four additional portfolio APIs:
  API_PRODUCT_SRV
  API_PURCHASEREQUISITION_2
  API_PURCHASEORDER_2
  API_SALES_ORDER_SRV
- V4 APIs use the S/4HANA /sap/opu/odata4/.../srvd_a2x/.../0001 resource model.
- OData CRUD writes remain guarded to the five curated APIs and require confirmation.
- SAP GUI for HTML sessionized /sap(<session>)/... URLs continue to be proxied.

Architecture
RICEFW repository development -> ADT
Business integration/data -> OData
Classic SAP transactions -> SAP GUI for HTML
Other integration patterns -> RFC/BAPI/IDoc/SOAP as appropriate

This is deliberate: there is no single OData service that creates/modifies every RICEFW repository object.
