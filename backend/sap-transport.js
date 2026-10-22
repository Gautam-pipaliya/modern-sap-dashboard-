"use strict";

const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const tls = require("node:tls");

const projectRoot = path.resolve(__dirname, "..");
const verifySapTls =
    String(process.env.SAP_TLS_REJECT_UNAUTHORIZED || "true").toLowerCase() !== "false";

if (process.env.NODE_ENV === "production" && !verifySapTls) {
    throw new Error(
        "Production requires SAP TLS verification. Configure the SAP CA certificate instead of disabling verification."
    );
}

function readSystemCertificates() {
    if (typeof tls.getCACertificates !== "function") return [];
    try {
        return tls.getCACertificates("system");
    } catch (_) {
        // Some Node versions and platforms do not expose the OS CA store.
        return [];
    }
}

function readConfiguredCertificate(value) {
    const configured = String(value || "").trim();
    if (!configured) return "";
    if (configured.includes("-----BEGIN CERTIFICATE-----")) {
        return configured.replace(/\\n/g, "\n");
    }

    const certificatePath = path.resolve(projectRoot, configured);
    try {
        return fs.readFileSync(certificatePath, "utf8").trim();
    } catch (error) {
        throw new Error(`Unable to read SAP_CA_CERT as PEM content or a file path: ${error.message}`);
    }
}

function loadSapCertificates() {
    const certificates = [...tls.rootCertificates, ...readSystemCertificates()];
    const bundledCertificatePath = path.join(projectRoot, "certs", "sap-server.pem");
    if (fs.existsSync(bundledCertificatePath)) {
        certificates.push(fs.readFileSync(bundledCertificatePath, "utf8").trim());
    }

    const configuredCertificate = readConfiguredCertificate(process.env.SAP_CA_CERT);
    if (configuredCertificate) certificates.push(configuredCertificate);

    return [...new Set(certificates.filter(Boolean))];
}

function createSapHttpProxy() {
    const value = process.env.SAP_HTTP_PROXY;
    if (!value) return false;

    let proxy;
    try {
        proxy = new URL(value);
    } catch (_) {
        throw new Error("SAP_HTTP_PROXY must be a valid HTTP or HTTPS URL.");
    }
    if (!["http:", "https:"].includes(proxy.protocol) || !proxy.hostname) {
        throw new Error("SAP_HTTP_PROXY must use HTTP or HTTPS and include a host.");
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

function sapConnectionError(error) {
    const tlsCode = error?.code;
    if (tlsCode === "ERR_TLS_CERT_ALTNAME_INVALID") {
        return new Error(
            "The SAP certificate name does not match SAP_BASE_URL. Configure the DNS name covered by the certificate, or ask SAP Basis for a certificate whose Subject Alternative Name includes the SAP endpoint."
        );
    }
    if (tlsCode === "CERT_HAS_EXPIRED") {
        return new Error(
            "The SAP HTTPS certificate has expired. Ask SAP Basis to renew the certificate and provide the approved CA chain. Keep TLS verification enabled."
        );
    }
    if ([
        "SELF_SIGNED_CERT_IN_CHAIN",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
    ].includes(tlsCode)) {
        return new Error(
            "SAP's certificate chain is not trusted by Node.js or the operating system certificate store. Ask SAP Basis for the approved root/intermediate CA certificate in PEM format, confirm its Subject Alternative Name covers SAP_BASE_URL, then configure SAP_CA_CERT and keep SAP_TLS_REJECT_UNAUTHORIZED=true."
        );
    }

    let endpoint = "the configured SAP endpoint";
    try {
        const url = new URL(process.env.SAP_BASE_URL || "");
        endpoint = `${url.hostname}:${url.port || 443}`;
    } catch (_) {
        // Leave the diagnostic generic when the endpoint itself is invalid.
    }

    if (tlsCode === "ECONNREFUSED") {
        return new Error(
            `The SAP endpoint ${endpoint} refused the connection. Verify SAP_BASE_URL, the service port, and the network/firewall route.`
        );
    }
    if (["ETIMEDOUT", "ECONNABORTED"].includes(tlsCode)) {
        return new Error(
            `Connection to SAP at ${endpoint} timed out. Check network/firewall access and the SAP service port.`
        );
    }
    if (["ENOTFOUND", "EAI_AGAIN"].includes(tlsCode)) {
        return new Error(
            `Could not resolve the SAP host in ${endpoint}. Check SAP_BASE_URL and the DNS/network configuration.`
        );
    }
    return error;
}

const sapHttpsAgent = new https.Agent({
    rejectUnauthorized: verifySapTls,
    ca: loadSapCertificates(),
    keepAlive: true,
    maxSockets: 20,
    maxFreeSockets: 5,
    ...(process.env.SAP_TLS_SERVERNAME
        ? { servername: process.env.SAP_TLS_SERVERNAME }
        : {})
});

module.exports = Object.freeze({
    verifySapTls,
    sapHttpsAgent,
    sapAxiosProxy: createSapHttpProxy(),
    sapConnectionError
});
