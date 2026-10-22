const express = require("express");
const path = require("path");
const axios = require("axios");
const https = require("https");
const fs = require("fs");
const tls = require("tls");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const demoMode = String(process.env.DEMO_MODE || "false").toLowerCase() === "true";
const chatbotHostPort = process.env.CHATBOT_HOSTPORT;
const CHATBOT_API_URL =
    process.env.CHATBOT_API_URL ||
    (chatbotHostPort
        ? `http://${chatbotHostPort}/api/chat`
        : "http://127.0.0.1:8000/api/chat");
const dashboardUsername = process.env.DASHBOARD_USERNAME || "";
const dashboardPassword = process.env.DASHBOARD_PASSWORD || "";
const verifySapTls =
    String(process.env.SAP_TLS_REJECT_UNAUTHORIZED || "true").toLowerCase() !== "false";
const sapCaConfig = process.env.SAP_CA_CERT;
const sapTlsServername = process.env.SAP_TLS_SERVERNAME || undefined;
let systemCa = [];
if (typeof tls.getCACertificates === "function") {
    try {
        systemCa = tls.getCACertificates("system");
    } catch (_) {
        // Older Node versions and some platforms may not expose the OS trust store.
    }
}
let sapCa = [...tls.rootCertificates, ...systemCa];
if (sapCaConfig) {
    const configuredCa = String(sapCaConfig).trim();
    if (configuredCa.includes("-----BEGIN CERTIFICATE-----")) {
        sapCa.push(configuredCa.replace(/\\n/g, "\n"));
    } else {
        try {
            sapCa.push(fs.readFileSync(path.resolve(__dirname, "..", configuredCa), "utf8"));
        } catch (error) {
            throw new Error(`Unable to read SAP_CA_CERT as PEM content or a file path: ${error.message}`);
        }
    }
}
const sapHttpsAgent = new https.Agent({
    rejectUnauthorized: verifySapTls,
    ca: sapCa,
    ...(sapTlsServername ? { servername: sapTlsServername } : {})
});

function sapProxyConfig() {
    const value = process.env.SAP_HTTP_PROXY;
    if (!value) return false;
    const proxy = new URL(value);
    if (!["http:", "https:"].includes(proxy.protocol)) {
        throw new Error("SAP_HTTP_PROXY must use HTTP or HTTPS.");
    }
    const auth = proxy.username || proxy.password
        ? {
            username: decodeURIComponent(proxy.username),
            password: decodeURIComponent(proxy.password)
        }
        : undefined;
    return {
        protocol: proxy.protocol,
        host: proxy.hostname,
        port: Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80)),
        ...(auth ? { auth } : {})
    };
}

const sapAxiosProxy = sapProxyConfig();

function sapConnectionError(error) {
    if (error?.code === "ERR_TLS_CERT_ALTNAME_INVALID") {
        return new Error(`The SAP certificate name does not match SAP_BASE_URL. Configure the DNS name covered by the certificate, or ask SAP Basis to issue a certificate whose Subject Alternative Name covers the configured endpoint.`);
    }
    if (["SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"].includes(error?.code)) {
        return new Error("SAP's certificate chain is not trusted by Node.js or the operating system certificate store. Ask SAP Basis for the approved root/intermediate CA certificate in PEM format, confirm its Subject Alternative Name covers SAP_BASE_URL, then configure SAP_CA_CERT and keep SAP_TLS_REJECT_UNAUTHORIZED=true. The SAP agent already checks the OS trust store.");
    }
    const endpoint = (() => {
        try {
            const url = new URL(sapBaseUrl());
            return `${url.hostname}:${url.port || 443}`;
        } catch (_) {
            return "the configured SAP endpoint";
        }
    })();
    if (error?.code === "ECONNREFUSED") {
        return new Error(`The SAP endpoint ${endpoint} refused the connection. Verify SAP_BASE_URL, SAP service port, and network/VPN access. SAP API calls bypass machine proxy settings; use SAP_HTTP_PROXY for API traffic when required. The WebGUI stream connects directly.`);
    }
    if (["ETIMEDOUT", "ECONNABORTED"].includes(error?.code)) {
        return new Error(`Connection to SAP at ${endpoint} timed out. Check network/VPN access and the SAP service port.`);
    }
    if (["ENOTFOUND", "EAI_AGAIN"].includes(error?.code)) {
        return new Error(`Could not resolve the SAP host in ${endpoint}. Check SAP_BASE_URL and DNS/VPN access.`);
    }
    return error;
}

function isLoopbackHost(host) {
    return ["localhost", "127.0.0.1", "::1"].includes(
        String(host).toLowerCase()
    );
}

function validateRuntimeConfig() {
    const hasUsername = Boolean(dashboardUsername);
    const hasPassword = Boolean(dashboardPassword);

    if (hasUsername !== hasPassword) {
        throw new Error("Set both DASHBOARD_USERNAME and DASHBOARD_PASSWORD.");
    }

    if (!isLoopbackHost(HOST) && !hasUsername) {
        throw new Error(
            "A non-local HOST requires DASHBOARD_USERNAME and DASHBOARD_PASSWORD."
        );
    }

    if (process.env.NODE_ENV === "production") {
        requireSapConfig();
        if (!hasUsername) {
            throw new Error("Production requires dashboard authentication credentials.");
        }
        if (!verifySapTls) {
            throw new Error(
                "Production requires SAP TLS verification. Configure the SAP CA certificate instead of disabling verification."
            );
        }
    }
}

function safeCredentialEquals(actual, expected) {
    const actualDigest = crypto.createHash("sha256").update(actual).digest();
    const expectedDigest = crypto.createHash("sha256").update(expected).digest();
    return crypto.timingSafeEqual(actualDigest, expectedDigest);
}

function authenticateDashboard(req, res, next) {
    if (!dashboardUsername || req.path === "/api/health") {
        return next();
    }

    const authorization = String(req.headers.authorization || "");
    const match = authorization.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
    if (!match) {
        res.setHeader("WWW-Authenticate", 'Basic realm="SAP Workbench", charset="UTF-8"');
        return res.status(401).send("Authentication required.");
    }

    let credentials;
    try {
        credentials = Buffer.from(match[1], "base64").toString("utf8");
    } catch (_) {
        credentials = "";
    }

    const separator = credentials.indexOf(":");
    const username = separator < 0 ? "" : credentials.slice(0, separator);
    const password = separator < 0 ? "" : credentials.slice(separator + 1);
    // Compare both fields on every attempt so a bad username does not skip
    // the password comparison and reveal which half of the credential matched.
    const usernameMatches = safeCredentialEquals(username, dashboardUsername);
    const passwordMatches = safeCredentialEquals(password, dashboardPassword);
    const valid = usernameMatches && passwordMatches;

    if (!valid) {
        res.setHeader("WWW-Authenticate", 'Basic realm="SAP Workbench", charset="UTF-8"');
        return res.status(401).send("Authentication required.");
    }

    return next();
}

function requireSapConfig() {
    const required = ["SAP_BASE_URL", "SAP_CLIENT", "SAP_USERNAME", "SAP_PASSWORD"];
    const missing = required.filter(k => !process.env[k]);
    if (missing.length) {
        throw new Error(`SAP configuration missing in .env: ${missing.join(", ")}`);
    }

    let baseUrl;
    try {
        baseUrl = new URL(process.env.SAP_BASE_URL);
    } catch (_) {
        throw new Error("SAP_BASE_URL must be a valid HTTPS URL.");
    }
    if (baseUrl.protocol !== "https:") {
        throw new Error("SAP_BASE_URL must use HTTPS.");
    }
}

function sapBaseUrl() {
    return String(process.env.SAP_BASE_URL || "").replace(/\/+$/, "");
}

function jsonError(res, status, error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(status).json({ success: false, message });
}

function escapeXml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function decodeXml(value) {
    return String(value ?? "")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}

function xmlAttribute(text, name) {
    const re = new RegExp(
        `${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}="([^"]*)"`,
        "i"
    );
    const m = String(text || "").match(re);
    return m ? decodeXml(m[1]) : "";
}

function xmlValue(text, names) {
    const list = Array.isArray(names) ? names : [names];
    for (const name of list) {
        const re = new RegExp(
            `<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`,
            "i"
        );
        const m = String(text || "").match(re);
        if (m) return decodeXml(m[1].trim());
    }
    return "";
}

function sapErrorMessage(body) {
    const text = String(body ?? "");
    if (!text) return "Unknown SAP error";

    const candidates = [
        /<message\b[^>]*>([\s\S]*?)<\/message>/i,
        /<errordetail\b[^>]*>[\s\S]*?<message\b[^>]*>([\s\S]*?)<\/message>/i,
        /<[^>]*ExceptionText[^>]*>([\s\S]*?)<\/[^>]*ExceptionText>/i,
        /<[^>]*shortText[^>]*>([\s\S]*?)<\/[^>]*shortText>/i
    ];

    for (const re of candidates) {
        const m = text.match(re);
        if (m) return decodeXml(m[1]).replace(/\s+/g, " ").trim().slice(0, 1200);
    }

    return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
}

function sapWebGuiErrorMessage(body) {
    const message = sapErrorMessage(body);
    if (/Cannot GET\s+\/sap\/bc\/gui\/sap\/its\/webgui/i.test(message)) {
        return "SAP GUI for HTML is not available at this endpoint. Ask your SAP administrator to activate /sap/bc/gui/sap/its/webgui in SICF and confirm your user has access.";
    }
    return message;
}


// ======================================================
// SAP HTTP SESSION
// ======================================================

class SapSession {
    constructor() {
        if (demoMode) throw new Error("Live SAP requests are disabled while the workbench is in demo mode.");
        requireSapConfig();
        this.cookies = new Map();
        this.csrfToken = null;
        this.agent = sapHttpsAgent;
    }

    cookieHeader() {
        return [...this.cookies.entries()]
            .map(([k, v]) => `${k}=${v}`)
            .join("; ");
    }

    captureCookies(response) {
        const values = response.headers["set-cookie"] || [];
        for (const cookie of values) {
            const first = cookie.split(";")[0];
            const i = first.indexOf("=");
            if (i > 0) {
                this.cookies.set(
                    first.slice(0, i).trim(),
                    first.slice(i + 1).trim()
                );
            }
        }
    }

    buildUrl(pathname, query = {}) {
        const url = new URL(`${sapBaseUrl()}${pathname}`);

        if (!url.searchParams.has("sap-client")) {
            url.searchParams.set("sap-client", process.env.SAP_CLIENT);
        }

        for (const [key, value] of Object.entries(query || {})) {
            if (value === undefined || value === null) continue;
            // The ABAP source update endpoint expects corrNr to be present,
            // even when SAP has not assigned a transport (empty value).
            if (String(value) === "" && key !== "corrNr") continue;
            url.searchParams.set(key, String(value));
        }

        return url.toString();
    }

    async send(method, pathname, options = {}) {
        const {
            query = {},
            data,
            headers = {},
            accept = "*/*"
        } = options;

        const finalHeaders = {
            Accept: accept,
            ...headers
        };

        if (this.cookies.size) {
            finalHeaders.Cookie = this.cookieHeader();
        }

        if (
            this.csrfToken &&
            ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())
        ) {
            finalHeaders["X-CSRF-Token"] = this.csrfToken;
        }

        const response = await axios({
            method,
            url: this.buildUrl(pathname, query),
            auth: {
                username: process.env.SAP_USERNAME,
                password: process.env.SAP_PASSWORD
            },
            // Do not inherit machine-wide proxy variables (often stale local
            // development proxies). Configure SAP_HTTP_PROXY explicitly when needed.
            proxy: sapAxiosProxy,
            headers: finalHeaders,
            data,
            httpsAgent: this.agent,
            timeout: 60000,
            responseType: "text",
            transformResponse: [value => value],
            validateStatus: () => true
        });

