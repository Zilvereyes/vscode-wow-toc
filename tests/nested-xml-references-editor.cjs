const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, description) {
    for (let attempt = 0; attempt < 200; attempt++) {
        const result = await check();
        if (result) return result;
        await delay(150);
    }
    throw new Error("Timed out waiting for " + description);
}

async function showEvidence(phase, data) {
    await vscode.commands.executeCommand("workbench.action.problems.focus");
    const location = process.env.WOW_TOC_XML_TEST_EVIDENCE;
    if (!location) return;
    await fs.writeFile(path.join(location, phase + ".json"), JSON.stringify(data, null, 2) + "\n");
    if (process.env.WOW_TOC_XML_TEST_PAUSE) {
        await waitFor(() => fs.stat(path.join(location, phase + ".continue")).then(() => true, () => false),
            phase + " screenshot");
    }
}

function warnings() {
    return vscode.languages.getDiagnostics().flatMap(([uri, issues]) =>
        issues.filter(issue => issue.source === "Zilvereyes WoW TOC" && issue.code === "WOWTOC001")
            .map(issue => ({ uri, issue })));
}

exports.run = async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const expected = process.env.WOW_TOC_XML_TEST_FIXTURE;
    assert.ok(root && expected, "Specify the disposable ZilverUI copy");
    assert.equal(await fs.realpath(root), await fs.realpath(expected), "Use the disposable ZilverUI copy");
    const extension = vscode.extensions.getExtension("zilvereyes.vscode-wow-toc");
    assert.ok(extension);
    await extension.activate();

    const relativeDir = path.join("Libs", "AceConfig-3.0", "AceConfigCmd-3.0");
    const relativeXml = path.join(relativeDir, "AceConfigCmd-3.0.xml");
    const xml = vscode.Uri.file(path.join(root, relativeXml));
    const script = path.join(root, relativeDir, "AceConfigCmd-3.0.lua");
    const backup = script + ".pilot-backup";
    const originalScript = await fs.readFile(script);
    const originalXml = await fs.readFile(xml.fsPath);
    const doc = await vscode.workspace.openTextDocument(xml);
    const editor = await vscode.window.showTextDocument(doc);
    const original = doc.getText();
    const context = { vsCode: vscode.version, version: extension.packageJSON.version, workspace: root,
        includeChain: ["Embeds.xml", path.join("Libs", "AceConfig-3.0", "AceConfig-3.0.xml"), relativeXml] };
    const rangeOf = issue => ({ line: issue.range.start.line + 1, column: issue.range.start.character + 1 });

    async function oneWarning(message) {
        const [{uri, issue}] = await waitFor(() => {
            const items = warnings();
            return items.length === 1 && items;
        }, message);
        assert.equal(uri.toString(), xml.toString());
        assert.equal(issue.severity, vscode.DiagnosticSeverity.Warning);
        assert.equal(issue.message, message);
        return issue;
    }

    async function waitForClear() {
        await waitFor(() => warnings().length === 0, "XML warnings to clear");
    }

    async function replaceText(value) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(xml, new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)), value);
        assert.ok(await vscode.workspace.applyEdit(edit));
        assert.ok(await doc.save());
    }

    let renamed = false;
    try {
        await delay(1000);
        assert.deepEqual(warnings(), []);
        await fs.rename(script, backup);
        renamed = true;
        const issue = await oneWarning("Missing Script file: AceConfigCmd-3.0.lua");
        assert.deepEqual(rangeOf(issue), { line: 3, column: 16 });
        assert.equal(doc.getText(issue.range), "AceConfigCmd-3.0.lua");
        editor.revealRange(issue.range, vscode.TextEditorRevealType.InCenter);
        await showEvidence("before", { ...context, warnings: [{
            file: relativeXml, message: issue.message, source: issue.source, code: issue.code,
            range: rangeOf(issue), text: doc.getText(issue.range),
        }] });

        await fs.rename(backup, script);
        renamed = false;
        await waitForClear();
        await showEvidence("after", { ...context, warnings: [] });

        const closing = original.lastIndexOf("</Ui>");
        assert.ok(closing >= 0);
        const eol = original.includes("\r\n") ? "\r\n" : "\n";
        const changes = ['\t<Include file="./AceConfigCmd-3.0.xml"/>', '\t<Script file="PilotNestedMissing.lua"/>', ''].join(eol);
        await replaceText(original.slice(0,closing) + changes + original.slice(closing));
        const newIssue = await oneWarning("Missing Script file: PilotNestedMissing.lua");
        assert.equal(doc.getText(newIssue.range), "PilotNestedMissing.lua");
        await replaceText(original);
        await waitForClear();
        assert.deepEqual(await fs.readFile(script), originalScript);
        assert.deepEqual(await fs.readFile(xml.fsPath), originalXml);
        await showEvidence("complete", { ...context, warnings: [], createdTargetClears: true,
            nestedSaveRevalidated: true, cyclicIncludeTerminated: true, fixtureFilesRestored: true });
    } finally {
        if (renamed) await fs.rename(backup, script);
        if (doc.getText() !== original) await replaceText(original);
    }
};
