'use strict';

// SAP Sales Order API routes for a local development workbench.
// Credentials remain server-side in .env. Never return credentials, CSRF tokens,
// cookies, or raw request headers to the browser.

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const express = require('express');
const axios = require('axios');
const fs = require('node:fs');
const https = require('node:https');
const tls = require('node:tls');

const router = express.Router();
router.use(express.json({ limit: '256kb' }));

const verifySapTls = String(process.env.SAP_TLS_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'false';
if (process.env.NODE_ENV === 'production' && !verifySapTls) {
  throw new Error('Production requires SAP TLS verification. Configure the SAP CA certificate instead of disabling verification.');
}

let systemCa = [];
if (typeof tls.getCACertificates === 'function') {
  try {
    systemCa = tls.getCACertificates('system');
  } catch (_) {
    // Some Node versions do not expose the operating system CA store.
  }
}
const sapCa = [...tls.rootCertificates, ...systemCa];
if (process.env.SAP_CA_CERT) {
  const certificatePath = path.resolve(__dirname, '..', process.env.SAP_CA_CERT);
  try {
    sapCa.push(fs.readFileSync(certificatePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read SAP_CA_CERT (${process.env.SAP_CA_CERT}): ${error.message}`);
  }
}

const httpsAgent = new https.Agent({
  rejectUnauthorized: verifySapTls,
  ca: sapCa,
  ...(process.env.SAP_TLS_SERVERNAME ? { servername: process.env.SAP_TLS_SERVERNAME } : {}),
});

function getSapProxy() {
  const value = process.env.SAP_HTTP_PROXY;
  if (!value) return false;
  const proxy = new URL(value);
  if (!['http:', 'https:'].includes(proxy.protocol)) {
    throw new Error('SAP_HTTP_PROXY must use HTTP or HTTPS.');
  }
  const auth = proxy.username || proxy.password
    ? {
      username: decodeURIComponent(proxy.username),
      password: decodeURIComponent(proxy.password),
    }
    : undefined;
  return {
    protocol: proxy.protocol,
    host: proxy.hostname,
    port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)),
    ...(auth ? { auth } : {}),
  };
}

const sapAxiosProxy = getSapProxy();
const ORDER_SELECT = [
  'SalesOrder',
  'SalesOrderType',
  'SalesOrganization',
  'DistributionChannel',
  'OrganizationDivision',
  'SoldToParty',
  'CreationDate',
  'TotalNetAmount',
  'TransactionCurrency',
].join(',');
const ORDER_ITEM_SELECT = [
  'SalesOrder',
  'SalesOrderItem',
  'Material',
  'RequestedQuantity',
  'RequestedQuantityUnit',
  'ProductionPlant',
  'StorageLocation',
].join(',');

function getConfig() {
  const baseUrl = (process.env.SAP_BASE_URL || '').trim().replace(/\/+$/, '');
  const username = (process.env.SAP_USERNAME || '').trim();
  const password = process.env.SAP_PASSWORD;
  const client = (process.env.SAP_CLIENT || '').trim();

  const missing = [];
  if (!baseUrl) missing.push('SAP_BASE_URL');
  if (!client) missing.push('SAP_CLIENT');
  if (!username) missing.push('SAP_USERNAME');
  if (!password) missing.push('SAP_PASSWORD');
  if (missing.length) {
    const error = new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
    error.code = 'SAP_CONFIG_MISSING';
    throw error;
  }

  return {
    client,
    serviceRoot: `${baseUrl}/sap/opu/odata/sap/API_SALES_ORDER_SRV`,
    auth: { username, password },
  };
}

// Defaults used by the optional sales-order create/search form. These are
// company-specific SAP organizational values, not connection credentials.
router.get('/config', (_req, res) => {
  res.json({
    salesOrderType: process.env.SAP_SALES_ORDER_TYPE || '',
    salesOrganization: process.env.SAP_SALES_ORGANIZATION || '',
    distributionChannel: process.env.SAP_DISTRIBUTION_CHANNEL || '',
    division: process.env.SAP_DIVISION || '',
    soldToParty: process.env.SAP_SOLD_TO_PARTY || '',
    material: process.env.SAP_DEFAULT_MATERIAL || '',
    unit: process.env.SAP_DEFAULT_UNIT || 'EA',
    plant: process.env.SAP_DEFAULT_PLANT || '',
    storageLocation: process.env.SAP_DEFAULT_STORAGE_LOCATION || '',
  });
});

function makeSapClient(config) {
  return axios.create({
    auth: config.auth,
    httpsAgent,
    // Ignore machine-wide proxy variables, which may point to stale local proxies.
    // Configure SAP_HTTP_PROXY explicitly when SAP API traffic requires a proxy.
    proxy: sapAxiosProxy,
    timeout: 30000,
    maxContentLength: 2 * 1024 * 1024,
    maxBodyLength: 256 * 1024,
  });
}

function odataString(value) {
  // OData string literal escaping: single quotes are doubled.
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sapErrorText(error) {
  const data = error?.response?.data;
  const candidates = [
    data?.error?.message?.value,
    typeof data?.error?.message === 'string' ? data.error.message : null,
    data?.error?.innererror?.errordetails?.[0]?.message,
    data?.message,
  ];
  const found = candidates.find((item) => typeof item === 'string' && item.trim());
  if (found) return found;
  if (error?.code === 'ECONNREFUSED') return 'Connection refused by SAP. Check the host, port, VPN, and SAP availability.';
  if (error?.code === 'ETIMEDOUT' || error?.code === 'ECONNABORTED') return 'SAP request timed out. Check network connectivity and SAP response time.';
  if (error?.code === 'SAP_CONFIG_MISSING') return error.message;
  if (error?.code === 'CERT_HAS_EXPIRED' || error?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return 'TLS certificate validation failed. Configure the SAP certificate/CA; do not disable validation outside DEV.';
  }
  return error?.message || 'Unknown SAP API error.';
}

async function fetchCsrfSession(config) {
  const sap = makeSapClient(config);
  const response = await sap.get(`${config.serviceRoot}/`, {
    params: { 'sap-client': config.client },
    headers: {
      'X-CSRF-Token': 'Fetch',
      Accept: 'application/json',
    },
  });

  const token = response.headers['x-csrf-token'];
  const setCookies = response.headers['set-cookie'] || [];
  const cookie = setCookies.map((value) => value.split(';')[0]).filter(Boolean).join('; ');

  if (!token) {
    throw new Error('SAP did not return X-CSRF-Token. Check API activation, authentication, and Gateway settings.');
  }
  if (!cookie) {
    throw new Error('SAP did not return session cookies with the CSRF token. Recheck authentication and the SAP session.');
  }

  return { sap, token, cookie };
}

function cleanText(value, fieldName, maxLength) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${fieldName} must be text.`);
  }
  const text = String(value).trim();
  if (text.length > maxLength) throw new Error(`${fieldName} must be no longer than ${maxLength} characters.`);
  return text;
}

function validateSalesOrderId(value) {
  const salesOrder = String(value || '').trim();
  if (!/^\d{1,10}$/.test(salesOrder)) {
    throw new Error('Sales Order must contain 1 to 10 digits.');
  }
  return salesOrder;
}

function validateSalesOrderItemId(value) {
  const item = String(value || '').trim();
  if (!/^\d{1,6}$/.test(item)) {
    throw new Error('Sales Order item must contain 1 to 6 digits.');
  }
  return item;
}

function buildOrderPayload(body) {
  const headerLimits = {
    SalesOrderType: 4,
    SalesOrganization: 4,
    DistributionChannel: 2,
    OrganizationDivision: 2,
    SoldToParty: 10,
    PurchaseOrderByCustomer: 35,
  };

  const payload = {};
  for (const [field, maxLength] of Object.entries(headerLimits)) {
    const value = cleanText(body[field], field, maxLength);
    if (value !== undefined && value !== '') payload[field] = value;
  }

  for (const field of ['SalesOrderType', 'SalesOrganization', 'DistributionChannel', 'OrganizationDivision', 'SoldToParty']) {
    if (!payload[field]) throw new Error(`${field} is required.`);
  }

  if (!Array.isArray(body.to_Item) || body.to_Item.length < 1) {
    throw new Error('to_Item must be an array containing at least one item.');
  }
  if (body.to_Item.length > 50) throw new Error('At most 50 line items are allowed per request in this sample endpoint.');

  payload.to_Item = body.to_Item.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`to_Item[${index}] must be an object.`);
    }

    const clean = {};
    const stringFields = {
      SalesOrderItem: 6,
      Material: 40,
      RequestedQuantityUnit: 3,
      ProductionPlant: 4,
      StorageLocation: 4,
      SalesOrderItemText: 40,
    };
    for (const [field, maxLength] of Object.entries(stringFields)) {
      const value = cleanText(item[field], `to_Item[${index}].${field}`, maxLength);
      if (value !== undefined && value !== '') clean[field] = value;
    }

    const quantity = Number(item.RequestedQuantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`to_Item[${index}].RequestedQuantity must be a number greater than zero.`);
    }
    clean.RequestedQuantity = String(quantity);

    if (!clean.Material) throw new Error(`to_Item[${index}].Material is required.`);
    if (!clean.RequestedQuantityUnit) throw new Error(`to_Item[${index}].RequestedQuantityUnit is required.`);
    return clean;
  });

  return payload;
}

