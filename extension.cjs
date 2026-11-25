const vscode = require("vscode");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { TextDecoder, TextEncoder } = require("node:util");
const { generateSavedVariables, generatedHeader } = require("./saved-variables.cjs");

const { findFileReferenceProblems } = require("./xml-references.cjs");
const { registerAddonCheck } = require("./check-addon.cjs");

const setting = "zilvereyes.wowToc.savedVariablesManifest";
const xmlSetting = "zilvereyes.wowToc.xmlReferenceManifest";
const xmlClient = "zilvereyes.wowToc.xmlReferenceClient";
const xmlLocale = "zilvereyes.wowToc.xmlReferenceTextLocale";
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function selectedManifest(folder, output, key = setting) {
    const name = vscode.workspace.getConfiguration(undefined, folder.uri).get(key, "");
    if (!name) return undefined;
    if (typeof name !== "string" || !/^[^/\\:*?"<>|]+\.toc$/i.test(name)) {
        output.appendLine(folder.name + ": select a .toc filename in the workspace root.");
        return undefined;
    }
    return vscode.Uri.joinPath(folder.uri, name);
}

async function updateEditorGlobals(folder, manifest, output) {
    const source = decoder.decode(await vscode.workspace.fs.readFile(manifest));
    const result = generateSavedVariables(manifest.fsPath, source, require("./dist/sdk.cjs"));
    const library = vscode.Uri.joinPath(folder.uri, "Editor", "LuaLS");
    const target = vscode.Uri.joinPath(library, "SavedVariables.lua");
    let previousBytes;
    try {
        previousBytes = await vscode.workspace.fs.readFile(target);
    } catch (error) {
        if (error.code !== "FileNotFound") throw error;
    }
    const previous = previousBytes === undefined ? undefined : decoder.decode(previousBytes);
    const normalized = previous?.replace(/\r\n/g, "\n");
    if (normalized === result.text) return;
    if (normalized !== undefined && !normalized.startsWith(generatedHeader)) {
        throw new Error("Editor/LuaLS/SavedVariables.lua already contains a hand-written file.");
    }
    if (previous === undefined) {
        await vscode.workspace.fs.createDirectory(library);
        await vscode.workspace.fs.writeFile(target, encoder.encode(result.text));
    } else {
        // LuaLS's default workspace diagnostics refresh on a Lua document save.
        const document = await vscode.workspace.openTextDocument(target);
        if (document.isDirty || document.getText().replace(/\r\n/g, "\n") !== normalized) {
            throw new Error("The generated editor file changed during synchronization.");
        }
        const version = document.version;
        const backup = target.with({ path: target.path + "." + randomUUID() + ".bak" });
        await vscode.workspace.fs.copy(target, backup, { overwrite: false });
        const disk = await vscode.workspace.fs.readFile(target);
        if (document.isDirty || document.version !== version || !Buffer.from(disk).equals(previousBytes)) {
            throw new Error("The generated editor file changed during synchronization.");
        }
        const range = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(target, range, result.text);
        if (!await vscode.workspace.applyEdit(edit) || !await document.save()) {
            throw new Error("Unable to save the generated editor file.");
        }
    }
    output.appendLine(folder.name + ": " + result.names.length + " globals from " + manifest.path.split("/").pop());
    if (result.conditional) output.appendLine("Conditional declarations awaiting client selection: " + result.conditional);
}

function watchXmlReferences(folder, manifest, output) {
    const diagnostics = vscode.languages.createDiagnosticCollection("wow-toc-xml-references");
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "**/*"));
    const manifestName = manifest.path.split("/").pop();
    const configuration = vscode.workspace.getConfiguration(undefined, folder.uri);
    const settings = { client: configuration.get(xmlClient), textLocale: configuration.get(xmlLocale) };
    let timer;
    let revision = 0;
    let pending = Promise.resolve();
    let disposed = false;

    function schedule() {
        const requested = ++revision;
        clearTimeout(timer);
        timer = setTimeout(() => {
            pending = pending.then(async () => {
                if (disposed || requested !== revision) return;
                const notes = [];
                try {
                    const cancelled = () => disposed || requested !== revision;
                    const { missingByFile, parserErrors, truncationMessage } = await findFileReferenceProblems(
                        folder.uri.fsPath, manifestName, require("./dist/sdk.cjs"),
                        message => notes.push(message), settings, { isCancelled: cancelled });
                    if (cancelled()) return;
                    for (const note of notes) output.appendLine(folder.name + ": " + note);
                    const entries = missingByFile.map(({ file, missing }) => [vscode.Uri.file(file), missing.map(reference => {
                        const { start, end } = reference.target.source.range;
                        const range = new vscode.Range(start.line, start.column, end.line, end.column);
                        const label = { include: "Include", script: "Script", toc: "TOC XML", "toc-lua": "TOC Lua" }[reference.kind];
                        const warning = new vscode.Diagnostic(range,
                            "Missing " + label + " file: " + reference.target.value, vscode.DiagnosticSeverity.Warning);
                        warning.source = "Zilvereyes WoW TOC";
                        warning.code = "WOWTOC001";
                        return warning;
                    })]);
                    const manifestDiagnostics = parserErrors.map(issue => {
                        const { start, end } = issue.source.range;
                        const range = new vscode.Range(start.line, start.column, end.line, end.column);
                        const diagnostic = new vscode.Diagnostic(range, issue.message, vscode.DiagnosticSeverity.Error);
                        diagnostic.source = "Zilvereyes WoW TOC";
                        diagnostic.code = issue.code;
                        return diagnostic;
                    });
                    if (truncationMessage) {
                        const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0),
                            truncationMessage, vscode.DiagnosticSeverity.Warning);
                        diagnostic.source = "Zilvereyes WoW TOC";
                        diagnostic.code = "WOWTOC002";
                        manifestDiagnostics.push(diagnostic);
                    }
                    if (manifestDiagnostics.length) {
                        const existing = entries.find(([uri]) => uri.toString() === manifest.toString());
                        if (existing) existing[1].push(...manifestDiagnostics);
                        else entries.push([manifest, manifestDiagnostics]);
                    }
                    const current = new Set(entries.map(([uri]) => uri.toString()));
                    diagnostics.forEach(uri => {
                        if (!current.has(uri.toString())) entries.push([uri, undefined]);
                    });
                    diagnostics.set(entries);
                } catch (error) {
                    if (cancelled()) return;
                    diagnostics.clear();
                    output.appendLine(folder.name + ": " + error.message);
                }
            });
        }, 200);
    }

    function sourceChanged(uri) {
        if (uri.scheme !== "file") return;
        const relative = path.relative(folder.uri.fsPath, uri.fsPath);
        if (!relative || path.isAbsolute(relative) || relative.startsWith(".." + path.sep)) return;
        if (uri.toString() === manifest.toString() || /\.xml$/i.test(relative)) schedule();
    }

    const events = [
        watcher.onDidCreate(schedule),
        watcher.onDidDelete(schedule),
        watcher.onDidChange(sourceChanged),
        vscode.workspace.onDidSaveTextDocument(document => sourceChanged(document.uri)),
    ];
    schedule();
    return {
        dispose() {
            disposed = true;
            ++revision;
            clearTimeout(timer);
            for (const event of events) event.dispose();
            watcher.dispose();
            diagnostics.dispose();
        },
    };
}

