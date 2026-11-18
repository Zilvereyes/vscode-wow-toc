const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const source = "Zilvereyes WoW TOC";
const code = "WOWTOC001";

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
        const marker = path.join(location, phase + ".continue");
        await waitFor(() => fs.stat(marker).then(() => true, () => false), phase + " screenshot");
    }
}

exports.run = async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const expectedRoot = process.env.WOW_TOC_XML_TEST_FIXTURE;
    assert.ok(expectedRoot, "Specify the disposable ZilverUI fixture");
    assert.equal(await fs.realpath(root), await fs.realpath(expectedRoot), "Use the disposable ZilverUI fixture");
    const extension = vscode.extensions.getExtension("zilvereyes.vscode-wow-toc");
    await extension.activate();
    const xml = vscode.Uri.file(path.join(root, "Embeds.xml"));
    const manifest = path.join(root, "!~ZilverUI.toc");
    const document = await vscode.workspace.openTextDocument(xml);
    let editor = await vscode.window.showTextDocument(document);
    const original = await fs.readFile(xml.fsPath, "utf8");
    const toc = await fs.readFile(manifest, "utf8");
    const warningList = uri => vscode.languages.getDiagnostics(uri)
        .filter(item => item.source === source && item.code === code);
    const getWarnings = count => {
        const items = warningList(xml);
        return items.length === count && items;
    };
    const context = { vsCode: vscode.version, version: extension.packageJSON.version, workspace: root };

    await delay(850);
    assert.deepEqual(warningList(xml), []);
    const missingInclude = "Pilot&Missing.xml";
    const missingScript = "PilotMissing.lua";
    const includeValue = "Pilot&amp;Missing.xml";
    const conditional = vscode.Uri.file(path.join(root, "PilotConditional.xml"));
    await fs.writeFile(conditional.fsPath,
        '<Ui xmlns="http://www.blizzard.com/wow/ui/"><Include file="OtherMissing.xml"/></Ui>');
    await fs.writeFile(manifest, toc + "\r\nPilotConditional.xml [AllowLoadGameType vanilla]\r\n");

    const lineEnding = original.includes("\r\n") ? "\r\n" : "\n";
    const closing = original.lastIndexOf("</Ui>");
    assert.ok(closing >= 0);
    const extras = [
        '    <!-- 🧪 --> <Include file="' + includeValue + '"/>',
        '    <Script file="' + missingScript + '"/>',
        '    <Include file="[Family]\\NotResolved.xml"/>',
        '    <Include file="../OutsideWorkspace.xml"/>',
        '    <Script>local value = 1</Script>',
    ].join(lineEnding) + lineEnding;
    const edit = new vscode.WorkspaceEdit();
    edit.insert(xml, document.positionAt(closing), extras);
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(await document.save());
    const before = await waitFor(() => getWarnings(2), "two Include and Script warnings");
    for (const [diagnostic, message, rawValue] of [
        [before[0], "Missing Include file: " + missingInclude, includeValue],
        [before[1], "Missing Script file: " + missingScript, missingScript],
    ]) {
        assert.equal(diagnostic.message, message);
        assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Warning);
        assert.equal(document.getText(diagnostic.range), rawValue);
    }
    assert.deepEqual(warningList(conditional), []);
    editor = await vscode.window.showTextDocument(document);
    editor.revealRange(before[0].range, vscode.TextEditorRevealType.InCenter);
    await showEvidence("before", { ...context, warnings: before.map(item => ({
        message: item.message, source: item.source, code: item.code,
        range: { line: item.range.start.line + 1, column: item.range.start.character + 1 },
        text: document.getText(item.range),
    })) });

    await fs.writeFile(path.join(root, missingInclude), '<Ui xmlns="http://www.blizzard.com/wow/ui/"/>\n');
    const remaining = await waitFor(() => getWarnings(1), "Include warning to clear after creating its file");
    assert.equal(remaining[0].message, "Missing Script file: " + missingScript);
    await fs.writeFile(path.join(root, missingScript), "-- ZilverUI pilot fixture\n");
    await waitFor(() => getWarnings(0), "Script warning to clear after creating its file");
    await showEvidence("after", { ...context, warnings: warningList(xml), remainingAfterInclude: remaining[0].message });

    // Also exercise invalid XML and recovery while a missing target is present.
    await fs.unlink(path.join(root, missingScript));
    await waitFor(() => getWarnings(1), "Script warning to return after target deletion");
    const invalid = new vscode.WorkspaceEdit();
    const end = document.getText().lastIndexOf("</Ui>");
    invalid.delete(xml, new vscode.Range(document.positionAt(end), document.positionAt(end + "</Ui>".length)));
    assert.ok(await vscode.workspace.applyEdit(invalid));
    assert.ok(await document.save());
    await waitFor(() => getWarnings(0), "warnings to clear while XML is malformed");

    const valid = new vscode.WorkspaceEdit();
    valid.insert(xml, document.positionAt(end), "</Ui>");
    assert.ok(await vscode.workspace.applyEdit(valid));
    assert.ok(await document.save());
    await waitFor(() => getWarnings(1), "Script warning to return when XML is valid again");
    await fs.writeFile(path.join(root, missingScript), "-- ZilverUI pilot fixture\n");
    await waitFor(() => getWarnings(0), "all pilot warnings to clear");
    await showEvidence("complete", { ...context, warnings: warningList(xml), malformedRecovery: true,
        unknownConditionSuppressed: true, encodedRangeVerified: true, deletionRevalidated: true });
};