        this.captureCookies(response);
        return response;
    }

    async fetchCsrf() {
        const response = await this.send(
            "GET",
            "/sap/bc/adt/discovery",
            {
                headers: {
                    "X-CSRF-Token": "Fetch"
                },
                accept: "application/atomsvc+xml"
            }
        );

        const token = response.headers["x-csrf-token"];

        if (
            response.status < 200 ||
            response.status >= 300 ||
            !token ||
            String(token).toLowerCase() === "required"
        ) {
            throw new Error(
                `SAP CSRF request failed (HTTP ${response.status}): ${sapErrorMessage(response.data)}`
            );
        }

        this.csrfToken = token;
        return token;
    }

    async request(method, pathname, options = {}) {
        const write = ["POST", "PUT", "PATCH", "DELETE"].includes(
            method.toUpperCase()
        );

        if (write && !this.csrfToken) {
            await this.fetchCsrf();
        }

        let response = await this.send(method, pathname, options);

        if (
            response.status === 403 &&
            String(response.headers["x-csrf-token"] || "").toLowerCase() === "required"
        ) {
            this.csrfToken = null;
            await this.fetchCsrf();
            response = await this.send(method, pathname, options);
        }

        return response;
    }
}


// ======================================================
// VALIDATION / WILDCARDS
// ======================================================

function validateProgramName(value) {
    const name = String(value || "").trim().toUpperCase();
    if (!name) throw new Error("Program name is required.");
    if (name.length > 60 || !/^[A-Z0-9_\/]+$/.test(name)) {
        throw new Error("Invalid program name.");
    }
    return name;
}

function validateCustomProgramName(value) {
    const name = validateProgramName(value);

    if (
        !name.startsWith("Z") &&
        !name.startsWith("Y") &&
        !name.startsWith("/")
    ) {
        throw new Error(
            "Creation is allowed only for customer programs beginning with Z, Y or a namespace."
        );
    }

    return name;
}

function validatePackageName(value) {
    const name = String(value || "").trim().toUpperCase();

    if (!name) throw new Error("Package is required.");

    if (
        name !== "$TMP" &&
        (name.length > 30 || !/^[A-Z0-9_\/$]+$/.test(name))
    ) {
        throw new Error("Invalid package name.");
    }

    return name;
}

function validateTransport(value) {
    const tr = String(value || "").trim().toUpperCase();
    if (!tr) return "";

    // Accept both normal Workbench requests and common task identifiers.
    if (!/^[A-Z0-9]{3}[A-Z0-9]\d{6}(?:T)?$/.test(tr)) {
        throw new Error("Invalid transport request number.");
    }

    return tr;
}

function normalizeWildcardPattern(value) {
    const raw = String(value ?? "").trim().toUpperCase();
    return raw || "*";
}

function wildcardPatternToRegex(value) {
    let pattern = normalizeWildcardPattern(value).replace(/\*+/g, "*");

    if (!pattern.includes("*") && !pattern.includes("?")) {
        pattern = `*${pattern}*`;
    }

    let source = "^";

    for (const ch of pattern) {
        if (ch === "*") source += ".*";
        else if (ch === "?") source += ".";
        else source += ch.replace(/[\\^$+.[\]{}()|]/g, "\\$&");
    }

    source += "$";
    return new RegExp(source, "i");
}

function wildcardMatch(value, pattern) {
    return wildcardPatternToRegex(pattern).test(
        String(value ?? "").trim().toUpperCase()
    );
}

function wildcardMatchIdentifier(value, pattern) {
    const text = String(value ?? "").trim().toUpperCase();
    const p = normalizeWildcardPattern(pattern);

    if (wildcardMatch(text, p)) return true;

    return wildcardMatch(
        text.replace(/\s+/g, ""),
        p.replace(/\s+/g, "")
    );
}


// ======================================================
// ADT HELPERS
// ======================================================

function programUri(name) {
    return `/sap/bc/adt/programs/programs/${encodeURIComponent(
        name.toLowerCase()
    )}`;
}

function programSourceUri(name) {
    return `${programUri(name)}/source/main`;
}

function parseAdtObjects(xml) {
    const text = String(xml || "");
    const results = [];

    for (const m of text.matchAll(
        /<[^>]*objectReference\b([^>]*)\/?>(?:<\/[^>]*objectReference>)?/gi
    )) {
        const attrs = m[1] || "";

        results.push({
            name: xmlAttribute(attrs, "adtcore:name"),
            type: xmlAttribute(attrs, "adtcore:type"),
            uri: xmlAttribute(attrs, "adtcore:uri"),
            description: xmlAttribute(attrs, "adtcore:description"),
            packageName:
                xmlAttribute(attrs, "adtcore:packageName") ||
                xmlAttribute(attrs, "packageName") ||
                xmlAttribute(attrs, "adtcore:package") ||
                xmlAttribute(attrs, "package")
        });
    }

    if (!results.length) {
        for (const m of text.matchAll(
            /<SEU_ADT_REPOSITORY_OBJ_NODE>([\s\S]*?)<\/SEU_ADT_REPOSITORY_OBJ_NODE>/gi
        )) {
            const block = m[1];

            results.push({
                name: xmlValue(block, "OBJECT_NAME"),
                type: xmlValue(block, "OBJECT_TYPE"),
                uri: "",
                description: xmlValue(block, "DESCRIPTION"),
                packageName: xmlValue(block, [
                    "PACKAGE_NAME",
                    "PACKAGE"
                ])
            });
        }
    }

    const seen = new Set();

    return results.filter(item => {
        const name = String(item.name || "").trim();
        const key =
            `${String(item.type || "").toUpperCase()}|${name.toUpperCase()}`;

        if (!name || seen.has(key)) return false;

        seen.add(key);
        return true;
    });
}

const DDIC_TYPES = {
    TABLE: "TABL/DT",
    STRUCTURE: "TABL/DS",
    DOMAIN: "DOMA/DD",
    DATA_ELEMENT: "DTEL/DE",
    TABLE_TYPE: "TTYP/TT",
    VIEW: "VIEW",
    LOCK_OBJECT: "ENQU",
    SEARCH_HELP: "SHLP"
};

function ddicLabel(type) {
    return ({
        TABLE: "Database Table",
        STRUCTURE: "Structure",
        DOMAIN: "Domain",
        DATA_ELEMENT: "Data Element",
        TABLE_TYPE: "Table Type",
        VIEW: "View",
        LOCK_OBJECT: "Lock Object",
        SEARCH_HELP: "Search Help"
    })[type] || type;
}


// ======================================================
// REQUEST BODY PARSERS
// WebGUI proxy first; JSON/urlencoded parsers second;
// all POST API routes follow these middleware definitions.
// ======================================================

// IMPORTANT: proxy first.
// ======================================================

const frontendPath =
    path.join(
        __dirname,
        "..",
        "frontend"
    );

app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (req.path.startsWith("/api/")) {
        res.setHeader("Cache-Control", "no-store");
    }
    next();
});

app.use(authenticateDashboard);

app.use((req, res, next) => {
    if (
        !["POST", "PUT", "PATCH", "DELETE"].includes(req.method)
    ) {
        return next();
    }

    let originHost;
    try {
        originHost = new URL(req.get("origin") || "").host;
    } catch (_) {
        return jsonError(res, 403, "A valid same-origin request is required.");
    }

    if (originHost !== String(req.get("host") || "").toLowerCase()) {
        return jsonError(res, 403, "Cross-origin write requests are not allowed.");
    }

    return next();
});

// Sessionized WebGUI root: /sap(<session>)/...
const sapProxyMatcher =
    /^\/sap(?:\([^)]*\))?(?:\/|$)/;

// VERY IMPORTANT: WebGUI POST bodies must stream untouched to SAP.
// Therefore proxy is registered before express.json / urlencoded.
app.use((req, res, next) => {
    // Express 5's router can treat RegExp mount paths differently across
    // versions. Match the SAP path explicitly so WebGUI and ADT traffic are
    // always proxied before static-file handling and body parsing.
    if (sapProxyMatcher.test(String(req.path || ""))) {
        return proxySapRequest(req, res);
    }
    return next();
});
app.use('/api/sales-orders', require('./sales-orders'));
app.use(
    express.json({
        limit: "15mb"
    })
);

app.use(
    express.urlencoded({
        extended: true,
        limit: "10mb"
    })
);

// ======================================================
// HEALTH
// ======================================================

app.get("/api/health", (req, res) => {
    res.json({
        success: true,
        message: "Node.js SAP Web Development Workbench is running",
        mode: demoMode ? "demo" : "live"
    });
});

app.post("/api/chat", async (req, res) => {
    const prompt = String(req.body?.prompt || "").trim();
    if (!prompt) {
        return jsonError(res, 400, "Prompt is required.");
    }
    if (prompt.length > 8000) {
        return jsonError(res, 413, "Prompt must be 8,000 characters or fewer.");
    }

    const rawContext = req.body?.context;
    const contextLimits = {
        workspace: 80,
        program: 30,
        package: 30,
        command: 80,
        dictionaryType: 30,
        dictionaryObject: 30
    };
    const context = rawContext && typeof rawContext === "object" && !Array.isArray(rawContext)
        ? Object.fromEntries(
            Object.entries(contextLimits)
                .filter(([key]) => typeof rawContext[key] === "string")
                .map(([key, limit]) => [key, rawContext[key].trim().slice(0, limit)])
        )
        : {};

    try {
        const response = await axios.post(
            CHATBOT_API_URL,
            {
                prompt,
                context,
                history: Array.isArray(req.body?.history) ? req.body.history.slice(-12) : [],
                attachments: Array.isArray(req.body?.attachments) ? req.body.attachments.slice(0, 5) : []
            },
            { timeout: 120000, maxBodyLength: 15 * 1024 * 1024, headers: { Accept: "application/json" } }
        );
        const answer = response.data?.answer;
        if (typeof answer !== "string" || !answer.trim()) {
            return jsonError(res, 502, "Chatbot returned an invalid response.");
        }
        const memoriesUsed = Number(response.data?.memories_used);
        const model = typeof response.data?.model === "string"
            ? response.data.model.slice(0, 80)
            : null;
        return res.json({
            answer: answer.trim(),
            memories_used: Number.isInteger(memoriesUsed) && memoriesUsed > 0
                ? memoriesUsed
                : 0,
            model
        });
    } catch (error) {
        const downstreamMessage = String(error?.response?.data?.detail || error?.response?.data?.message || "").trim();
        return jsonError(
            res,
            error?.response?.status || 503,
            downstreamMessage.slice(0, 600) || "Chatbot service is unavailable. Check the chatbot service configuration."
        );
    }
});


// ======================================================
// SAP ODATA CONNECTION TEST
// ======================================================

app.get("/api/sap-test", async (req, res) => {
    try {
        requireSapConfig();

        const url =
            `${sapBaseUrl()}/sap/opu/odata/sap/API_BUSINESS_PARTNER/` +
            `A_BusinessPartner?$top=1&$format=json&sap-client=` +
            encodeURIComponent(process.env.SAP_CLIENT);

        const response = await axios.get(url, {
            auth: {
                username: process.env.SAP_USERNAME,
                password: process.env.SAP_PASSWORD
            },
            httpsAgent: sapHttpsAgent,
            timeout: 30000
        });

        return res.json({
            success: true,
            status: response.status,
            message: "SAP OData connection successful",
            data: response.data
        });

    } catch (error) {
        return jsonError(
            res,
            error.response?.status || 500,
            error.response?.data || error.message
        );
    }
});


// ======================================================
// SE38 — READ PROGRAM SOURCE
// ======================================================