function sendApiError(res, error) {
  if (error?.code === 'SAP_CONFIG_MISSING') {
    return res.status(500).json({ error: 'SAP backend is not configured.', details: error.message });
  }
  const sapStatus = error?.response?.status;
  const status = sapStatus >= 400 && sapStatus < 500 ? sapStatus : 502;
  return res.status(status).json({
    error: 'SAP Sales Order API request failed.',
    sapStatus: sapStatus || null,
    details: sapErrorText(error),
  });
}

// GET /api/sales-orders?SalesOrganization=<configured-org>&top=10
router.get('/', async (req, res) => {
  try {
    const config = getConfig();
    const sap = makeSapClient(config);
    const allowedFilters = ['SalesOrder', 'SalesOrderType', 'SalesOrganization', 'DistributionChannel', 'OrganizationDivision', 'SoldToParty'];
    const filters = [];

    for (const field of allowedFilters) {
      const raw = req.query[field];
      if (raw !== undefined && String(raw).trim() !== '') {
        const value = String(raw).trim();
        if (value.length > 40) return res.status(400).json({ error: `${field} filter is too long.` });
        filters.push(`${field} eq ${odataString(value)}`);
      }
    }

    const parsedTop = Number.parseInt(String(req.query.top ?? '10'), 10);
    const top = Number.isFinite(parsedTop) ? Math.max(1, Math.min(100, parsedTop)) : 10;
    const params = {
      'sap-client': config.client,
      '$format': 'json',
      '$top': top,
      '$select': ORDER_SELECT,
    };
    if (filters.length) params['$filter'] = filters.join(' and ');

    const response = await sap.get(`${config.serviceRoot}/A_SalesOrder`, {
      params,
      headers: { Accept: 'application/json' },
    });

    res.json({ value: response.data?.d?.results || [] });
  } catch (error) {
    sendApiError(res, error);
  }
});

