const fs = require("node:fs/promises");
const path = require("node:path");
const { selectTocFileEntries } = require("./toc-client.cjs");

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

async function inspectAddonSources(directory, manifestName, sdk, settings = {}, { repeatIncludes = true } = {}) {
    const root = await fs.realpath(directory);
    const manifest = await lookup(root, manifestName);
    const result = { manifestStatus: manifest.status, notes: [], parserErrors: [], savedVariables: [], files: [], skippedTocEntries: 0 };
    if (manifest.status !== "found") return result;

    const manifestFile = path.join(directory, manifestName);
    const text = decoder.decode(await fs.readFile(manifest.file));
    const parsed = sdk.parseToc(text, manifestFile);
    result.parserErrors = parsed.diagnostics.filter(issue => issue.severity === "error");
    if (result.parserErrors.length) {
        result.manifestStatus = "invalid";
        result.notes.push("File reference check skipped because the selected TOC contains errors.");
        return result;
    }

    result.savedVariables = parsed.metadata.savedVariableDeclarations;
    const selected = selectTocFileEntries(parsed, settings);
    result.skippedTocEntries = parsed.metadata.fileEntries.length - selected.length;
    const expandedXml = new Set();
    const ancestors = new Set();
    const xmlCache = new Map();
    const maxReportEntries = 10000;

    async function readXml(identity, physicalFile, displayFile) {
        if (xmlCache.has(identity)) return xmlCache.get(identity);
        const name = path.relative(directory, displayFile);
        let text;
        try {
            text = decoder.decode(await fs.readFile(physicalFile));
        } catch (error) {
            result.notes.push(name + ": unable to read XML (" + (error.code || error.name) + ").");
            xmlCache.set(identity, undefined);
            return undefined;
        }
        const analysis = sdk.analyzeXml(text, displayFile, { addonId: path.basename(directory), policy });
        if (!analysis.complete) {
            result.notes.push(name + ": incomplete XML analysis. See XML diagnostics for syntax or schema issues.");
        }
        const references = analysis.complete ? analysis.references : undefined;
        xmlCache.set(identity, references);
        return references;
    }

    async function visit(kind, target, relativeDirectory, depth) {
        if (result.truncated) return;
        if (repeatIncludes && result.files.length >= maxReportEntries) {
            result.truncated = true;
            result.notes.push("Report stopped after " + maxReportEntries + " file references.");
            return;
        }
        const resolved = await lookup(root, target.value, relativeDirectory);
        const relativeFile = resolved.file && path.relative(root, resolved.file);
        const file = relativeFile && path.join(directory, relativeFile);
        const row = { kind, target, file, depth, status: resolved.status };
        result.files.push(row);

        if (!file || (kind !== "toc" && kind !== "include") || !/\.xml$/i.test(file)) return;
        const identity = process.platform === "win32" ? resolved.file.toLowerCase() : resolved.file;
        if (ancestors.has(identity)) {
            row.status = "cycle";
            return;
        }
        if (!repeatIncludes && expandedXml.has(identity)) return;
        expandedXml.add(identity);
        ancestors.add(identity);
        try {
            const references = await readXml(identity, resolved.file, file);
            if (!references) {
                row.status = "incomplete";
                return;
            }
            for (const reference of references) {
                if (result.truncated) break;
                await visit(reference.kind, reference.target, path.dirname(relativeFile), depth + 1);
            }
        } finally {
            ancestors.delete(identity);
        }
    }

    for (const { entry, expanded } of selected) {
        if (result.truncated) break;
        const kind = /\.xml$/i.test(expanded) ? "toc" : "toc-lua";
        await visit(kind, { value: expanded, source: entry.source }, ".", 0);
    }
    return result;
}

async function findFileReferenceProblems(directory, manifestName, sdk, report = () => {}, settings = {}) {
    const result = await inspectAddonSources(directory, manifestName, sdk, settings, { repeatIncludes: false });
    for (const note of result.notes) report(note);
    const missingByFile = new Map();
    for (const { kind, target, status } of result.files) {
        if (status !== "missing") continue;
        const list = missingByFile.get(target.source.file) ?? [];
        list.push({ kind, target });
        missingByFile.set(target.source.file, list);
    }
    return {
        missingByFile: [...missingByFile].map(([file, missing]) => ({ file, missing })),
        parserErrors: result.parserErrors,
    };
}

module.exports = { findFileReferenceProblems, inspectAddonSources };