app.get("/api/adt/program/:name", async (req, res) => {
    try {
        const name = validateProgramName(req.params.name);
        const session = new SapSession();

        const response = await session.request(
            "GET",
            programSourceUri(name),
            {
                accept: "text/plain"
            }
        );

        if (response.status < 200 || response.status >= 300) {
            return jsonError(
                res,
                response.status,
                `SAP could not read program ${name}: ${sapErrorMessage(response.data)}`
            );
        }

        // The source endpoint does not include the package or program type.
        // Fetch the ADT object descriptor so Change and Run can retain the
        // correct repository context and only offer execution for reports.
        const descriptor = await session.request(
            "GET",
            programUri(name),
            { accept: "application/xml, application/*+xml, */*" }
        );
        const descriptorXml = descriptor.status >= 200 && descriptor.status < 300
            ? String(descriptor.data || "")
            : "";
        const rootAttrs = descriptorXml.match(/<[^>]*abapProgram\b([^>]*)>/i)?.[1] || "";
        const packageAttrs = descriptorXml.match(/<[^>]*packageRef\b([^>]*)\/?\s*>/i)?.[1] || "";

        return res.json({
            success: true,
            name,
            metadata: {
                name,
                description: xmlAttribute(rootAttrs, "adtcore:description") || xmlAttribute(rootAttrs, "description"),
                package: xmlAttribute(packageAttrs, "adtcore:name") || xmlAttribute(packageAttrs, "name"),
                programType: xmlAttribute(rootAttrs, "program:programType") || xmlAttribute(rootAttrs, "programType")
            },
            source: String(response.data || "")
        });

    } catch (error) {
        return jsonError(res, 500, error);
    }
});


// ======================================================
// SE11 — REAL DDIC SEARCH
// ======================================================

app.get("/api/adt/ddic/search", async (req, res) => {
    try {
        const type = String(req.query.type || "TABLE").trim().toUpperCase();
        const objectType = DDIC_TYPES[type];

        if (!objectType) {
            return jsonError(
                res,
                400,
                `Unsupported SE11 object type: ${type}`
            );
        }

        const pattern = normalizeWildcardPattern(req.query.q);
        const maxResults = Math.min(
            Math.max(Number(req.query.maxResults) || 200, 1),
            1000
        );

        const session = new SapSession();

        const sapQuery =
            pattern.startsWith("*") ? "*" : pattern;

        let response = await session.request(
            "GET",
            "/sap/bc/adt/repository/informationsystem/search",
            {
                query: {
                    operation: "quickSearch",
                    query: sapQuery,
                    objectType,
                    maxResults,
                    noDescription: "false"
                },
                accept: "application/xml, application/atom+xml, */*"
            }
        );

        if (response.status >= 400) {
            response = await session.request(
                "GET",
                "/sap/bc/adt/repository/informationsystem/search",
                {
                    query: {
                        query: sapQuery,
                        objectType,
                        maxResults,
                        noDescription: "false"
                    },
                    accept: "application/xml, application/atom+xml, */*"
                }
            );
        }

        if (response.status < 200 || response.status >= 300) {
            return jsonError(
                res,
                response.status,
                `SAP ${ddicLabel(type)} search failed: ${sapErrorMessage(response.data)}`
            );
        }

        const results = parseAdtObjects(response.data)
            .filter(item =>
                String(item.type || "")
                    .toUpperCase()
                    .includes(objectType.toUpperCase())
            )
            .map(item => ({
                name: String(item.name || "").toUpperCase(),
                description: String(item.description || ""),
                packageName: String(item.packageName || ""),
                uri: String(item.uri || ""),
                objectType
            }))
            .filter(item =>
                wildcardMatchIdentifier(item.name, pattern) ||
                wildcardMatch(item.description, pattern)
            )
            .slice(0, maxResults);

        return res.json({
            success: true,
            objectCategory: type,
            objectType,
            pattern,
            count: results.length,
            results
        });

    } catch (error) {
        return jsonError(res, 500, error);
    }
});


// ======================================================
// PACKAGE F4 / VALIDATION
// ======================================================

app.get("/api/adt/packages/search", async (req, res) => {
    try {
        const pattern = normalizeWildcardPattern(req.query.q);
        const maxResults = Math.min(
            Math.max(Number(req.query.maxResults) || 500, 1),
            1000
        );

        const session = new SapSession();

        const response = await session.request(
            "GET",
            "/sap/bc/adt/repository/informationsystem/search",
            {
                query: {
                    operation: "quickSearch",
                    query: pattern.startsWith("*") ? "*" : pattern,
                    objectType: "DEVC/K",
                    maxResults,
                    noDescription: "false"
                },
                accept: "application/xml, application/atom+xml, */*"
            }
        );

        if (response.status < 200 || response.status >= 300) {
            return jsonError(
                res,
                response.status,
                `SAP package search failed: ${sapErrorMessage(response.data)}`
            );
        }

        const packages = parseAdtObjects(response.data)
            .filter(item =>
                String(item.type || "")
                    .toUpperCase()
                    .includes("DEVC/K")
            )
            .map(item => ({
                name: String(item.name || "").toUpperCase(),
                description: String(item.description || ""),
                uri: String(item.uri || "")
            }))
            .filter(item =>
                wildcardMatchIdentifier(item.name, pattern) ||
                wildcardMatch(item.description, pattern)
            )
            .slice(0, maxResults);

        return res.json({
            success: true,
            pattern,
            count: packages.length,
            packages
        });

    } catch (error) {
        return jsonError(res, 500, error);
    }
});

app.get("/api/adt/package/:name", async (req, res) => {
    try {
        const packageName = validatePackageName(req.params.name);

        if (packageName === "$TMP") {
            return res.json({
                success: true,
                name: "$TMP",
                description: "Local package"
            });
        }

        const session = new SapSession();

        let response = await session.request(
            "GET",
            "/sap/bc/adt/repository/informationsystem/search",
            {
                query: {
                    operation: "quickSearch",
                    query: packageName,
                    objectType: "DEVC/K",
                    maxResults: 20,
                    noDescription: "false"
                },
                accept: "application/xml, application/atom+xml, */*"
            }
        );

        if (response.status >= 400) {
            response = await session.request(
                "GET",
                "/sap/bc/adt/repository/informationsystem/search",
                {
                    query: {
                        query: packageName,
                        objectType: "DEVC/K",
                        maxResults: 20,
                        noDescription: "false"
                    },
                    accept: "application/xml, application/atom+xml, */*"
                }
            );
        }

        if (response.status < 200 || response.status >= 300) {
            return jsonError(
                res,
                response.status,
                `Package ${packageName} validation failed: ${sapErrorMessage(response.data)}`
            );
        }

        const exact = parseAdtObjects(response.data).find(item =>
            String(item.name || "").toUpperCase() === packageName &&
            String(item.type || "").toUpperCase().includes("DEVC/K")
        );

        if (!exact) {
            return jsonError(
                res,
                404,
                `Package ${packageName} was not found or is not accessible to the current SAP user.`
            );
        }

        return res.json({
            success: true,
            name: packageName,
            description: exact.description || "",
            uri: exact.uri || "",
            source: "ADT repository quickSearch"
        });

    } catch (error) {
        return jsonError(res, 500, error);
    }
});


// ======================================================
// TRANSPORTS — REAL CTS TREE / WILDCARDS
// ======================================================

async function readTransportTree() {
    const session = new SapSession();

    const response = await session.request(
        "GET",
        "/sap/bc/adt/cts/transportrequests",
        {
            query: {
                user: process.env.SAP_USERNAME,
                target: "true",
                requestType: "KWT",
                requestStatus: "D"
            },
            accept:
                "application/vnd.sap.adt.transportorganizertree.v1+xml"
        }
    );

    if (response.status < 200 || response.status >= 300) {
        throw new Error(sapErrorMessage(response.data));
    }

    return String(response.data || "");
}

function parseTransportTree(xml) {
    const text = String(xml || "");
    const results = [];
    const seen = new Set();

    for (const m of text.matchAll(
        /<[^>]*request\b([^>]*)>/gi
    )) {
        const attrs = m[1] || "";

        const name =
            xmlAttribute(attrs, "tm:number") ||
            xmlAttribute(attrs, "number");

        if (!name) continue;

        const id = String(name).trim().toUpperCase();

        if (seen.has(id)) continue;

        seen.add(id);

        results.push({
            name: id,
            description:
                xmlAttribute(attrs, "tm:desc") ||
                xmlAttribute(attrs, "description") ||
                "",
            owner:
                xmlAttribute(attrs, "tm:owner") ||
                xmlAttribute(attrs, "owner") ||
                "",
            status:
                xmlAttribute(attrs, "tm:status") ||
                xmlAttribute(attrs, "status") ||
                "",
            type:
                xmlAttribute(attrs, "tm:type") ||
                xmlAttribute(attrs, "type") ||
                ""
        });
    }

    if (!results.length) {
        for (const id of (
            text.match(/[A-Z0-9]{3}[A-Z0-9]\d{6}/gi) || []
        )) {
            const upper = id.toUpperCase();
            if (!seen.has(upper)) {
                seen.add(upper);
                results.push({
                    name: upper,
                    description: "",
                    owner: "",
                    status: "",
                    type: ""
                });
            }
        }
    }

    return results;
}

app.get("/api/adt/transports", async (req, res) => {
    try {
        const pattern = normalizeWildcardPattern(req.query.q);
        const tree = await readTransportTree();

        const transports = parseTransportTree(tree)
            .filter(item =>
                wildcardMatchIdentifier(item.name, pattern) ||
                wildcardMatch(item.description, pattern) ||
                wildcardMatchIdentifier(item.owner, pattern)
            );

        return res.json({
            success: true,
            pattern,
            count: transports.length,
            transports: transports.map(item => item.name),
            details: transports
        });

    } catch (error) {
        return jsonError(res, 500, error);
    }
});

app.get("/api/adt/transports/search", async (req, res) => {
    try {
        const pattern = normalizeWildcardPattern(req.query.q);
        const tree = await readTransportTree();

        const transports = parseTransportTree(tree)
            .filter(item =>
                wildcardMatchIdentifier(item.name, pattern) ||
                wildcardMatch(item.description, pattern) ||
                wildcardMatchIdentifier(item.owner, pattern)
            )
            .slice(0, 500);

        return res.json({
            success: true,
            pattern,
            count: transports.length,
            transports
        });

    } catch (error) {
        return jsonError(res, 500, error);
    }
});


// ======================================================
// CREATE TRANSPORT REQUEST
// Uses CreateCorrectionRequest, the ADT-supported CTS create schema.
// ======================================================

app.post("/api/adt/transport", async (req, res) => {
    try {
        const description =
            String(req.body?.description || req.body?.name || "").trim();

        const packageName =
            String(req.body?.package || "$TMP").trim().toUpperCase();

        if (!description) {
            return jsonError(
                res,
                400,
                "Transport description is required."
            );
        }

        const devclass =
            packageName || "$TMP";

        const body =
            `<?xml version="1.0" encoding="UTF-8"?>` +
            `<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">` +
            `<asx:values><DATA>` +
            `<DEVCLASS>${escapeXml(devclass)}</DEVCLASS>` +
            `<REQUEST_TEXT>${escapeXml(description.slice(0, 60))}</REQUEST_TEXT>` +
            `<REF/>` +
            `<OPERATION>I</OPERATION>` +
            `</DATA></asx:values></asx:abap>`;

        const session = new SapSession();

        const response = await session.request(
            "POST",
            "/sap/bc/adt/cts/transports",
            {
                headers: {
                    "Content-Type":
                        "application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.CreateCorrectionRequest"
                },
                data: body,
                accept: "text/plain"
            }
        );

        if (response.status < 200 || response.status >= 300) {
            return jsonError(
                res,
                response.status,
                `SAP transport creation failed: ${sapErrorMessage(response.data)}`
            );
        }

        const raw = String(response.data || "").trim();

        const match =
            raw.match(/[A-Z0-9]{3}[A-Z0-9]\d{6}/i);

        return res.json({
            success: true,
            transport: match ? match[0].toUpperCase() : null,
            raw
        });

    } catch (error) {
        return jsonError(res, 500, error);
    }
});


// ======================================================
// CREATE PROGRAM
// ======================================================

