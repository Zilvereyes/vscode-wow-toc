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
const defaultSecurityLimits = Object.freeze({
    maxReferences: 10000,
    maxXmlFiles: 1000,
    maxDepth: 100,
    maxFileBytes: 8 * 1024 * 1024,
    maxTotalBytes: 64 * 1024 * 1024,
    maxDiagnostics: 1000,
});

function securityLimits(overrides = {}) {
    return { ...defaultSecurityLimits, ...overrides };
}

function truncate(result, message) {
    if (result.truncated) return;
    result.truncated = true;
    result.truncationMessage = message;
    result.notes.push(message);
}

function relativeParts(value) {
    if (!value || value !== value.trim() || /[\u0000-\u001f<>:"|?*\[\]]/.test(value)) return undefined;
    const parts = value.split(/[\\/]/);
    if (parts.some(part => !part || part === ".." || /[ .]$/.test(part) && part !== ".")) return undefined;
    return parts.filter(part => part !== ".");
}

function checkCancellation(signal) {
    if (!signal?.aborted) return;
    const error = new Error("XML reference check cancelled.");
    error.name = "AbortError";
    throw error;
}

async function lookup(root, value, relativeDirectory = ".", signal) {
    checkCancellation(signal);
    const parts = relativeParts(value);
    if (!parts?.length) return { status: "unverifiable" };
    // References are relative to the XML file. Recheck the entire path from the add-on root.
    const segments = [...relativeDirectory.split(path.sep).filter(part => part !== "."), ...parts];
    let current = root;
    for (const [index, part] of segments.entries()) {
        checkCancellation(signal);
        current = path.join(current, part);
        let item;
        try {
            item = await fs.lstat(current, { bigint: true });
        } catch (error) {
            return { status: error.code === "ENOENT" ? "missing" : "unverifiable" };
        }
        checkCancellation(signal);
        // A link can change path resolution or leave the selected add-on.
        if (item.isSymbolicLink()) return { status: "unverifiable" };
        if (index === segments.length - 1) {
            // Device and inode collapse path aliases to one physical-file identity on every platform.
            return item.isFile()
                ? { status: "found", file: current, identity: item.dev.toString() + ":" + item.ino.toString() }
                : { status: "unverifiable" };
        }
        if (!item.isDirectory()) return { status: "unverifiable" };
    }
}

async function inspectAddonSources(directory, manifestName, sdk, settings = {}, options = {}) {
    const { repeatIncludes = true, signal, isCancelled = () => false } = options;
    const limits = securityLimits(options.limits);
    checkCancellation(signal);
    if (isCancelled()) return { manifestStatus: "cancelled", notes: [], parserErrors: [], savedVariables: [], files: [], skippedTocEntries: 0, cancelled: true };
    const root = await fs.realpath(directory);
    checkCancellation(signal);
    const manifest = await lookup(root, manifestName, ".", signal);
    const result = { manifestStatus: manifest.status, notes: [], parserErrors: [], savedVariables: [], files: [], skippedTocEntries: 0 };
    if (manifest.status === "cancelled") {
        result.cancelled = true;
        return result;
    }
    if (manifest.status !== "found") return result;

    let totalBytes = 0;

    function continueScan() {
        checkCancellation(signal);
        if (!result.cancelled && isCancelled()) result.cancelled = true;
        return !result.cancelled && !result.truncated;
    }

    async function readText(physicalFile, displayFile) {
        if (!continueScan()) return undefined;
        const name = path.relative(directory, displayFile) || path.basename(displayFile);
        const remaining = limits.maxTotalBytes - totalBytes;
        if (remaining <= 0) {
            truncate(result, "Reference check stopped after reading " + limits.maxTotalBytes + " bytes in total.");
            return undefined;
        }

        const handle = await fs.open(physicalFile, "r");
        try {
            const stat = await handle.stat();
            if (stat.size > limits.maxFileBytes) {
                truncate(result, "Reference check stopped because " + name + " exceeds the " +
                    limits.maxFileBytes + " byte per-file limit.");
                return undefined;
            }
            if (stat.size > remaining) {
                truncate(result, "Reference check stopped before exceeding the " +
                    limits.maxTotalBytes + " byte total-file limit.");
                return undefined;
            }

            const allowed = Math.min(limits.maxFileBytes, remaining);
            const buffer = Buffer.alloc(Math.min(64 * 1024, allowed + 1));
            const chunks = [];
            let length = 0;
            while (continueScan()) {
                const { bytesRead } = await handle.read(buffer, 0,
                    Math.min(buffer.length, allowed - length + 1), null);
                if (!bytesRead) break;
                if (length + bytesRead > allowed) {
                    const message = allowed === limits.maxFileBytes
                        ? "Reference check stopped because " + name + " exceeds the " +
                            limits.maxFileBytes + " byte per-file limit."
                        : "Reference check stopped before exceeding the " +
                            limits.maxTotalBytes + " byte total-file limit.";
                    truncate(result, message);
                    return undefined;
                }
                chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
                length += bytesRead;
            }
            if (!continueScan()) return undefined;
            totalBytes += length;
            return decoder.decode(Buffer.concat(chunks, length));
        } finally {
            await handle.close();
        }
    }

    const manifestFile = path.join(directory, manifestName);
    const text = await readText(manifest.file, manifestFile);
    if (text === undefined) return result;
    const parsed = sdk.parseToc(text, manifestFile);
    if (!continueScan()) return result;
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
    let parsedXmlReferences = 0;

    async function readXml(identity, physicalFile, displayFile) {
        if (xmlCache.has(identity)) return xmlCache.get(identity);
        const name = path.relative(directory, displayFile);
        let text;
        try {
            text = await readText(physicalFile, displayFile);
        } catch (error) {
            checkCancellation(signal);
            result.notes.push(name + ": unable to read XML (" + (error.code || error.name) + ").");
            xmlCache.set(identity, undefined);
            return undefined;
        }
        if (text === undefined) return undefined;
        const analysis = sdk.analyzeXml(text, displayFile, { addonId: path.basename(directory), policy });
        if (!continueScan()) return undefined;
        if (!analysis.complete) {
            result.notes.push(name + ": incomplete XML analysis. See XML diagnostics for syntax or schema issues.");
        }
        const references = analysis.complete ? analysis.references : undefined;
        if (references && references.length > limits.maxReferences - parsedXmlReferences) {
            truncate(result, "Reference check stopped before retaining more than " +
                limits.maxReferences + " parsed XML references.");
            return undefined;
        }
        parsedXmlReferences += references?.length ?? 0;
        xmlCache.set(identity, references);
        return references;
    }

    async function visit(kind, target, relativeDirectory, depth) {
        if (!continueScan()) return;
        if (repeatIncludes && result.files.length >= maxReportEntries) {
            truncate(result, "Report stopped after " + maxReportEntries + " file references.");
            return;
        }
        if (result.files.length >= limits.maxReferences) {
            truncate(result, "Reference check stopped after " + limits.maxReferences + " file references.");
            return;
        }
        if (depth > limits.maxDepth) {
            truncate(result, "Reference check stopped at the maximum XML depth of " + limits.maxDepth + ".");
            return;
        }
        const resolved = await lookup(root, target.value, relativeDirectory, signal);
        if (!continueScan()) return;
        const relativeFile = resolved.file && path.relative(root, resolved.file);
        const file = relativeFile && path.join(directory, relativeFile);
        const row = { kind, target, file, depth, status: resolved.status };
        if (!file || (kind !== "toc" && kind !== "include") || !/\.xml$/i.test(file)) {
            result.files.push(row);
            return;
        }
        const identity = resolved.identity;
        if (ancestors.has(identity)) {
            row.status = "cycle";
            result.files.push(row);
            return;
        }
        if (!repeatIncludes && expandedXml.has(identity)) {
            result.files.push(row);
            return;
        }
        if (!xmlCache.has(identity) && xmlCache.size >= limits.maxXmlFiles) {
            truncate(result, "Reference check stopped after " + limits.maxXmlFiles + " unique XML files.");
            return;
        }
        result.files.push(row);
        expandedXml.add(identity);
        ancestors.add(identity);
        try {
            const references = await readXml(identity, resolved.file, file);
            if (!continueScan()) return;
            if (!references) {
                row.status = "incomplete";
                return;
            }
            for (const reference of references) {
                if (!continueScan()) break;
                await visit(reference.kind, reference.target, path.dirname(relativeFile), depth + 1);
            }
        } finally {
            ancestors.delete(identity);
        }
    }

    for (const { entry, expanded } of selected) {
        if (!continueScan()) break;
        const kind = /\.xml$/i.test(expanded) ? "toc" : "toc-lua";
        await visit(kind, { value: expanded, source: entry.source }, ".", 0);
    }
    return result;
}

async function findFileReferenceProblems(directory, manifestName, sdk, report = () => {}, settings = {}, options = {}) {
    const limits = securityLimits(options.limits);
    const result = await inspectAddonSources(directory, manifestName, sdk, settings, { ...options, repeatIncludes: false, limits });
    if (result.cancelled) return { missingByFile: [], parserErrors: [], cancelled: true };
    const maxProblemDiagnostics = Math.max(0, limits.maxDiagnostics - 1);
    const parserErrors = result.parserErrors.slice(0, maxProblemDiagnostics);
    if (parserErrors.length !== result.parserErrors.length) {
        truncate(result, "Reference diagnostics stopped at the " + limits.maxDiagnostics + " diagnostic limit.");
    }
    const missingByFile = new Map();
    let diagnosticCount = parserErrors.length;
    for (const { kind, target, status } of result.files) {
        if (status !== "missing") continue;
        if (diagnosticCount >= maxProblemDiagnostics) {
            truncate(result, "Reference diagnostics stopped at the " + limits.maxDiagnostics + " diagnostic limit.");
            break;
        }
        const list = missingByFile.get(target.source.file) ?? [];
        list.push({ kind, target });
        missingByFile.set(target.source.file, list);
        ++diagnosticCount;
    }
    for (const note of result.notes) report(note);
    return {
        missingByFile: [...missingByFile].map(([file, missing]) => ({ file, missing })),
        parserErrors,
        truncated: result.truncated,
        truncationMessage: result.truncationMessage,
    };
}

module.exports = { findFileReferenceProblems, inspectAddonSources };