// GET /api/sales-orders/:salesOrder — header and item data for VA02.
router.get('/:salesOrder', async (req, res) => {
  try {
    const salesOrder = validateSalesOrderId(req.params.salesOrder);
    const config = getConfig();
    const sap = makeSapClient(config);
    const [headerResponse, itemsResponse] = await Promise.all([
      sap.get(`${config.serviceRoot}/A_SalesOrder('${salesOrder}')`, {
        params: {
          'sap-client': config.client,
          '$format': 'json',
          '$select': `${ORDER_SELECT},PurchaseOrderByCustomer`,
        },
        headers: { Accept: 'application/json' },
      }),
      sap.get(`${config.serviceRoot}/A_SalesOrderItem`, {
        params: {
          'sap-client': config.client,
          '$format': 'json',
          '$filter': `SalesOrder eq ${odataString(salesOrder)}`,
          '$select': ORDER_ITEM_SELECT,
          '$top': 100,
        },
        headers: { Accept: 'application/json' },
      }),
    ]);
    const order = headerResponse.data?.d;
    if (!order) return res.status(404).json({ error: 'Sales Order was not found in SAP.' });
    return res.json({
      order,
      items: itemsResponse.data?.d?.results || [],
      etag: headerResponse.headers.etag || order.__metadata?.etag || null,
    });
  } catch (error) {
    if (error.message?.startsWith('Sales Order must')) {
      return res.status(400).json({ error: 'Invalid Sales Order.', details: error.message });
    }
    return sendApiError(res, error);
  }
});

