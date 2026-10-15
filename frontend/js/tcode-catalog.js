/* Curated classic SAP transactions used by the functional T-code directory. */
window.SAP_FUNCTIONAL_TCODE_MODULES = Object.freeze([
    { code: "ABAP", name: "ABAP Workbench and Basis", aliases: ["BASIS", "DEVELOPMENT", "DICTIONARY", "TRANSPORT", "ADMINISTRATION"] },
    { code: "HCM", name: "Human Capital Management", aliases: ["HR", "PERSONNEL", "EMPLOYEE", "TIME MANAGEMENT"] },
    { code: "MM", name: "Materials Management", aliases: ["PROCUREMENT", "PURCHASING", "INVENTORY", "MATERIAL"] },
    { code: "SD", name: "Sales and Distribution", aliases: ["SALES", "ORDER", "DELIVERY", "BILLING"] },
    { code: "PP/QM", name: "Production Planning and Quality Management", aliases: ["PPQM", "PRODUCTION", "MANUFACTURING", "QUALITY", "MRP"] },
    { code: "FI/CO", name: "Financial Accounting and Controlling", aliases: ["FICO", "FINANCE", "ACCOUNTING", "CONTROLLING", "COST CENTER"] }
].map(module => Object.freeze({ ...module, aliases: Object.freeze(module.aliases) })));

window.SAP_FUNCTIONAL_TCODE_CATALOG = Object.freeze([
    { code: "SE11", desc: "ABAP Dictionary", module: "ABAP" },
    { code: "SE16N", desc: "General Table Display", module: "ABAP" },
    { code: "SE38", desc: "ABAP Editor", module: "ABAP" },
    { code: "SE51", desc: "Screen Painter for Module Pool / Dynpro Layouts", module: "ABAP" },
    { code: "SE37", desc: "Function Builder", module: "ABAP" },
    { code: "SE80", desc: "Object Navigator", module: "ABAP" },
    { code: "SE24", desc: "Class Builder", module: "ABAP" },
    { code: "SE41", desc: "Menu Painter (GUI Status and Menus)", module: "ABAP" },
    { code: "SE18", desc: "BAdI Definitions", module: "ABAP" },
    { code: "SE19", desc: "BAdI Implementations", module: "ABAP" },
    { code: "SE09", desc: "Transport Organizer", module: "ABAP" },
    { code: "SE10", desc: "Customizing Organizer", module: "ABAP" },
    { code: "SE93", desc: "Transaction Code Maintenance", module: "ABAP" },
    { code: "SMARTFORMS", desc: "Smart Forms Designer and Layout", module: "ABAP" },
    { code: "SMARTSTYLES", desc: "Smart Forms Styles", module: "ABAP" },
    { code: "SM30", desc: "View/Table Maintenance", module: "ABAP" },
    { code: "SM37", desc: "Background Job Monitor", module: "ABAP" },
    { code: "SM50", desc: "Work Process Overview", module: "ABAP" },
    { code: "SM59", desc: "RFC Destinations", module: "ABAP" },
    { code: "ST05", desc: "Performance Trace", module: "ABAP" },
    { code: "ST22", desc: "ABAP Runtime Error Analysis", module: "ABAP" },
    { code: "SU01", desc: "User Maintenance", module: "ABAP" },
    { code: "SICF", desc: "HTTP Service Maintenance", module: "ABAP" },
    { code: "WE02", desc: "IDoc Display", module: "ABAP" },
    { code: "WE19", desc: "IDoc Test Tool", module: "ABAP" },

    { code: "PA20", desc: "Display HR master data", module: "HCM" },
    { code: "PA30", desc: "Maintain HR master data", module: "HCM" },
    { code: "PA40", desc: "Personnel actions", module: "HCM" },
    { code: "PPOME", desc: "Change organizational plan", module: "HCM" },
    { code: "PPOCE", desc: "Create organizational plan", module: "HCM" },
    { code: "PT60", desc: "Time evaluation", module: "HCM" },

    { code: "MM01", desc: "Create material master", module: "MM" },
    { code: "MM02", desc: "Change material master", module: "MM" },
    { code: "MM03", desc: "Display material master", module: "MM" },
    { code: "ME51N", desc: "Create purchase requisition", module: "MM" },
    { code: "ME52N", desc: "Change purchase requisition", module: "MM" },
    { code: "ME53N", desc: "Display purchase requisition", module: "MM" },
    { code: "ME21N", desc: "Create purchase order", module: "MM" },
    { code: "ME22N", desc: "Change purchase order", module: "MM" },
    { code: "ME23N", desc: "Display purchase order", module: "MM" },
    { code: "MIGO", desc: "Goods movement", module: "MM" },
    { code: "MIRO", desc: "Enter incoming invoice", module: "MM" },
    { code: "MMBE", desc: "Stock overview", module: "MM" },
    { code: "MB51", desc: "Material document list", module: "MM" },

    { code: "VA01", desc: "Create sales order", module: "SD" },
    { code: "VA02", desc: "Change sales order", module: "SD" },
    { code: "VA03", desc: "Display sales order", module: "SD" },
    { code: "VL01N", desc: "Create outbound delivery", module: "SD" },
    { code: "VL02N", desc: "Change outbound delivery", module: "SD" },
    { code: "VL03N", desc: "Display outbound delivery", module: "SD" },
    { code: "VF01", desc: "Create billing document", module: "SD" },
    { code: "VF02", desc: "Change billing document", module: "SD" },
    { code: "VF03", desc: "Display billing document", module: "SD" },
    { code: "VK11", desc: "Create pricing condition", module: "SD" },
    { code: "VK12", desc: "Change pricing condition", module: "SD" },
    { code: "VK13", desc: "Display pricing condition", module: "SD" },

    { code: "MD01", desc: "Run MRP", module: "PP/QM" },
    { code: "MD02", desc: "Run single-item, multilevel MRP", module: "PP/QM" },
    { code: "MD04", desc: "Display stock and requirements", module: "PP/QM" },
    { code: "CS01", desc: "Create bill of material", module: "PP/QM" },
    { code: "CS02", desc: "Change bill of material", module: "PP/QM" },
    { code: "CS03", desc: "Display bill of material", module: "PP/QM" },
    { code: "CA01", desc: "Create routing", module: "PP/QM" },
    { code: "CA02", desc: "Change routing", module: "PP/QM" },
    { code: "CA03", desc: "Display routing", module: "PP/QM" },
    { code: "CR01", desc: "Create work center", module: "PP/QM" },
    { code: "CO01", desc: "Create production order", module: "PP/QM" },
    { code: "CO02", desc: "Change production order", module: "PP/QM" },
    { code: "CO03", desc: "Display production order", module: "PP/QM" },
    { code: "QA01", desc: "Create inspection lot", module: "PP/QM" },
    { code: "QA32", desc: "Worklist for inspection lots", module: "PP/QM" },
    { code: "QE51N", desc: "Record inspection results", module: "PP/QM" },

    { code: "FB50", desc: "Post G/L account document", module: "FI/CO" },
    { code: "FB03", desc: "Display accounting document", module: "FI/CO" },
    { code: "FB60", desc: "Enter vendor invoice", module: "FI/CO" },
    { code: "FBL1N", desc: "Vendor line item display", module: "FI/CO" },
    { code: "FBL3N", desc: "G/L account line item display", module: "FI/CO" },
    { code: "FBL5N", desc: "Customer line item display", module: "FI/CO" },
    { code: "F110", desc: "Automatic payment run", module: "FI/CO" },
    { code: "FS00", desc: "Maintain G/L account master", module: "FI/CO" },
    { code: "KSB1", desc: "Cost center actual line items", module: "FI/CO" },
    { code: "KOB1", desc: "Order actual line items", module: "FI/CO" },
    { code: "KS01", desc: "Create cost center", module: "FI/CO" },
    { code: "KO01", desc: "Create internal order", module: "FI/CO" },
    { code: "KE30", desc: "Execute profitability report", module: "FI/CO" }
].map(item => Object.freeze(item)));

