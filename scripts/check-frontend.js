const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const file = path.join(__dirname, "..", "frontend", "index.html");
const frontendRoot = path.dirname(file);
const html = fs.readFileSync(file, "utf8");
const scriptTag = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
let checked = 0;
let inlineChecked = 0;
let externalChecked = 0;
let match;

while ((match = scriptTag.exec(html)) !== null) {
    const attributes = match[1];
    const source = match[2].trim();
    const isExternal = /\bsrc\s*=/i.test(attributes);
    const type = attributes.match(/\btype\s*=\s*["']?([^\s"'>]+)/i)?.[1]?.toLowerCase();
    const isJavaScript = !type || ["text/javascript", "application/javascript", "module"].includes(type);
    if (!isJavaScript) continue;

    if (isExternal) {
        const sourceAttribute = attributes.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
        const sourceUrl = sourceAttribute?.[1];
        if (!sourceUrl || /^(?:https?:)?\/\//i.test(sourceUrl)) continue;

        const relativePath = decodeURIComponent(sourceUrl.split(/[?#]/, 1)[0]).replace(/^\/+/, "");
        const sourcePath = path.resolve(frontendRoot, relativePath);
        if (!sourcePath.startsWith(`${frontendRoot}${path.sep}`)) {
            console.error(`External script path escapes the frontend directory: ${sourceUrl}`);
            process.exitCode = 1;
            break;
        }
        if (path.extname(sourcePath).toLowerCase() !== ".js") continue;

        try {
            new vm.Script(fs.readFileSync(sourcePath, "utf8"), { filename: sourcePath });
        } catch (error) {
            console.error(error.message);
            process.exitCode = 1;
            break;
        }
        checked += 1;
        externalChecked += 1;
        continue;
    }

    if (!source) continue;

    try {
        new vm.Script(source, { filename: `${file} (inline script ${checked + 1})` });
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
        break;
    }
    checked += 1;
    inlineChecked += 1;
}

if (!checked && !process.exitCode) {
    console.error(`No inline JavaScript found in ${file}`);
    process.exitCode = 1;
} else if (!process.exitCode) {
    const inlineLabel = `${inlineChecked} inline script${inlineChecked === 1 ? "" : "s"}`;
    const externalLabel = `${externalChecked} local external script${externalChecked === 1 ? "" : "s"}`;
    console.log(`Frontend JavaScript syntax OK (${inlineLabel}, ${externalLabel}).`);
}
