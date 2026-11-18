const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vscode = require("vscode");

exports.run = async () => {
    const id = "zilvereyes.vscode-wow-toc";
    const extension = vscode.extensions.getExtension(id);
    assert.ok(extension, "VS Code must discover " + id);
    const theme = extension.packageJSON.contributes.themes.find(item => item.label === "WoW TOC Theme");
    assert.ok(theme && fs.existsSync(path.join(extension.extensionPath, theme.path)));
    assert.equal(vscode.workspace.getConfiguration("workbench").get("colorTheme"), theme.label);
    const preview = vscode.Uri.file(path.join(extension.extensionPath, "tests", "fixtures", "Preview.toc"));
    const document = await vscode.workspace.openTextDocument(preview);
    assert.equal(document.languageId, "toc");
    await vscode.window.showTextDocument(document);
    assert.equal(vscode.window.activeColorTheme.kind, vscode.ColorThemeKind.Dark);
    const receipt = {
        vsCode: vscode.version,
        extension: id + "@" + extension.packageJSON.version,
        theme: theme.label,
        themeKind: "dark",
        language: document.languageId,
        preview: path.basename(document.fileName),
    };
    if (process.env.WOW_TOC_TEST_RECEIPT) {
        fs.writeFileSync(process.env.WOW_TOC_TEST_RECEIPT, JSON.stringify(receipt, null, 2) + "\n");
    }
    console.log(JSON.stringify(receipt));
};