window.SAP_GUI_COMMAND_PARSER = Object.freeze({
    parse(value) {
        const raw = String(value || "").trim();
        const upper = raw.toUpperCase();
        if (!upper) return { action: "EMPTY", raw };
        if (/^\/(NEX|NEND)$/.test(upper)) return { action: "LOGOFF", raw };
        if (/^\/I\d*$/.test(upper)) return { action: "END_SESSION", raw };
        if (/^\/H(S)?$/.test(upper)) return { action: "DEBUG", raw };
        if (upper === "/N") return { action: "SAME_SESSION", tcode: "SESSION_MANAGER", raw };
        if (upper === "/O") return { action: "SESSION_LIST", tcode: "SESSION_MANAGER", raw };
        if (upper.startsWith("/*")) return { action: "SAME_SESSION", tcode: upper.slice(2).trim(), skipInitial: true, raw };
        if (upper.startsWith("/N/")) return { action: "SAME_SESSION", tcode: upper.slice(2).trim(), raw };
        if (upper.startsWith("/O/")) return { action: "NEW_SESSION", tcode: upper.slice(2).trim(), raw };
        const namespacedCode = /^\/[A-Z0-9_]+\/[A-Z0-9_/-]+$/.test(upper);
        if (upper.startsWith("/N") && !namespacedCode) return { action: "SAME_SESSION", tcode: upper.slice(2).trim(), raw };
        if (upper.startsWith("/O") && !namespacedCode) return { action: "NEW_SESSION", tcode: upper.slice(2).trim(), raw };
        if (upper.startsWith("=")) return { action: "FUNCTION_CODE", functionCode: upper.slice(1).trim(), raw };
        return { action: "DIRECT_TCODE", tcode: upper.replace(/^:/, "").trim(), raw };
    },
    buildUrl(parsed) {
        const params = new URLSearchParams();
        if (parsed.action === "DIRECT_TCODE") params.set("tcode", parsed.tcode);
        else params.set("command", parsed.raw);
        if (parsed.skipInitial) params.set("skip", "1");
        return `/transaction.html?${params.toString()}`;
    }
});