function activate(context) {
    const output = vscode.window.createOutputChannel("WoW TOC SavedVariables");
    const xmlOutput = vscode.window.createOutputChannel("WoW TOC XML References");
    const folders = new Map();
    const xmlWatchers = [];

    function disposeWatchers() {
        for (const watcher of folders.values()) watcher.dispose();
        folders.clear();
        for (const watcher of xmlWatchers.splice(0)) watcher.dispose();
    }

    function watch(folder) {
        const manifest = selectedManifest(folder, output);
        if (!manifest) return;
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "*.toc"));
        let pending = Promise.resolve();
        let timer;
        let disposed = false;

        function schedule(uri) {
            if (uri && uri.toString() !== manifest.toString()) return;
            clearTimeout(timer);
            timer = setTimeout(() => {
                pending = pending.then(async () => {
                    if (disposed) return;
                    try {
                        await updateEditorGlobals(folder, manifest, output);
                    } catch (error) {
                        output.appendLine(folder.name + ": " + error.message);
                    }
                });
            }, 200);
        }

        const events = [
            watcher.onDidCreate(schedule),
            watcher.onDidChange(schedule),
            watcher.onDidDelete(schedule),
            vscode.workspace.onDidSaveTextDocument(document => schedule(document.uri)),
        ];
        folders.set(folder.uri.toString(), {
            dispose() {
                disposed = true;
                clearTimeout(timer);
                for (const event of events) event.dispose();
                watcher.dispose();
            },
        });
        schedule();
    }

    function rebuild() {
        disposeWatchers();
        if (vscode.workspace.isTrusted) {
            for (const folder of vscode.workspace.workspaceFolders ?? []) {
                watch(folder);
                if (folder.uri.scheme !== "file") continue;
                const manifest = selectedManifest(folder, xmlOutput, xmlSetting);
                if (manifest) xmlWatchers.push(watchXmlReferences(folder, manifest, xmlOutput));
            }
        }
    }

    context.subscriptions.push(output, xmlOutput,
        vscode.workspace.onDidGrantWorkspaceTrust(rebuild),
        vscode.workspace.onDidChangeWorkspaceFolders(rebuild),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(setting) || event.affectsConfiguration(xmlSetting) ||
                event.affectsConfiguration(xmlClient) || event.affectsConfiguration(xmlLocale)) rebuild();
        }),
        { dispose: disposeWatchers });
    registerAddonCheck(context, { setting, xmlSetting, xmlClient, xmlLocale, selectedManifest });
    rebuild();
}

module.exports = { activate };
