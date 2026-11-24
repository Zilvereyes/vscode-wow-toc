const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

const command = "zilvereyes.wowToc.checkAddon";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, description) {
    for (let attempt = 0; attempt < 80; attempt++) {
        const found = await check();
        if (found) return found;
        await wait(125);
    }
    assert.fail("Timed out waiting for " + description);
}

exports.run = async () => {
    const evidence = { vscode: vscode.version };
    try {
        const folder = vscode.workspace.workspaceFolders[0];
        const root = folder.uri.fsPath;
        const expected = process.env.WOW_CHECK_ADDON_FIXTURE;
        assert.ok(expected);
        assert.equal(await fs.realpath(root), await fs.realpath(expected));

        const extension = vscode.extensions.getExtension("zilvereyes.wow-addon-toc");
        assert.ok(extension);
        await extension.activate();
        const toc = vscode.Uri.joinPath(folder.uri, "!~ZilverUI.toc");
        const lua = vscode.Uri.joinPath(folder.uri, "ZilverUI.lua");
        const embeds = vscode.Uri.joinPath(folder.uri, "Embeds.xml");
        const config = () => vscode.workspace.getConfiguration("zilvereyes.wowToc", folder.uri);
        const setClient = name => config().update("xmlReferenceClient", name, vscode.ConfigurationTarget.Workspace);
        await setClient("classic-era");

        async function reportFrom(file) {
            await vscode.window.showTextDocument(file);
            const uri = await vscode.commands.executeCommand(command);
            assert.equal(uri?.scheme, "wow-toc-report");
            const report = await vscode.workspace.openTextDocument(uri);
            assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), uri.toString());
            return report;
        }

        const report = await reportFrom(toc);
        const initial = report.getText();
        assert.match(initial, /Client +classic-era/);
        assert.match(initial, /\bZUI +\[account\]/);
        assert.match(initial, /\bLoadingOrderSavedVar +\[account\]/);
        const embedsIndex = initial.indexOf("Embeds.xml  [TOC XML, found]");
        const libIndex = initial.indexOf("LibStub.lua  [Script, found]");
        const luaIndex = initial.indexOf("ZilverUI.lua  [TOC Lua, found]");
        assert.ok(embedsIndex >= 0 && embedsIndex < libIndex && libIndex < luaIndex, initial);
        const links = () => vscode.commands.executeCommand("vscode.executeLinkProvider", report.uri);
        const reportLinks = await waitFor(async () => {
            const found = await links();
            return found?.length > 4 && found;
        }, "active file and location links");
        const savedLink = reportLinks.find(link => report.getText(link.range) === "ZUI");
        const fileLink = reportLinks.find(link => report.getText(link.range) === "Embeds.xml");
        const nestedLink = reportLinks.find(link => report.getText(link.range) === "Embeds.xml:3");
        assert.ok(savedLink?.target?.fragment.match(/^L\d+,\d+$/));
        assert.equal(fileLink?.target?.fsPath, embeds.fsPath);
        assert.equal(nestedLink?.target?.fsPath, embeds.fsPath);
        assert.equal(nestedLink?.target?.fragment, "L3,19");
        const position = nestedLink.range.start.translate(0, 1);
        const reportEditor = vscode.window.activeTextEditor;
        reportEditor.selection = new vscode.Selection(position, position);
        reportEditor.revealRange(nestedLink.range);
        const editor = await waitFor(async () => {
            const current = vscode.window.activeTextEditor;
            if (current?.document.uri.fsPath === embeds.fsPath) return current;
            await vscode.commands.executeCommand("editor.action.openLink");
        }, "navigation to the XML source");
        assert.equal(editor?.document.uri.fsPath, embeds.fsPath);
        assert.equal(editor?.selection.active.line, 2);
        evidence.initial = initial;
        evidence.links = { count: reportLinks.length, nestedTarget: nestedLink.target.toString(),
            openedLine: editor.selection.active.line + 1 };

        const originalToc = await fs.readFile(toc.fsPath);
        const marker = "CheckAddon[Family]Missing.lua [AllowLoadGameType vanilla]";
        try {
            await fs.appendFile(toc.fsPath, "\n" + marker + "\n");
            const era = await reportFrom(report);
            assert.equal(era.uri.toString(), report.uri.toString());
            const warning = "CheckAddonClassicMissing.lua  [TOC Lua, missing]";
            await waitFor(() => era.getText().includes(warning), "Classic Era missing-file row");
            evidence.classicMissing = era.getText().split("\n").find(row => row.includes(warning));
            await setClient("retail");
            const retail = await reportFrom(lua);
            await waitFor(() => /Client +retail/.test(retail.getText()), "Retail report refresh");
            assert.doesNotMatch(retail.getText(), /CheckAddonClassicMissing/);
            evidence.retailOmittedClassicOnly = true;
            evidence.restoredToc = true;
        } finally {
            await fs.writeFile(toc.fsPath, originalToc);
        }
    } catch (error) {
        evidence.error = error.stack;
        throw error;
    } finally {
        const file = process.env.WOW_CHECK_ADDON_EVIDENCE;
        if (file) await fs.writeFile(file, JSON.stringify(evidence, null, 2) + "\n");
    }
};
