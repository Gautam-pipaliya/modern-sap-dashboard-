SAP WEB DEVELOPMENT WORKBENCH — ENTERPRISE V3

Core architecture
- Browser -> Node.js/Express -> SAP ADT for repository development.
- Browser -> Node.js/Express -> SAP GUI for HTML for arbitrary classic transactions.
- Browser -> Node.js/Express -> SAP Gateway/OData for business APIs.

OData portfolio
1. API_BUSINESS_PARTNER / A_BusinessPartner (existing proven API)
2. API_PRODUCT_SRV / A_Product
3. API_PURCHASEREQUISITION_2 / A_PurchaseRequisitionHeader_2 (OData V4)
4. API_PURCHASEORDER_2 / PurchaseOrder (OData V4)
5. API_SALES_ORDER_SRV / A_SalesOrder (OData V2)

The UI reads the live SAP Gateway ServiceCollection and shows which recommended
services actually exist in the connected SAP catalog. The five services are
curated for the workbench; their presence depends on the connected S/4HANA release
and service activation.

RICEFW distinction
- Repository/code objects: ADT (programs, classes, enhancements, etc.), not a generic OData service.
- Business data/integration: OData APIs where SAP exposes them.
- Interfaces may also use RFC, BAPI, IDoc and SOAP depending on the integration.
- Forms and workflow are not all created/modified through one generic OData service.

CRUD
- GET is used for investigation/read.
- Guarded POST/PATCH/DELETE routes are provided for the five curated APIs.
- CSRF token and SAP session cookies are handled server-side.
- Writes require explicit confirmation in the UI.

WebGUI
- Sessionized /sap(<session>)/... paths are accepted by the proxy so classic GUI
  POSTs do not die at local Express routing.
- Arbitrary authorized T-codes continue through SAP GUI for HTML.

Security
- SAP credentials stay server-side in .env.
- DEV TLS is still configured with certificate validation disabled; replace with
  trusted CA certificates for any non-development deployment.
- Never expose this Node server publicly without authentication, authorization,
  CSRF/session controls, rate limiting and audit logging.
