const fs = require("node:fs/promises");
const path = require("node:path");
const { selectXmlEntries } = require("./toc-client.cjs");

const namespaceUri = "http://www.blizzard.com/wow/ui/";
const element = localName => ({ namespaceUri, localName });
const policy = {
    roots: [element("Ui")],
    frameElements: [],
    includeElements: [element("Include")],
    scriptElements: [element("Script")],
    handlerContainers: [],
    handlerElements: [],
};
const decoder = new TextDecoder("utf-8", { fatal: true });

function relativeParts(value) {
    if (!value || value !== value.trim() || /[\u0000-\u001f<>:"|?*\[\]]/.test(value)) return undefined;
    const parts = value.split(/[\\/]/);
    if (parts.some(part => !part || part === ".." || /[ .]$/.test(part) && part !== ".")) return undefined;
    return parts.filter(part => part !== ".");
}

async function lookup(root, value, relativeDirectory = ".") {
    const parts = relativeParts(value);
    if (!parts?.length) return { status: "unverifiable" };
    // References are relative to the XML file. Recheck the entire path from the add-on root.
    const segments = [...relativeDirectory.split(path.sep).filter(part => part !== "."), ...parts];
    let current = root;
    for (const [index, part] of segments.entries()) {
        current = path.join(current, part);
        try {
            const item = await fs.lstat(current);
            // A link can change path resolution or leave the selected add-on.
            if (item.isSymbolicLink()) return { status: "unverifiable" };
            if (index === segments.length - 1) {
                return item.isFile() ? { status: "found", file: current } : { status: "unverifiable" };
            }
            if (!item.isDirectory()) return { status: "unverifiable" };
        } catch (error) {
            return { status: error.code === "ENOENT" ? "missing" : "unverifiable" };
        }
    }
}

async function findMissingXmlReferences(directory, manifestName, sdk, report = () => {}, settings = {}) {
    const root = await fs.realpath(directory);
    const manifest = await lookup(root, manifestName);
    if (manifest.status !== "found") return [];
    const text = decoder.decode(await fs.readFile(manifest.file));
    const { metadata, diagnostics } = sdk.parseToc(text, manifest.file);
    if (diagnostics.some(issue => issue.severity === "error")) {
        report("XML reference check skipped because the selected TOC contains errors.");
        return [];
    }

    const pending = [];
    const manifestMissing = [];
    for (const { entry, expanded } of selectXmlEntries(metadata, settings)) {
        const source = await lookup(root, expanded);
        if (source.status === "found") pending.push(source.file);
        if (source.status === "missing") {
            manifestMissing.push({ kind: "toc", target: { value: expanded, source: entry.source } });
        }
    }

    const visited = new Set();
    const results = manifestMissing.length ? [{ file: path.join(directory, manifestName), missing: manifestMissing }] : [];
    while (pending.length) {
        const source = pending.pop();
        const identity = process.platform === "win32" ? source.toLowerCase() : source;
        if (visited.has(identity)) continue;
        visited.add(identity);

        const name = path.relative(root, source);
        let text;
        try {
            text = decoder.decode(await fs.readFile(source));
        } catch (error) {
            report(name + ": unable to read XML (" + (error.code || error.name) + ").");
            continue;
        }
        const file = path.join(directory, name);
        const analysis = sdk.analyzeXml(text, file, { addonId: path.basename(directory), policy });
        if (!analysis.complete) {
            report(name + ": incomplete XML analysis. See XML diagnostics for syntax or schema issues.");
            continue;
        }

        const missing = [];
        for (const reference of analysis.references) {
            const target = await lookup(root, reference.target.value, path.dirname(name));
            if (target.status === "missing") missing.push(reference);
            if (target.status === "found" && reference.kind === "include" && /\.xml$/i.test(target.file)) {
                pending.push(target.file);
            }
        }
        if (missing.length) results.push({ file, missing });
    }
    return results;
}

module.exports = { findMissingXmlReferences };