// POST /api/sales-orders — creates a real SAP sales order.
// Never automatically retry this POST: a network error can occur after SAP created it.
router.post('/', async (req, res) => {
  let payload;
  try {
    payload = buildOrderPayload(req.body || {});
  } catch (error) {
    return res.status(400).json({ error: 'Invalid sales order input.', details: error.message });
  }

  try {
    const config = getConfig();
    const { sap, token, cookie } = await fetchCsrfSession(config);

    const response = await sap.post(`${config.serviceRoot}/A_SalesOrder`, payload, {
      params: { 'sap-client': config.client },
      headers: {
        'X-CSRF-Token': token,
        Cookie: cookie,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });

    const created = response.data?.d || response.data || {};
    const location = response.headers.location || '';
    const locationMatch = location.match(/SalesOrder='([^']+)'/i);
    const salesOrder = created.SalesOrder || locationMatch?.[1] || null;

    return res.status(201).json({
      message: 'SAP accepted the Sales Order creation request.',
      salesOrder,
      customerReference: payload.PurchaseOrderByCustomer || null,
      status: response.status,
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

// PATCH /api/sales-orders/:salesOrder — update the customer reference on the header.
router.patch('/:salesOrder', async (req, res) => {
  let salesOrder;
  let customerReference;
  try {
    salesOrder = validateSalesOrderId(req.params.salesOrder);
    customerReference = cleanText(req.body?.PurchaseOrderByCustomer, 'PurchaseOrderByCustomer', 35);
    if (customerReference === undefined) throw new Error('PurchaseOrderByCustomer is required.');
  } catch (error) {
    return res.status(400).json({ error: 'Invalid sales order change.', details: error.message });
  }

  try {
    const config = getConfig();
    const { sap, token, cookie } = await fetchCsrfSession(config);
    const response = await sap.patch(
      `${config.serviceRoot}/A_SalesOrder('${salesOrder}')`,
      { PurchaseOrderByCustomer: customerReference },
      {
        params: { 'sap-client': config.client },
        headers: {
          'X-CSRF-Token': token,
          Cookie: cookie,
          'If-Match': '*',
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      }
    );
    return res.json({ success: true, salesOrder, status: response.status });
  } catch (error) {
    return sendApiError(res, error);
  }
});

// PATCH /api/sales-orders/:salesOrder/items/:item — update one item's quantity.
router.patch('/:salesOrder/items/:item', async (req, res) => {
  let salesOrder;
  let item;
  const quantity = Number(req.body?.RequestedQuantity);
  try {
    salesOrder = validateSalesOrderId(req.params.salesOrder);
    item = validateSalesOrderItemId(req.params.item);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000000000) {
      throw new Error('RequestedQuantity must be a number greater than zero.');
    }
  } catch (error) {
    return res.status(400).json({ error: 'Invalid sales order item change.', details: error.message });
  }

  try {
    const config = getConfig();
    const { sap, token, cookie } = await fetchCsrfSession(config);
    const response = await sap.patch(
      `${config.serviceRoot}/A_SalesOrderItem(SalesOrder='${salesOrder}',SalesOrderItem='${item}')`,
      { RequestedQuantity: String(quantity) },
      {
        params: { 'sap-client': config.client },
        headers: {
          'X-CSRF-Token': token,
          Cookie: cookie,
          'If-Match': '*',
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      }
    );
    return res.json({ success: true, salesOrder, item, status: response.status });
  } catch (error) {
    return sendApiError(res, error);
  }
});

module.exports = router;
