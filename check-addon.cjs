const path = require("node:path");
const vscode = require("vscode");
const { inspectAddonSources } = require("./xml-references.cjs");
const { normalizeTocSelection } = require("./toc-client.cjs");

const command = "zilvereyes.wowToc.checkAddon";
const scheme = "wow-toc-report";
const labels = { toc: "TOC XML", "toc-lua": "TOC Lua", include: "Include", script: "Script" };
const statuses = { unverifiable: "unverified", incomplete: "incomplete XML", cycle: "Include cycle" };
const inlineControlPattern = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;
const inlineControlsPattern = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;

function escapeInline(value) {
    return value.replace(inlineControlsPattern, character =>
        "\\u" + character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"));
}

function isSafeManifestName(name) {
    return typeof name === "string" && /\.toc$/i.test(name) && !inlineControlPattern.test(name);
}

function sourceLink(source) {
    const { line, column } = source.range.start;
    return vscode.Uri.file(source.file).with({ fragment: "L" + (line + 1) + "," + (column + 1) });
}

function buildReport(directory, manifest, settings, result) {
    const lines = [];
    const links = [];
    const relative = file => path.relative(directory, file);
    const location = source => relative(source.file) + ":" + (source.range.start.line + 1);

    function line(...parts) {
        let text = "";
        for (const part of parts) {
            if (typeof part === "string") {
                text += escapeInline(part);
            } else {
                const display = escapeInline(part.text);
                const range = new vscode.Range(lines.length, text.length, lines.length, text.length + display.length);
                links.push(new vscode.DocumentLink(range, part.uri));
                text += display;
            }
        }
        lines.push(text);
    }

    line("Check AddOn");
    line("Manifest  ", { text: relative(manifest.fsPath), uri: manifest });
    line("Client    ", settings.invalidClient ? "invalid" : settings.client || "unspecified");
    line("Locale    ", settings.invalidTextLocale ? "invalid" : settings.textLocale || "unspecified");
    line("");
    if (result.manifestStatus !== "found") {
        line("Manifest status  ", result.manifestStatus);
    } else {
        line("SavedVariables");
        if (!result.savedVariables.length) line("  None declared");
        for (const item of result.savedVariables) {
            const qualifier = item.conditions.length ? ", conditional" : "";
            const invalid = item.validIdentifier ? "" : ", invalid identifier";
            line("  ", { text: item.name, uri: sourceLink(item.source) },
                "  [" + item.scope + qualifier + invalid + "]");
        }
        line("");
        line("Files in reference order");
        if (!result.files.length) line("  No active Lua or XML references");
        for (const [index, row] of result.files.entries()) {
            const display = row.file ? relative(row.file) : row.target.value;
            const state = statuses[row.status] ?? row.status;
            line("  " + (index + 1) + ". " + "  ".repeat(Math.min(row.depth, 8)),
                row.file ? { text: display, uri: vscode.Uri.file(row.file) } : display,
                "  [" + labels[row.kind] + ", " + state + "]  ",
                { text: location(row.target.source), uri: sourceLink(row.target.source) });
        }
        line("");
        line("TOC entries outside this selection  " + result.skippedTocEntries);
    }
    if (result.notes.length) {
        line("");
        line("Notes");
        for (const note of result.notes) line("  " + note);
    }
    return { text: lines.join("\n") + "\n", links };
}

async function pickFolder(active) {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === "file");
    const current = active?.scheme === scheme
        ? folders.find(folder => folder.uri.toString() === active.query)
        : active && vscode.workspace.getWorkspaceFolder(active);
    if (current?.uri.scheme === "file") return current;
    if (folders.length < 2) {
        if (!folders.length) void vscode.window.showInformationMessage("Open a local add-on folder to run Check AddOn.");
        return folders[0];
    }
    const picked = await vscode.window.showQuickPick(folders.map(folder =>
        ({ label: folder.name, description: folder.uri.fsPath, folder })), { placeHolder: "Select the add-on folder" });
    return picked?.folder;
}

async function pickManifest(folder, active, output, { setting, xmlSetting, selectedManifest }) {
    if (active?.scheme === "file" && path.relative(folder.uri.fsPath, path.dirname(active.fsPath)) === "" && /\.toc$/i.test(active.fsPath)) {
        return active;
    }
    const configured = selectedManifest(folder, output, xmlSetting) ?? selectedManifest(folder, output, setting);
    if (configured) return configured;

    const candidates = (await vscode.workspace.fs.readDirectory(folder.uri))
        .filter(([name, type]) => type === vscode.FileType.File && /\.toc$/i.test(name))
        .map(([name]) => name).sort((a, b) => a.localeCompare(b));
    if (!candidates.length) {
        void vscode.window.showInformationMessage("The selected folder has no root-level TOC files.");
        return;
    }
    const name = candidates.length === 1 ? candidates[0] : await vscode.window.showQuickPick(candidates,
        { placeHolder: "Select the add-on manifest to check" });
    if (name) return vscode.Uri.joinPath(folder.uri, name);
}

function registerAddonCheck(context, config) {
    const reports = new Map();
    const requests = new Map();
    const change = new vscode.EventEmitter();
    const output = vscode.window.createOutputChannel("WoW TOC Check AddOn");

    context.subscriptions.push(output, change,
        vscode.workspace.registerTextDocumentContentProvider(scheme, {
            onDidChange: change.event,
            provideTextDocumentContent: uri => reports.get(uri.toString())?.text ?? "",
        }),
        vscode.languages.registerDocumentLinkProvider({ scheme }, {
            provideDocumentLinks: document => reports.get(document.uri.toString())?.links ?? [],
        }),
        vscode.workspace.onDidCloseTextDocument(document => {
            if (document.uri.scheme === scheme) reports.delete(document.uri.toString());
        }),
        vscode.commands.registerCommand(command, async () => {
            if (!vscode.workspace.isTrusted) {
                void vscode.window.showInformationMessage("Check AddOn requires a trusted workspace.");
                return;
            }
            const active = vscode.window.activeTextEditor?.document.uri;
            try {
                const folder = await pickFolder(active);
                if (!folder) return;
                const previous = active?.scheme === scheme && reports.get(active.toString());
                const manifest = previous?.manifest ?? await pickManifest(folder, active, output, config);
                if (!manifest) return;
                const name = path.basename(manifest.fsPath);
                if (!isSafeManifestName(name)) {
                    throw new Error("The selected TOC filename contains unsupported control characters.");
                }
                const uri = vscode.Uri.from({ scheme, path: "/" + name + " - Check AddOn.txt", query: folder.uri.toString() });
                const key = uri.toString();
                const request = Symbol();
                requests.set(key, request);
                try {
                    const settings = vscode.workspace.getConfiguration(undefined, folder.uri);
                    const selection = normalizeTocSelection({
                        client: settings.get(config.xmlClient),
                        textLocale: settings.get(config.xmlLocale),
                    });
                    const result = await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Window,
                        title: "Checking " + name,
                    }, () => inspectAddonSources(folder.uri.fsPath, name, require("./dist/sdk.cjs"), selection));
                    if (requests.get(key) !== request) return;
                    const refresh = reports.has(key);
                    reports.set(key, { manifest, ...buildReport(folder.uri.fsPath, manifest, selection, result) });
                    if (refresh) change.fire(uri);
                    const report = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(report, { preview: false });
                    return uri;
                } finally {
                    if (requests.get(key) === request) requests.delete(key);
                }
            } catch (error) {
                output.appendLine(error.message);
                void vscode.window.showErrorMessage("Check AddOn failed: " + error.message);
            }
        }));
}

module.exports = { registerAddonCheck };