app.post("/api/adt/program", async (req, res) => {
    try {
        const name =
            validateCustomProgramName(req.body?.name);

        const description =
            String(req.body?.description || "").trim();

        const packageName =
            validatePackageName(req.body?.package);

        const programType =
            String(
                req.body?.programType ||
                "executableProgram"
            );

        const transport =
            validateTransport(req.body?.transport);

        const validTypes = new Set([
            "executableProgram",
            "modulePool",
            "subroutinePool",
            "functionGroup",
            "interfacePool",
            "classPool",
            "typeGroup",
            "include"
        ]);

        if (!validTypes.has(programType)) {
            return jsonError(
                res,
                400,
                "Invalid program type."
            );
        }

        if (!description) {
            return jsonError(
                res,
                400,
                "Program description is required."
            );
        }

        if (packageName !== "$TMP" && !transport) {
            return jsonError(
                res,
                400,
                "A transport request is required for a transportable package."
            );
        }

        // Check actual SAP repository first.
        const checkSession = new SapSession();

        const existing =
            await checkSession.request(
                "GET",
                programSourceUri(name),
                {
                    accept: "text/plain"
                }
            );

        if (
            existing.status >= 200 &&
            existing.status < 300
        ) {
            return jsonError(
                res,
                409,
                `Program ${name} already exists in SAP. Use Change instead.`
            );
        }

        if (
            existing.status !== 404
        ) {
            return jsonError(
                res,
                existing.status,
                `SAP could not verify program ${name}: ${sapErrorMessage(existing.data)}`
            );
        }

        const body =
            `<?xml version="1.0" encoding="UTF-8"?>` +
            `<program:abapProgram ` +
            `xmlns:program="http://www.sap.com/adt/programs/programs" ` +
            `xmlns:adtcore="http://www.sap.com/adt/core" ` +
            `adtcore:name="${escapeXml(name)}" ` +
            `adtcore:type="PROG/P" ` +
            `adtcore:description="${escapeXml(description.slice(0, 60))}" ` +
            `adtcore:responsible="${escapeXml(
                String(process.env.SAP_USERNAME).toUpperCase()
            )}" ` +
            `program:programType="${escapeXml(programType)}">` +
            `<adtcore:packageRef adtcore:name="${escapeXml(packageName)}"/>` +
            `</program:abapProgram>`;

        const contentTypes = [
            "application/vnd.sap.adt.programs.programs.v2+xml",
            "application/vnd.sap.adt.programs.programs.v1+xml",
            "application/*"
        ];

        const session = new SapSession();
        let response = null;
        let usedContentType = "";

        for (const type of contentTypes) {
            usedContentType = type;

            response = await session.request(
                "POST",
                "/sap/bc/adt/programs/programs",
                {
                    query: transport ? { corrNr: transport } : {},
                    headers: {
                        "Content-Type": type,
                        "X-sap-adt-sessiontype": "stateful"
                    },
                    data: body,
                    accept:
                        "application/vnd.sap.adt.programs.programs.v2+xml"
                }
            );

            if (
                response.status !== 415 &&
                !(
                    response.status === 400 &&
                    /ExceptionInvalidData/i.test(
                        String(response.data || "")
                    )
                )
            ) {
                break;
            }
        }

        if (!response || response.status < 200 || response.status >= 300) {
            return jsonError(
                res,
                response?.status || 500,
                `SAP program creation failed: ${sapErrorMessage(response?.data)}`
            );
        }

        return res.json({
            success: true,
            name,
            type: "PROG/P",
            package: packageName,
            transport,
            programType,
            contentType: usedContentType,
            status: "created",
            httpStatus: response.status,
            raw: String(response.data || "")
        });

    } catch (error) {
        return jsonError(res, 500, error);
    }
});


// ======================================================
// SAVE PROGRAM SOURCE
// LOCK -> PUT SOURCE -> UNLOCK
// ======================================================

app.put("/api/adt/program/:name/source", async (req, res) => {
    let name;

    try {
        name =
            validateProgramName(req.params.name);

        const source =
            typeof req.body?.source === "string"
                ? req.body.source
                : "";

        if (!source.trim()) {
            return jsonError(
                res,
                400,
                "Program source cannot be empty."
            );
        }

        const transport =
            validateTransport(req.body?.transport);

        const session =
            new SapSession();

        const uri =
            programUri(name);

        const lock =
            await session.request(
                "POST",
                uri,
                {
                    query: {
                        _action: "LOCK",
                        accessMode: "MODIFY",
                        ...(transport
                            ? { corrNr: transport }
                            : {})
                    },
                    headers: {
                        "X-sap-adt-sessiontype": "stateful"
                    },
                    accept:
                        "application/vnd.sap.as+xml;dataname=com.sap.adt.lock.Result"
                }
            );

        if (
            lock.status < 200 ||
            lock.status >= 300
        ) {
            return jsonError(
                res,
                lock.status,
                `SAP object lock failed: ${sapErrorMessage(lock.data)}`
            );
        }

        const lockMatch =
            String(lock.data || "").match(
                /<LOCK_HANDLE>([\s\S]*?)<\/LOCK_HANDLE>/i
            );

        const lockHandle =
            lockMatch
                ? lockMatch[1].trim()
                : "";

        // SAP may assign or return the transport during LOCK when the caller
        // did not supply one. The source endpoint accepts corrNr on PUT.
        const lockTransport =
            xmlValue(lock.data, ["CORRNR", "CORR_NR", "TRANSPORT"]);
        const effectiveTransport = transport || lockTransport;

        if (!lockHandle) {
            return jsonError(
                res,
                500,
                "SAP did not return a lock handle."
            );
        }

        let putResponse;

        try {
            putResponse =
                await session.request(
                    "PUT",
                    programSourceUri(name),
                    {
                        query: {
                            lockHandle,
                            corrNr: effectiveTransport
                        },
                        headers: {
                            "Content-Type":
                                "text/plain; charset=utf-8",
                            "X-sap-adt-sessiontype":
                                "stateful"
                        },
                        data: source,
                        accept: "text/plain"
                    }
                );
        } finally {
            try {
                await session.request(
                    "POST",
                    uri,
                    {
                        query: {
                            _action: "UNLOCK",
                            lockHandle
                        },
                        headers: {
                            "X-sap-adt-sessiontype":
                                "stateful"
                        }
                    }
                );
            } catch (unlockError) {
                console.error(
                    "ADT UNLOCK:",
                    unlockError.message
                );
            }
        }

        if (
            putResponse.status < 200 ||
            putResponse.status >= 300
        ) {
            return jsonError(
                res,
                putResponse.status,
                `SAP source save failed: ${sapErrorMessage(putResponse.data)}`
            );
        }

        return res.json({
            success: true,
            name,
            status: "saved",
            transport: effectiveTransport,
            httpStatus: putResponse.status
        });

    } catch (error) {
        return jsonError(res, 500, error);
    }
});


// ======================================================
// SYNTAX CHECK
// ======================================================

app.post("/api/adt/program/:name/syntax", async (req, res) => {
    try {
        const name =
            validateProgramName(req.params.name);

        const session =
            new SapSession();

        const objectUri =
            programUri(name);

        const body =
            `<?xml version="1.0" encoding="UTF-8"?>` +
            `<chkrun:checkObjectList ` +
            `xmlns:chkrun="http://www.sap.com/adt/checkrun" ` +
            `xmlns:adtcore="http://www.sap.com/adt/core">` +
            `<chkrun:checkObject ` +
            `adtcore:uri="${escapeXml(objectUri)}"/>` +
            `</chkrun:checkObjectList>`;

        const response =
            await session.request(
                "POST",
                "/sap/bc/adt/checkruns",
                {
                    query: {
                        reporters: "abapCheckRun"
                    },
                    headers: {
                        "Content-Type":
                            "application/vnd.sap.adt.checkobjects+xml"
                    },
                    data: body,
                    accept: "application/vnd.sap.adt.checkmessages+xml"
                }
            );

        if (
            response.status < 200 ||
            response.status >= 300
        ) {
            return jsonError(
                res,
                response.status,
                `SAP syntax check failed: ${sapErrorMessage(response.data)}`
            );
        }

        const raw =
            String(response.data || "");

        return res.json({
            success: true,
            name,
            status:
                /severity="E"|type="E"|severity="error"/i.test(raw)
                    ? "errors"
                    : "clean",
            raw
        });

    } catch (error) {
        return jsonError(res, 500, error);
    }
});


// ======================================================
// ACTIVATE PROGRAM
// ======================================================

app.post("/api/adt/program/:name/activate", async (req, res) => {
    try {
        const name =
            validateProgramName(req.params.name);

        const session =
            new SapSession();

        const uri = programUri(name);
        const references =
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
            "<adtcore:objectReferences xmlns:adtcore=\"http://www.sap.com/adt/core\">" +
            "<adtcore:objectReference adtcore:uri=\"" + escapeXml(uri) +
            "\" adtcore:name=\"" + escapeXml(name) + "\"/>" +
            "</adtcore:objectReferences>";

        const activate = (body, preauditRequested) =>
            session.request(
                "POST",
                "/sap/bc/adt/activation",
                {
                    query: {
                        method: "activate",
                        preauditRequested: String(preauditRequested)
                    },
                    headers: {
                        "Content-Type": "application/xml; charset=UTF-8",
                        "X-sap-adt-sessiontype": "stateful"
                    },
                    data: body,
                    accept: "application/xml, application/*+xml, */*"
                }
            );

        const hasErrors = raw =>
            /(?:severity|type)=["'](?:E|ERROR|FATAL)["']/i.test(String(raw || "")) ||
            /<(?:[\w.-]+:)?error\b/i.test(String(raw || ""));

        const activationError = raw => {
            const match = String(raw || "").match(
                /<(?:[\w.-]+:)?(?:shortText|message|text)\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?(?:shortText|message|text)>/i
            );
            const detail = match
                ? decodeXml(match[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()
                : "";
            return detail || sapErrorMessage(raw);
        };

        const preaudit = await activate(references, true);
        if (preaudit.status < 200 || preaudit.status >= 300) {
            return jsonError(
                res,
                preaudit.status,
                "SAP activation check failed: " + sapErrorMessage(preaudit.data)
            );
        }

        const preauditRaw = String(preaudit.data || "");
        if (hasErrors(preauditRaw)) {
            return jsonError(
                res,
                422,
                "SAP rejected activation checks: " + activationError(preauditRaw)
            );
        }

        const returnedReferences = preauditRaw.match(
            /<(?:[\w.-]+:)?objectReferences\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?objectReferences>/i
        )?.[0];
        let activationRaw = preauditRaw;
        let activationStatus = preaudit.status;
        let executed = /activationExecuted=["']true["']/i.test(preauditRaw);

        if (!executed) {
            const response = await activate(returnedReferences || references, false);
            activationRaw = String(response.data || "");
            activationStatus = response.status;

            if (response.status < 200 || response.status >= 300) {
                return jsonError(
                    res,
                    response.status,
                    "SAP activation failed: " + sapErrorMessage(response.data)
                );
            }

            if (hasErrors(activationRaw)) {
                return jsonError(
                    res,
                    422,
                    "SAP activation failed: " + activationError(activationRaw)
                );
            }

            executed = /activationExecuted=["']true["']/i.test(activationRaw);
        }

        if (!executed) {
            return jsonError(
                res,
                502,
                "SAP returned HTTP " + activationStatus +
                    " without confirming activation of " + name +
                    ". Review the ADT response and SAP workbench."
            );
        }

        return res.json({
            success: true,
            name,
            status: "activated",
            httpStatus: activationStatus,
            raw: activationRaw
        });

    } catch (error) {
        return jsonError(res, 500, error);
    }
});


// ======================================================
// ODATA CATALOG / PORTFOLIO
// ======================================================

const ODATA_CATALOG_PATH =
    "/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection";

const RECOMMENDED_ODATA_APIS = [
    {
        service: "API_BUSINESS_PARTNER",
        label: "Business Partner",
        version: "V2",
        entity: "A_BusinessPartner",
        domain: "Master Data",
        create: true,
        update: true,
        delete: true
    },
    {
        service: "API_PRODUCT_SRV",
        label: "Product Master",
        version: "V2",
        entity: "A_Product",
        domain: "Master Data",
        create: true,
        update: true,
        delete: true
    },
    {
        service: "API_PURCHASEREQUISITION_2",
        label: "Purchase Requisition",
        version: "V4",
        entity: "A_PurchaseRequisition",
        domain: "Procurement",
        create: true,
        update: true,
        delete: false
    },
    {
        service: "API_PURCHASEORDER_2",
        label: "Purchase Order",
        version: "V4",
        entity: "PurchaseOrder",
        domain: "Procurement",
        create: true,
        update: true,
        delete: true
    },
    {
        service: "API_SALES_ORDER_SRV",
        label: "Sales Order",
        version: "V2",
        entity: "A_SalesOrder",
        domain: "Sales",
        create: true,
        update: true,
        delete: false
    }
];

function odataRoot(service, version) {
    const name =
        String(service || "").trim().toUpperCase();

    const v = String(version || "V2").toUpperCase();

    if (v === "V4") {
        const roots = {
            API_PURCHASEREQUISITION_2:
                "/sap/opu/odata4/sap/api_purchaserequisition_2/srvd_a2x/sap/purchaserequisition/0001",
            API_PURCHASEORDER_2:
                "/sap/opu/odata4/sap/api_purchaseorder_2/srvd_a2x/sap/purchaseorder/0001"
        };

        if (!roots[name]) {
            throw new Error(
                `No V4 root configured for ${name}.`
            );
        }

        return roots[name];
    }

    if (!/^[A-Z0-9_]+$/.test(name)) {
        throw new Error("Invalid OData service name.");
    }

    return `/sap/opu/odata/sap/${encodeURIComponent(name)}`;
}

function classifyODataModule(service, description = "") {
    const text = `${service} ${description}`.toUpperCase();
    const rules = [
        ["HCM", /(?<![A-Z])(HCM|HUMAN.?RESOURCE|EMPLOYEE|WORKFORCE|PERSONNEL|PAYROLL|TIME.?MANAGEMENT)(?![A-Z])/],
        ["PP/QM", /(?<![A-Z])(PRODUCTION|MANUFACTUR|QUALITY|INSPECTION|BILL.?OF.?MATERIAL|BOM|WORK.?CENTER|PLANNING)(?![A-Z])/],
        ["FI/CO", /(?<![A-Z])(FINANC|ACCOUNT|JOURNAL|LEDGER|COST.?CENTER|PROFIT.?CENTER|CONTROLLING|PAYMENT|TAX)(?![A-Z])/],
        ["SD", /(?<![A-Z])(SALES|CUSTOMER|DELIVERY|BILLING|QUOTATION|PRICING)(?![A-Z])/],
        ["MM", /(?<![A-Z])(MATERIAL|PURCHASE.?ORDER|PURCHASEREQUISITION|PURCHASE|PROCUREMENT|SUPPLIER|INVENTORY|STOCK|RESERVATION|GOODS.?RECEIPT)(?![A-Z])/]
    ];
    return rules.find(([, pattern]) => pattern.test(text))?.[0] || "Other";
}

function catalogEntryForService(services, service) {
    const name = String(service || "").trim().toUpperCase();
    return services.find(item =>
        String(item.service || "").toUpperCase() === name ||
        String(item.externalService || "").toUpperCase() === name
    );
}

function catalogServiceRoot(entry) {
    if (!entry?.url) return "";

    let candidate;
    try {
        candidate = new URL(entry.url, `${sapBaseUrl()}/`);
        const base = new URL(sapBaseUrl());
        if (candidate.origin !== base.origin ||
            !/^\/sap\/opu\/odata(?:4)?\//.test(candidate.pathname)) {
            throw new Error("SAP catalog service URL is outside the configured OData endpoint.");
        }
    } catch (error) {
        if (error instanceof TypeError) {
            throw new Error("SAP catalog returned an invalid OData service URL.");
        }
        throw error;
    }

    return candidate.pathname.replace(/\/+$/, "");
}

async function resolveODataRoot(session, service, version, knownService) {
    if (knownService) return odataRoot(knownService.service, knownService.version);
    const response = await session.request("GET", ODATA_CATALOG_PATH, {
        accept: "application/atom+xml, application/xml, */*"
    });
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`OData catalog failed: ${sapErrorMessage(response.data)}`);
    }

    const entry = catalogEntryForService(parseODataCatalog(response.data), service);
    if (!entry) throw new Error(`OData service ${service} is not present in the SAP service catalog.`);

    const catalogRoot = catalogServiceRoot(entry);
    if (catalogRoot) return catalogRoot;

    const resolvedVersion = String(version || entry.version || "V2").toUpperCase();
    if (resolvedVersion !== "V2") {
        throw new Error(`The SAP catalog did not provide a service URL for ${service} (${resolvedVersion}).`);
    }
    return odataRoot(service, resolvedVersion);
}

function parseODataCatalog(xml) {
    const text = String(xml || "");
    const results = [];
    const seen = new Set();

    for (const m of text.matchAll(
        /<entry\b[\s\S]*?<\/entry>/gi
    )) {
        const block = m[0];

        const technical =
            xmlValue(block, [
                "TechnicalServiceName",
                "technicalServiceName"
            ]);

        const external =
            xmlValue(block, [
                "ExternalServiceName",
                "externalServiceName"
            ]);

        const version =
            xmlValue(block, [
                "Version",
                "version"
            ]);

        const description =
            xmlValue(block, [
                "Description",
                "description",
                "Title",
                "title"
            ]);

        const href =
            block.match(
                /href="([^"]*\/sap\/opu\/odata[^"]*)"/i
            );

        let service =
            technical ||
            external ||
            (
                href
                    ? href[1].split("/").pop()
                    : ""
            );

        service =
            decodeXml(service)
                .replace(/;v=\d+$/i, "")
                .trim();

        if (!service) continue;

        const key =
            service.toUpperCase();

        if (seen.has(key)) continue;

        seen.add(key);

        const recommended =
            RECOMMENDED_ODATA_APIS.find(
                x =>
                    x.service.toUpperCase() === key
            );
        const resolvedDescription = description || "";

        results.push({
            service,
            externalService: external || "",
            version: version || recommended?.version || "V2",
            description: resolvedDescription,
            recommended: !!recommended,
            domain: recommended?.domain || "SAP Gateway",
            module: classifyODataModule(service, resolvedDescription),
            entity: recommended?.entity || "",
            create: recommended?.create || false,
            update: recommended?.update || false,
            delete: recommended?.delete || false,
            url: href
                ? decodeXml(href[1])
                : ""
        });
    }

    return results;
}

class ODataSession extends SapSession {

    async ensureCsrfFor(root) {
        if (this.csrfToken) return this.csrfToken;

        const response =
            await this.send(
                "GET",
                root,
                {
                    headers: {
                        "X-CSRF-Token":
                            "Fetch"
                    },
                    accept:
                        "application/json, application/xml, */*"
                }
            );

        const token =
            response.headers["x-csrf-token"];

        if (
            response.status < 200 ||
            response.status >= 300 ||
            !token ||
            String(token).toLowerCase() === "required"
        ) {
            throw new Error(
                `Unable to fetch OData CSRF token (HTTP ${response.status}): ${sapErrorMessage(response.data)}`
            );
        }

        this.csrfToken = token;
        return token;
    }
}


// ======================================================
// ODATA CATALOG
// ======================================================

app.get("/api/odata/catalog", async (req, res) => {
    if (demoMode) {
        const services = RECOMMENDED_ODATA_APIS.map(api => ({
            service: api.service,
            externalService: api.service,
            version: api.version,
            description: `${api.label} — curated demonstration service`,
            recommended: true,
            module: classifyODataModule(api.service, api.label),
            demo: true,
            updated: ""
        }));
        return res.json({
            success: true,
            demo: true,
            count: services.length,
            services,
            recommended: RECOMMENDED_ODATA_APIS.map(api => ({
                ...api,
                module: classifyODataModule(api.service, api.label)
            }))
        });
    }
    try {
        const session =
            new SapSession();

        const response =
            await session.request(
                "GET",
                ODATA_CATALOG_PATH,
                {
                    accept:
                        "application/atom+xml, application/xml, */*"
                }
            );

        if (
            response.status < 200 ||
            response.status >= 300
        ) {
            return jsonError(
                res,
                response.status,
                `OData catalog failed: ${sapErrorMessage(response.data)}`
            );
        }

        const services =
            parseODataCatalog(
                response.data
            );

        return res.json({
            success: true,
            count: services.length,
            services,
            recommended:
                RECOMMENDED_ODATA_APIS.map(api => ({
                    ...api,
                    module: classifyODataModule(api.service, api.label)
                }))
        });

    } catch (error) {
        return jsonError(res, 500, sapConnectionError(error));
    }
});

app.get("/api/odata/recommended", (req, res) => {
    res.json({
        success: true,
        services:
            RECOMMENDED_ODATA_APIS.map(api => ({
                ...api,
                module: classifyODataModule(api.service, api.label)
            }))
    });
});


// ======================================================
// ODATA METADATA
// ======================================================

app.get("/api/odata/metadata", async (req, res) => {
    try {
        const service =
            String(req.query.service || "").trim();

        const cfg =
            RECOMMENDED_ODATA_APIS.find(
                x =>
                    x.service.toUpperCase() ===
                    service.toUpperCase()
            );

        const version =
            String(
                req.query.version ||
                cfg?.version ||
                "V2"
            ).toUpperCase();

        if (!service) {
            return jsonError(
                res,
                400,
                "OData service is required."
            );
        }

        if (demoMode) {
            const known = RECOMMENDED_ODATA_APIS.find(x => x.service.toUpperCase() === service.toUpperCase());
            if (!known) return jsonError(res, 404, "This sample service is not in the demo catalog.");
            const properties = ["ID", "Name", "Category", "Status", "CreatedAt"].map((name, i) => `<Property Name="${name}" Type="${i === 4 ? "Edm.DateTime" : "Edm.String"}" Nullable="false" />`).join("");
            const metadata = `<?xml version="1.0" encoding="utf-8"?><edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx"><edmx:DataServices><Schema Namespace="Demo.${service}" xmlns="http://schemas.microsoft.com/ado/2008/09/edm"><EntityType Name="${known.entity}"><Key><PropertyRef Name="ID" /></Key>${properties}</EntityType></Schema></edmx:DataServices></edmx:Edmx>`;
            return res.json({ success: true, demo: true, service, version, metadata });
        }

        const session =
            new SapSession();

        const root = await resolveODataRoot(
            session,
            service,
            version,
            cfg
        );

        const response =
            await session.request(
                "GET",
                `${root}/$metadata`,
                {
                    accept:
                        "application/xml, application/json, */*"
                }
            );

        if (
            response.status < 200 ||
            response.status >= 300
        ) {
            return jsonError(
                res,
                response.status,
                `OData metadata failed: ${sapErrorMessage(response.data)}`
            );
        }

        return res.json({
            success: true,
            service,
            version,
            metadata:
                response.data
        });

    } catch (error) {
        return jsonError(
            res,
            500,
            error
        );
    }
});

app.get("/api/odata/entities", async (req, res) => {
    try {
        const service = String(req.query.service || "").trim();
        if (!/^[A-Z0-9_]+$/i.test(service)) {
            return jsonError(res, 400, "A valid OData service is required.");
        }

        const cfg = RECOMMENDED_ODATA_APIS.find(
            item => item.service.toUpperCase() === service.toUpperCase()
        );
        const version = String(req.query.version || cfg?.version || "V2").toUpperCase();

        if (demoMode) {
            if (!cfg) return jsonError(res, 404, "This sample service is not in the demo catalog.");
            return res.json({
                success: true,
                demo: true,
                service,
                version,
                entities: [{ name: cfg.entity, entityType: `Demo.${service}.${cfg.entity}` }]
            });
        }

        const session = new SapSession();
        const root = await resolveODataRoot(session, service, version, cfg);
        const response = await session.request("GET", `${root}/$metadata`, {
            accept: "application/xml, text/xml, */*"
        });

        if (response.status < 200 || response.status >= 300) {
            return jsonError(
                res,
                response.status,
                `OData entity discovery failed: ${sapErrorMessage(response.data)}`
            );
        }

        const entities = [...String(response.data || "").matchAll(/<EntitySet\b([^>]*)\/?>/gi)]
            .map(match => ({
                name: xmlAttribute(match[1], "Name"),
                entityType: xmlAttribute(match[1], "EntityType")
            }))
            .filter(entity => entity.name);

        return res.json({ success: true, service, version, count: entities.length, entities });
    } catch (error) {
        return jsonError(res, 500, sapConnectionError(error));
    }
});

app.get("/api/odata/schema", async (req, res) => {
    try {
        const service = String(req.query.service || "").trim();
        const entity = String(req.query.entity || "").trim();
        if (!/^[A-Z0-9_]+$/i.test(service) || !/^[A-Za-z0-9_]+$/.test(entity)) {
            return jsonError(res, 400, "A valid service and entity set are required.");
        }
        const cfg = RECOMMENDED_ODATA_APIS.find(item => item.service.toUpperCase() === service.toUpperCase());
        const version = String(req.query.version || cfg?.version || "V2").toUpperCase();
        if (demoMode) {
            if (!cfg) return jsonError(res, 404, "This sample service is not in the demo catalog.");
            const samples = {
                API_BUSINESS_PARTNER: ["ID", "Name", "Category", "Status", "CreatedAt"],
                API_PRODUCT_SRV: ["ID", "Name", "Category", "Status", "CreatedAt"],
                API_PURCHASEREQUISITION_2: ["ID", "Name", "Category", "Status", "CreatedAt"],
                API_PURCHASEORDER_2: ["ID", "Name", "Category", "Status", "CreatedAt"],
                API_SALES_ORDER_SRV: ["ID", "Name", "Category", "Status", "CreatedAt"]
            };
            return res.json({
                success: true, demo: true, service, entity,
                properties: (samples[cfg.service] || []).map(name => ({ name, type: name === "CreatedAt" ? "Edm.DateTimeOffset" : "Edm.String", nullable: true, key: name === "ID" })),
                navigationProperties: cfg.service === "API_BUSINESS_PARTNER" ? [{ name: "to_BusinessPartnerAddress", targetType: "A_BusinessPartnerAddress", collection: true }] : []
            });
        }
        const session = new SapSession();
        const root = await resolveODataRoot(session, service, version, cfg);
        const response = await session.request("GET", `${root}/$metadata`, { accept: "application/xml, text/xml, */*" });
        if (response.status < 200 || response.status >= 300) return jsonError(res, response.status, `OData schema failed: ${sapErrorMessage(response.data)}`);
        const metadata = String(response.data || "");
        const set = [...metadata.matchAll(/<(?:[\w.-]+:)?EntitySet\b([^>]*)\/?\s*>/gi)].map(match => ({ name: xmlAttribute(match[1], "Name"), type: xmlAttribute(match[1], "EntityType") })).find(item => item.name === entity);
        if (!set) return jsonError(res, 404, `Entity set ${entity} was not found in service metadata.`);
        const typeName = set.type.split(".").pop();
        const typeMatch = [...metadata.matchAll(/<(?:[\w.-]+:)?EntityType\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?EntityType>/gi)].find(match => xmlAttribute(match[1], "Name") === typeName);
        if (!typeMatch) return jsonError(res, 404, `Entity type ${typeName} was not found in service metadata.`);
        const keys = new Set([...typeMatch[2].matchAll(/<(?:[\w.-]+:)?PropertyRef\b([^>]*)\/?\s*>/gi)].map(match => xmlAttribute(match[1], "Name")));
        const properties = [...typeMatch[2].matchAll(/<(?:[\w.-]+:)?Property\b([^>]*)\/?\s*>/gi)].map(match => ({
            name: xmlAttribute(match[1], "Name"), type: xmlAttribute(match[1], "Type"),
            nullable: xmlAttribute(match[1], "Nullable").toLowerCase() !== "false",
            key: keys.has(xmlAttribute(match[1], "Name")),
            maxLength: xmlAttribute(match[1], "MaxLength") || undefined
        })).filter(property => property.name);
        const associations = [...metadata.matchAll(/<(?:[\w.-]+:)?Association\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?Association>/gi)].map(match => ({
            name: xmlAttribute(match[1], "Name"), body: match[2]
        }));
        const navigationProperties = [...typeMatch[2].matchAll(/<(?:[\w.-]+:)?NavigationProperty\b([^>]*)\/?\s*>/gi)].map(match => {
            const attrs = match[1];
            const name = xmlAttribute(attrs, "Name");
            const declaredType = xmlAttribute(attrs, "Type");
            const relationship = xmlAttribute(attrs, "Relationship");
            const targetRole = xmlAttribute(attrs, "ToRole");
            let targetType = declaredType.replace(/^Collection\((.*)\)$/, "$1");
            let collection = /^Collection\(/.test(declaredType);
            if (relationship && targetRole) {
                const association = associations.find(item => item.name === relationship.split(".").pop());
                const end = association && [...association.body.matchAll(/<(?:[\w.-]+:)?End\b([^>]*)\/?\s*>/gi)].map(endMatch => endMatch[1]).find(endAttrs => xmlAttribute(endAttrs, "Role") === targetRole);
                if (end) {
                    targetType = xmlAttribute(end, "Type");
                    collection = xmlAttribute(end, "Multiplicity") === "*";
                }
            }
            return { name, targetType, targetEntityType: targetType.split(".").pop(), collection };
        }).filter(property => property.name);
        return res.json({ success: true, service, entity, entityType: set.type, properties, navigationProperties });
    } catch (error) {
        return jsonError(res, 500, sapConnectionError(error));
    }
});


// ======================================================
// ODATA QUERY
// ======================================================

app.get("/api/odata/query", async (req, res) => {
    try {
        const service =
            String(req.query.service || "").trim();

        const entity =
            String(req.query.entity || "").trim();

        if (!service || !entity) {
            return jsonError(
                res,
                400,
                "Service and entity are required."
            );
        }

        if (!/^[A-Z0-9_]+$/i.test(service)) {
            return jsonError(
                res,
                400,
                "Invalid OData service."
            );
        }

        if (
            !/^[A-Za-z0-9_()=',.\/: -]+$/.test(
                entity
            )
        ) {
            return jsonError(
                res,
                400,
                "Invalid OData entity."
            );
        }

        if (demoMode) {
            const known = RECOMMENDED_ODATA_APIS.find(x => x.service.toUpperCase() === service.toUpperCase());
            if (!known) return jsonError(res, 404, "This sample service is not in the demo catalog.");
            const demoSkip = Number(req.query.skip ?? 0);
            if (!Number.isInteger(demoSkip) || demoSkip < 0 || demoSkip > 100000) return jsonError(res, 400, "Skip must be an integer between 0 and 100000.");
            if (req.query.count !== undefined && !["true", "false"].includes(String(req.query.count).toLowerCase())) return jsonError(res, 400, "Count must be true or false.");
            const samples = {
                API_BUSINESS_PARTNER: [
                    { ID: "1000001", Name: "Northwind Components", Category: "Supplier", Status: "Active", CreatedAt: "2026-02-12T09:30:00Z" },
                    { ID: "1000002", Name: "Summit Industrial Group", Category: "Customer", Status: "Active", CreatedAt: "2026-03-08T14:15:00Z" },
                    { ID: "1000003", Name: "Blue River Logistics", Category: "Supplier", Status: "Under review", CreatedAt: "2026-04-21T11:00:00Z" }
                ],
                API_PRODUCT_SRV: [
                    { ID: "MAT-100042", Name: "Industrial pump assembly", Category: "Mechanical", Status: "Released", CreatedAt: "2026-01-18T08:00:00Z" },
                    { ID: "MAT-100087", Name: "Control valve 2-inch", Category: "Components", Status: "Released", CreatedAt: "2026-02-04T10:45:00Z" },
                    { ID: "MAT-100116", Name: "Safety sensor module", Category: "Electrical", Status: "In review", CreatedAt: "2026-03-17T16:20:00Z" }
                ],
                API_PURCHASEREQUISITION_2: [
                    { ID: "10004521", Name: "Plant maintenance supplies", Category: "USD 12,450", Status: "In approval", CreatedAt: "2026-04-02T13:10:00Z" },
                    { ID: "10004537", Name: "Production line tooling", Category: "USD 8,900", Status: "Approved", CreatedAt: "2026-04-11T09:25:00Z" }
                ],
                API_PURCHASEORDER_2: [
                    { ID: "4500012841", Name: "Northwind Components", Category: "USD 24,800", Status: "Open", CreatedAt: "2026-03-28T12:00:00Z" },
                    { ID: "4500012894", Name: "Summit Industrial Group", Category: "USD 6,240", Status: "Released", CreatedAt: "2026-04-09T15:30:00Z" }
                ],
                API_SALES_ORDER_SRV: [
                    { ID: "5000087312", Name: "Acme Manufacturing", Category: "USD 18,600", Status: "In delivery", CreatedAt: "2026-04-14T10:05:00Z" },
                    { ID: "5000087340", Name: "Keystone Supply Co.", Category: "USD 9,350", Status: "Open", CreatedAt: "2026-04-19T14:40:00Z" }
                ]
            };
            const rows = (samples[known.service] || []).slice(0);
            const filterText = String(req.query.filter || "").trim();
            let filteredRows = rows;
            if (filterText) {
                const unwrap = value => {
                    let text = value.trim();
                    while (text.startsWith("(") && text.endsWith(")")) {
                        let depth = 0, quoted = false, wrapsWhole = true;
                        for (let i = 0; i < text.length; i += 1) {
                            if (text[i] === "'" && text[i + 1] === "'" && quoted) { i += 1; continue; }
                            if (text[i] === "'") quoted = !quoted;
                            if (quoted) continue;
                            if (text[i] === "(") depth += 1;
                            if (text[i] === ")") depth -= 1;
                            if (depth === 0 && i < text.length - 1) { wrapsWhole = false; break; }
                        }
                        if (!wrapsWhole) break;
                        text = text.slice(1, -1).trim();
                    }
                    return text;
                };
                const clauses = [];
                let start = 0, depth = 0, quoted = false;
                for (let i = 0; i < filterText.length; i += 1) {
                    if (filterText[i] === "'" && filterText[i + 1] === "'" && quoted) { i += 1; continue; }
                    if (filterText[i] === "'") quoted = !quoted;
                    if (quoted) continue;
                    if (filterText[i] === "(") depth += 1;
                    if (filterText[i] === ")") depth -= 1;
                    if (depth === 0 && /^\s+and\s+/i.test(filterText.slice(i))) {
                        clauses.push(unwrap(filterText.slice(start, i)));
                        const delimiter = filterText.slice(i).match(/^\s+and\s+/i)[0];
                        i += delimiter.length - 1;
                        start = i + 1;
                    }
                }
                clauses.push(unwrap(filterText.slice(start)));
                filteredRows = rows.filter(row => clauses.every(clause => {
                    let match = clause.match(/^(?:contains\((\w+),\s*'((?:''|[^'])*)'\)|substringof\('((?:''|[^'])*)',\s*(\w+)\)|startswith\((\w+),\s*'((?:''|[^'])*)'\))$/i);
                    if (match) {
                        const field = match[1] || match[4] || match[5];
                        const value = (match[2] || match[3] || match[6] || "").replace(/''/g, "'").toLowerCase();
                        const actual = String(row[field] ?? "").toLowerCase();
                        return match[5] ? actual.startsWith(value) : actual.includes(value);
                    }
                    match = clause.match(/^(\w+)\s+(eq|ne|gt|ge|lt|le)\s+('?((?:''|[^'])*)'|(-?\d+(?:\.\d+)?))$/i);
                    if (!match) return false;
                    const actual = row[match[1]];
                    const rawExpected = match[4] !== undefined ? match[4].replace(/''/g, "'") : match[5];
                    const expected = typeof actual === "number" ? Number(rawExpected) : String(rawExpected).toLowerCase();
                    const left = typeof actual === "number" ? actual : String(actual ?? "").toLowerCase();
                    return ({ eq: left === expected, ne: left !== expected, gt: left > expected, ge: left >= expected, lt: left < expected, le: left <= expected })[match[2].toLowerCase()];
                }));
            }
            if (req.query.search) {
                const term = String(req.query.search).replace(/^['"]|['"]$/g, "").toLowerCase();
                filteredRows = filteredRows.filter(row => Object.values(row).some(value => String(value).toLowerCase().includes(term)));
            }
            if (req.query.orderby) {
                const order = String(req.query.orderby).split(",").map(item => item.trim().split(/\s+/));
                filteredRows.sort((a, b) => {
                    for (const [property, direction] of order) {
                        const result = String(a[property] ?? "").localeCompare(String(b[property] ?? ""), undefined, { numeric: true }) * (/^desc$/i.test(direction || "") ? -1 : 1);
                        if (result) return result;
                    }
                    return 0;
                });
            }
            const total = filteredRows.length;
            const skip = demoSkip;
            const requestedTop = req.query.top === undefined ? 10 : Number(req.query.top);
            if (!Number.isInteger(requestedTop) || requestedTop < 1 || requestedTop > 1000) return jsonError(res, 400, "Top must be an integer between 1 and 1000.");
            const top = requestedTop;
            const selected = String(req.query.select || "").split(",").map(x => x.trim()).filter(Boolean);
            const expand = String(req.query.expand || "").split(",").map(x => x.trim()).filter(Boolean);
            const data = filteredRows.slice(skip, skip + top).map(row => {
                const result = selected.length
                    ? Object.fromEntries(selected.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]))
                    : { ...row };
                if (known.service === "API_BUSINESS_PARTNER" && expand.includes("to_BusinessPartnerAddress")) {
                    result.to_BusinessPartnerAddress = [{ CityName: row.ID === "1000001" ? "Pune" : row.ID === "1000002" ? "Bengaluru" : "Mumbai", Country: "IN" }];
                }
                return result;
            });
            return res.json({ success: true, demo: true, service, entity, count: data.length, totalCount: String(req.query.count).toLowerCase() === "true" ? total : undefined, data: { value: data } });
        }

        const cfg =
            RECOMMENDED_ODATA_APIS.find(
                x =>
                    x.service.toUpperCase() ===
                    service.toUpperCase()
            );

        const version =
            String(
                req.query.version ||
                cfg?.version ||
                "V2"
            ).toUpperCase();

        const session =
            new SapSession();

        const root = await resolveODataRoot(
            session,
            service,
            version,
            cfg
        );

        const entityPath = `${root}/${entity}`;
        const nextLink = String(req.query.next || "");
        let requestPath = entityPath;

        const requestedTop = req.query.top === undefined ? 10 : Number(req.query.top);
        if (!Number.isInteger(requestedTop) || requestedTop < 1 || requestedTop > 1000) {
            return jsonError(res, 400, "Top must be an integer between 1 and 1000.");
        }
        const top = requestedTop;

        let query = { "$top": top };
        let skip = Number(req.query.skip ?? 0);
        if (!Number.isInteger(skip) || skip < 0 || skip > 100000) {
            return jsonError(res, 400, "Skip must be an integer between 0 and 100000.");
        }

        if (nextLink) {
            if (nextLink.length > 8000) return jsonError(res, 400, "SAP continuation link is too long.");
            let target;
            try { target = new URL(nextLink, `${sapBaseUrl()}/`); }
            catch (_) { return jsonError(res, 400, "Invalid SAP continuation link."); }
            const sapOrigin = new URL(sapBaseUrl()).origin;
            if (target.origin !== sapOrigin || target.username || target.password || target.hash || target.pathname !== entityPath) {
                return jsonError(res, 400, "SAP continuation link must remain on this SAP entity endpoint.");
            }
            const linkedClient = target.searchParams.get("sap-client");
            if (linkedClient && linkedClient !== String(process.env.SAP_CLIENT)) {
                return jsonError(res, 400, "SAP continuation link targets a different client.");
            }
            requestPath = target.pathname;
            query = Object.fromEntries(target.searchParams.entries());
            delete query["sap-client"];
            skip = Number(query["$skip"] || 0);
        } else {
            if (skip) query["$skip"] = skip;

            if (req.query.orderby) {
                const orderby = String(req.query.orderby).trim();
                if (orderby.length > 500 || !/^[A-Za-z0-9_./, ]+(?:\s+(?:asc|desc))?(?:\s*,\s*[A-Za-z0-9_./]+(?:\s+(?:asc|desc))?)*$/i.test(orderby)) {
                    return jsonError(res, 400, "Invalid orderby. Use property names with optional asc/desc directions.");
                }
                query["$orderby"] = orderby;
            }

            if (req.query.count !== undefined) {
                const count = String(req.query.count).toLowerCase();
                if (!["true", "false"].includes(count)) {
                    return jsonError(res, 400, "Count must be true or false.");
                }
                query[version === "V4" ? "$count" : "$inlinecount"] = version === "V4" ? count : (count === "true" ? "allpages" : "none");
            }

            if (req.query.search) {
                const search = String(req.query.search).trim();
                if (search.length > 200 || /[\u0000-\u001f]/.test(search)) {
                    return jsonError(res, 400, "Search text must be at most 200 characters and contain no control characters.");
                }
                query["$search"] = search;
            }

            if (version === "V2") query["$format"] = "json";

            if (req.query.filter) {
                const filter = String(req.query.filter).trim();
                if (filter.length > 2000 || /[\u0000-\u001f]/.test(filter)) return jsonError(res, 400, "Filter must be at most 2,000 characters and contain no control characters.");
                query["$filter"] = filter;
            }

            if (req.query.select) {
                const select = String(req.query.select).trim();
                if (select.length > 1000 || !/^[A-Za-z0-9_./,* ]+$/.test(select)) {
                    return jsonError(res, 400, "Invalid select property list.");
                }
                query["$select"] = select;
            }

            if (req.query.expand) {
                const expand = String(req.query.expand).trim();
                if (expand.length > 500 || !/^[A-Za-z0-9_./,() ]+$/.test(expand)) return jsonError(res, 400, "Invalid expand navigation-property list.");
                query["$expand"] = expand;
            }
        }

        const response =
            await session.request(
                "GET",
                requestPath,
                {
                    query,
                    accept:
                        "application/json, application/xml, */*"
                }
            );

        if (
            response.status < 200 ||
            response.status >= 300
        ) {
            return jsonError(
                res,
                response.status,
                `OData read failed: ${sapErrorMessage(response.data)}`
            );
        }

        let data =
            response.data;

        try {
            data =
                JSON.parse(
                    response.data
                );
        } catch (_) {}

        let count;

        if (
            Array.isArray(
                data?.d?.results
            )
        ) {
            count =
                data.d.results.length;
        } else if (
            Array.isArray(
                data?.value
            )
        ) {
            count =
                data.value.length;
        }

        return res.json({
            success: true,
            service,
            entity,
            count,
            totalCount: data?.['@odata.count'] ?? data?.d?.__count ?? data?.['@count'],
            nextLink: data?.['@odata.nextLink'] ?? data?.d?.__next ?? null,
            page: { top: Number(query["$top"] || top), skip },
            data
        });

    } catch (error) {
        return jsonError(
            res,
            500,
            error
        );
    }
});


// ======================================================
// ODATA CRUD
// Guarded to the five curated APIs.
// ======================================================

app.post("/api/odata/crud", async (req, res) => {
    try {
        if (demoMode) return jsonError(res, 403, "Write operations are disabled in demo mode. Connect to SAP to create, update, or delete business data.");
        const service =
            String(req.body?.service || "").trim();

        const entity =
            String(req.body?.entity || "").trim();

        const method =
            String(
                req.body?.method ||
                "POST"
            ).toUpperCase();

        const payload =
            req.body?.payload;

        const cfg =
            RECOMMENDED_ODATA_APIS.find(
                x =>
                    x.service.toUpperCase() ===
                    service.toUpperCase()
            );

        if (!cfg) {
            return jsonError(
                res,
                403,
                "Write is limited to the curated OData APIs."
            );
        }

        if (
            !["POST", "PATCH", "PUT", "DELETE"]
                .includes(method)
        ) {
            return jsonError(
                res,
                400,
                "Unsupported OData write method."
            );
        }

        if (
            method === "POST" &&
            !cfg.create
        ) {
            return jsonError(
                res,
                403,
                `POST is not enabled for ${service}.`
            );
        }

        if (
            ["PATCH", "PUT"].includes(method) &&
            !cfg.update
        ) {
            return jsonError(
                res,
                403,
                `Update is not enabled for ${service}.`
            );
        }

        if (
            method === "DELETE" &&
            !cfg.delete
        ) {
            return jsonError(
                res,
                403,
                `DELETE is not enabled for ${service}.`
            );
        }

        if (
            !/^[A-Z0-9_]+$/i.test(
                service
            )
        ) {
            return jsonError(
                res,
                400,
                "Invalid OData service."
            );
        }

        if (
            !/^[A-Za-z0-9_()=',.\/: -]+$/.test(
                entity
            )
        ) {
            return jsonError(
                res,
                400,
                "Invalid OData entity."
            );
        }

        const version =
            String(
                cfg.version ||
                "V2"
            ).toUpperCase();

        const root =
            odataRoot(
                service,
                version
            );

        const session =
            new ODataSession();

        await session.ensureCsrfFor(
            root
        );

        const sendWrite =
            () =>
                session.request(
                    method,
                    `${root}/${entity}`,
                    {
                        headers: {
                            "Content-Type":
                                "application/json"
                        },
                        data:
                            method === "DELETE"
                                ? undefined
                                : JSON.stringify(
                                    payload ?? {}
                                ),
                        accept:
                            "application/json, application/xml, */*"
                    }
                );

        let response =
            await sendWrite();

        if (
            response.status === 403
        ) {
            session.csrfToken = null;

            await session.ensureCsrfFor(
                root
            );

            response =
                await sendWrite();
        }

        if (
            response.status < 200 ||
            response.status >= 300
        ) {
            return jsonError(
                res,
                response.status,
                `OData ${method} failed: ${sapErrorMessage(response.data)}`
            );
        }

        return res.json({
            success: true,
            method,
            service,
            entity,
            status:
                response.status,
            data:
                response.data
        });

    } catch (error) {
        return jsonError(
            res,
            500,
            error
        );
    }
});


// ======================================================
// BUSINESS PARTNERS
// ======================================================

app.get("/api/business-partners", async (req, res) => {
    try {
        requireSapConfig();

        const top =
            Math.min(
                Math.max(
                    Number(req.query.top) || 5,
                    1
                ),
                100
            );

        const url =
            `${sapBaseUrl()}/sap/opu/odata/sap/API_BUSINESS_PARTNER/` +
            `A_BusinessPartner?$top=${top}&$format=json&sap-client=` +
            encodeURIComponent(
                process.env.SAP_CLIENT
            );

        const response =
            await axios.get(
                url,
                {
                    auth: {
                        username:
                            process.env.SAP_USERNAME,
                        password:
                            process.env.SAP_PASSWORD
                    },
                    httpsAgent:
                        sapHttpsAgent,
                    timeout:
                        30000
                }
            );

        const results =
            response.data?.d?.results ||
            response.data?.value ||
            [];

        return res.json({
            success: true,
            count:
                results.length,
            data:
                results
        });

    } catch (error) {
        return jsonError(
            res,
            error.response?.status || 500,
            error.response?.data || error.message
        );
    }
});


// ======================================================
// SYSTEM OVERVIEW
// ======================================================

app.get("/api/system/overview", async (req, res) => {
    if (demoMode) {
        return res.json({
            success: true,
            demo: true,
            odataServiceCount: RECOMMENDED_ODATA_APIS.length,
            system: {
                systemId: "DEMO",
                client: "100",
                user: "DEMO_USER",
                host: "Sample environment",
                adt: false,
                odata: false,
                webgui: false,
                adtError: "Sample environment: no SAP connection is active.",
                odataError: "Sample catalog data is shown for demonstration only.",
                webguiError: "Live SAP transactions require a configured SAP connection."
            }
        });
    }
    try {
        const session =
            new SapSession();

        const [adtResult, catalogResult, webguiResult] =
            await Promise.allSettled([
                session.request(
                    "GET",
                    "/sap/bc/adt/discovery",
                    {
                        accept:
                            "application/atomsvc+xml"
                    }
                ),
                session.request(
                    "GET",
                    ODATA_CATALOG_PATH,
                    {
                        accept:
                            "application/atom+xml, application/xml, */*"
                    }
                ),
                session.request(
                    "GET",
                    "/sap/bc/gui/sap/its/webgui",
                    {
                        query: { "sap-client": process.env.SAP_CLIENT },
                        accept: "text/html, */*"
                    }
                )
            ]);

        const adt = adtResult.status === "fulfilled" ? adtResult.value : null;
        const catalog = catalogResult.status === "fulfilled" ? catalogResult.value : null;
        const webgui = webguiResult.status === "fulfilled" ? webguiResult.value : null;

        return res.json({
            success: true,
            system: {
                systemId:
                    process.env.SAP_SYSTEM_ID ||
                    new URL(sapBaseUrl()).hostname,
                client:
                    process.env.SAP_CLIENT ||
                    "",
                user:
                    process.env.SAP_USERNAME ||
                    "",
                host:
                    sapBaseUrl(),
                adt:
                    Boolean(adt && adt.status >= 200 && adt.status < 300),
                adtError:
                    adtResult.status === "rejected" ? sapConnectionError(adtResult.reason).message : (adt && (adt.status < 200 || adt.status >= 300) ? sapErrorMessage(adt.data) : ""),
                odata:
                    Boolean(catalog && catalog.status >= 200 && catalog.status < 300),
                odataError:
                    catalogResult.status === "rejected" ? sapConnectionError(catalogResult.reason).message : (catalog && (catalog.status < 200 || catalog.status >= 300) ? sapErrorMessage(catalog.data) : ""),
                webgui:
                    Boolean(webgui && webgui.status >= 200 && webgui.status < 300),
                webguiError:
                    webguiResult.status === "rejected" ? sapConnectionError(webguiResult.reason).message : (webgui && (webgui.status < 200 || webgui.status >= 300) ? sapWebGuiErrorMessage(webgui.data) : "")
            },
            odataServiceCount:
                catalog && catalog.status >= 200 &&
                catalog.status < 300
                    ? parseODataCatalog(catalog.data).length
                    : null
        });

    } catch (error) {
        return jsonError(
            res,
            500,
            sapConnectionError(error)
        );
    }
});


// ======================================================
// UNIVERSAL T-CODE
// ======================================================

app.get("/api/tcode", (req, res) => {
    try {
        const raw = String(req.query.tcode || "").trim().toUpperCase();
        if (!raw) {
            return jsonError(
                res,
                400,
                "Enter a SAP T-code or command such as VA03, /nVA03, /oVA01, or /*SE38."
            );
        }

        let action = "DIRECT_TCODE";
        let tcode = raw.replace(/^:/, "").trim();
        let skipInitial = false;
        const namespacedCode = /^\/[A-Z0-9_]+\/[A-Z0-9_\/-]+$/.test(raw);

        if (/^\/(NEX|NEND)$/.test(raw)) {
            action = "LOGOFF";
            tcode = "";
        } else if (/^\/I\d*$/.test(raw)) {
            action = "END_SESSION";
            tcode = "";
        } else if (/^\/H(S)?$/.test(raw)) {
            action = "DEBUG";
            tcode = "";
        } else if (raw === "/N") {
            action = "SAME_SESSION";
            tcode = "SESSION_MANAGER";
        } else if (raw === "/O") {
            action = "SESSION_LIST";
            tcode = "SESSION_MANAGER";
        } else if (raw.startsWith("/*")) {
            action = "SAME_SESSION";
            skipInitial = true;
            tcode = raw.slice(2).trim();
        } else if (raw.startsWith("/N/")) {
            action = "SAME_SESSION";
            tcode = raw.slice(2).trim();
        } else if (raw.startsWith("/O/")) {
            action = "NEW_SESSION";
            tcode = raw.slice(2).trim();
        } else if (raw.startsWith("/N") && !namespacedCode) {
            action = "SAME_SESSION";
            tcode = raw.slice(2).trim();
        } else if (raw.startsWith("/O") && !namespacedCode) {
            action = "NEW_SESSION";
            tcode = raw.slice(2).trim();
        } else if (raw.startsWith("=")) {
            action = "FUNCTION_CODE";
            tcode = raw.slice(1).trim();
        }

        if (["SAME_SESSION", "NEW_SESSION", "DIRECT_TCODE"].includes(action) && (
            !tcode || tcode.length > 40 || !/^\/?[A-Z0-9_\/-]+$/.test(tcode)
        )) {
            return jsonError(
                res,
                400,
                "That is not a valid T-code format. Enter a SAP transaction code using letters, numbers, /, _ or - (for example, SE38 or /IWFND/GW_CLIENT)."
            );
        }

        if (action === "FUNCTION_CODE" && !/^[A-Z0-9_]+$/.test(tcode)) {
            return jsonError(res, 400, "Enter a valid SAP function code such as =SAVE, =BACK, or =EXEC.");
        }

        let programToOpen = "";
        if (req.query.program !== undefined) {
            if (action !== "DIRECT_TCODE" || tcode !== "SE38") {
                return jsonError(res, 400, "A program can only be prefilled when opening SE38.");
            }
            try {
                programToOpen = validateProgramName(req.query.program);
            } catch (error) {
                return jsonError(res, 400, "Enter a valid ABAP program name.");
            }
        }

        if (demoMode) {
            return jsonError(res, 403, "Live SAP transactions are disabled in demo mode. Switch to live mode and verify the SAP connection before launching a T-code.");
        }

        const webguiPath = "/sap/bc/gui/sap/its/webgui";
        const client = encodeURIComponent(process.env.SAP_CLIENT || "");
        let url = "";
        if (action === "LOGOFF" || action === "END_SESSION") {
            const sapCommand = action === "LOGOFF" ? "logoff" : "endofsession";
            url = `${webguiPath}?~command=${sapCommand}&~exitURL=%2F&sap-client=${client}`;
        } else if (action === "DEBUG" || action === "FUNCTION_CODE") {
            url = "";
        } else {
            const transaction = programToOpen
                ? `SE38 RS38M-PROGRAMM=${programToOpen}`
                : `${skipInitial ? "*" : ""}${tcode}`;
            url = `${webguiPath}?~transaction=${encodeURIComponent(transaction)}&sap-client=${client}&~noHeaderOkCode=0`;
        }

        return res.json({
            success: true,
            action,
            skipInitial,
            tcode,
            url
        });

    } catch (error) {
        return jsonError(
            res,
            500,
            error
        );
    }
});


// ======================================================
// SAP WEBGUI PROXY
// MUST BE REGISTERED BEFORE BODY PARSERS.
// Handles both /sap/... and /sap(<session>)/...
// ======================================================

function proxySapRequest(req, res) {
    try {
        requireSapConfig();

        const original =
            req.originalUrl;

        const target =
            new URL(
                `${sapBaseUrl()}${original}`
            );

        const headers = {
            ...req.headers
        };

        headers.host =
            target.host;

        headers.authorization =
            "Basic " +
            Buffer.from(
                `${process.env.SAP_USERNAME}:${process.env.SAP_PASSWORD}`
            ).toString(
                "base64"
            );

        headers.connection =
            "close";

        const request =
            https.request(
                {
                    protocol:
                        target.protocol,
                    hostname:
                        target.hostname,
                    port:
                        target.port || 443,
                    method:
                        req.method,
                    path:
                        target.pathname +
                        target.search,
                    headers,
                    agent:
                        sapHttpsAgent,
                    timeout:
                        60000
                },
                sapRes => {

                    res.statusCode =
                        sapRes.statusCode || 502;

                    for (
                        const [key, value]
                        of Object.entries(
                            sapRes.headers
                        )
                    ) {

                        if (
                            value === undefined ||
                            value === null
                        ) continue;

                        if (
                            key.toLowerCase() ===
                            "location"
                        ) {

                            const values =
                                Array.isArray(value)
                                    ? value
                                    : [value];

                            res.setHeader(
                                "location",
                                values.map(
                                    location => {

                                        try {

                                            const url =
                                                new URL(
                                                    location
                                                );

                                            if (
                                                url.hostname ===
                                                    target.hostname &&
                                                String(
                                                    url.port ||
                                                    443
                                                ) ===
                                                    String(
                                                        target.port ||
                                                        443
                                                    )
                                            ) {

                                                return (
                                                    url.pathname +
                                                    url.search +
                                                    url.hash
                                                );

                                            }

                                        } catch (_) {}

                                        return location;
                                    }
                                )
                            );

                        } else {

                            res.setHeader(
                                key,
                                value
                            );

                        }

                    }

                    sapRes.pipe(res);
                }
            );

        request.on(
            "timeout",
            () =>
                request.destroy(
                    new Error(
                        "SAP WebGUI proxy timeout"
                    )
                )
        );

        request.on(
            "error",
            error => {

                if (
                    !res.headersSent
                ) {

                    res.status(
                        502
                    )
                        .type(
                            "text/plain"
                        )
                        .send(
                            `SAP WebGUI proxy error: ${error.message}`
                        );

                } else {

                    res.end();

                }
            }
        );

        req.pipe(
            request
        );

    } catch (error) {

        return res
            .status(500)
            .type("text/plain")
            .send(
                `SAP WebGUI proxy configuration error: ${error.message}`
            );
    }
}


// ======================================================
// FRONTEND STATIC FILES
// ======================================================

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);

    if (error?.type === "entity.too.large" || error?.status === 413) {
        return jsonError(res, 413, "Request body is too large.");
    }
    if (error?.type === "entity.parse.failed") {
        return jsonError(res, 400, "Request body contains invalid JSON.");
    }

    console.error(
        "Unhandled request error:",
        error?.code || error?.name || "Error"
    );
    if (req.path.startsWith("/api/")) {
        return jsonError(res, 500, "Internal server error.");
    }
    return res.status(500).type("text/plain").send("Internal server error.");
});

app.use(
    "/api",
    (req, res) => jsonError(res, 404, "API route not found.")
);

app.use(
    express.static(
        frontendPath
    )
);

app.get(
    "/",
    (req, res) => {
        res.sendFile(
            path.join(
                frontendPath,
                "index.html"
            )
        );
    }
);

// ======================================================
// START
// ======================================================

validateRuntimeConfig();

const server = app.listen(
    PORT,
    HOST,
    () => {
        console.log(
            `SAP Web Development Workbench listening on ${HOST}:${PORT}`
        );
    }
);

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        server.close(error => {
            if (error) {
                console.error("Server shutdown failed:", error);
                process.exitCode = 1;
            }
        });
    });
}
