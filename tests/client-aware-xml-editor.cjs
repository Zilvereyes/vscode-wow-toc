const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, label) {
    for (let attempt = 0; attempt < 200; attempt++) {
        const result = await check();
        if (result) return result;
        await sleep(150);
    }
    throw new Error("Timed out waiting for " + label);
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

function currentWarnings(root) {
    return vscode.languages.getDiagnostics().flatMap(([uri, issues]) => issues
        .filter(issue => issue.source === "Zilvereyes WoW TOC" && issue.code === "WOWTOC001")
        .map(issue => ({ file: path.relative(root, uri.fsPath), message: issue.message,
            line: issue.range.start.line + 1, column: issue.range.start.character + 1 })));
}

exports.run = async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const root = folder?.uri.fsPath;
    const expected = process.env.WOW_TOC_XML_TEST_FIXTURE;
    assert.ok(root && expected);
    assert.equal(await fs.realpath(root), await fs.realpath(expected));
    const extension = vscode.extensions.getExtension("zilvereyes.vscode-wow-toc");
    assert.equal(extension?.packageJSON.version, "0.5.0");
    await extension.activate();
    const config = () => vscode.workspace.getConfiguration("zilvereyes.wowToc",folder.uri);
    const set = (key,value) => config().update(key,value,vscode.ConfigurationTarget.Workspace);
    const tocName = "!~ZilverUI.toc";
    const toc = path.join(root,tocName);
    const originalToc = await fs.readFile(toc);
    const initialClient = config().get("xmlReferenceClient");
    const initialLocale = config().get("xmlReferenceTextLocale");
    const context = { vsCode: vscode.version, version: extension.packageJSON.version, workspace: root };

    async function writeXml(relative,missing) {
        const file = path.join(root,"PilotClient",relative);
        await fs.mkdir(path.dirname(file),{recursive:true});
        const body = missing ? '    <Script file="' + missing + '"/>\n' : "";
        await fs.writeFile(file,'<Ui xmlns="http://www.blizzard.com/wow/ui/">\n' + body + "</Ui>\n");
    }
    async function waitForWarnings(expected,label) {
        const want = [...expected].sort();
        return waitFor(() => {
            const actual = currentWarnings(root).sort((a,b)=>a.message.localeCompare(b.message));
            const found = actual.map(issue=>issue.message).sort();
            return JSON.stringify(found)===JSON.stringify(want) && actual;
        },label);
    }

    const appended = [
        "PilotClient\\[Family]\\Family.xml [AllowLoadGameType vanilla, standard]",
        "PilotClient\\[Game]\\Game.xml [AllowLoadGameType vanilla, standard]",
        "PilotClient\\ClassicOnly.xml [AllowLoadGameType classic][ExcludeLoadGameType standard]",
        "PilotClient\\RetailOnly.xml [AllowLoadGameType mainline][ExcludeLoadGameType classic]",
        "PilotClient\\[TextLocale]\\Locale.xml [AllowLoadTextLocale enUS]",
        "PilotClient\\Unproven.xml [Bootstrap]",
        "PilotClient\\Future.xml [AllowLoadGameType unknown-future]",
        "PilotClient\\[Unresolved]\\Variable.xml",
        "PilotClient\\[Family]\\MissingSeed.xml [AllowLoadGameType vanilla, standard]",
        "PilotClient\\[Family]\\Startup.lua [AllowLoadGameType vanilla]",
        "PilotClient\\[Unknown]\\Unresolved.lua",
    ].join("\r\n")+"\r\n";
    const selected = originalToc.toString("utf8")+"\r\n"+appended;
    const era = ["Missing Script file: EraFamilyMissing.lua", "Missing Script file: EraConditionMissing.lua",
        "Missing TOC XML file: PilotClient\\Classic\\MissingSeed.xml",
        "Missing TOC Lua file: PilotClient\\Classic\\Startup.lua"];
    const retail = ["Missing Script file: RetailFamilyMissing.lua", "Missing Script file: RetailConditionMissing.lua"];

    try {
        await writeXml("Classic/Family.xml","EraFamilyMissing.lua");
        await writeXml("Mainline/Family.xml","RetailFamilyMissing.lua");
        await writeXml("Vanilla/Game.xml");
        await writeXml("Standard/Game.xml");
        await writeXml("ClassicOnly.xml","EraConditionMissing.lua");
        await writeXml("RetailOnly.xml","RetailConditionMissing.lua");
        await writeXml("enUS/Locale.xml","LocaleControlMissing.lua");
        await writeXml("Unproven.xml","BootstrapMustNotWarn.lua");
        await writeXml("Future.xml","UnknownMustNotWarn.lua");
        await writeXml("Mainline/MissingSeed.xml");
        await fs.writeFile(toc,selected);
        await set("xmlReferenceClient","classic-era");
        const eraWarnings = await waitForWarnings(era,"Classic Era warnings only");
        assert.equal(eraWarnings.find(issue=>issue.message.includes("EraFamilyMissing")).file,path.join("PilotClient","Classic","Family.xml"));
        assert.equal(eraWarnings.find(issue=>issue.message.includes("EraFamilyMissing")).line,2);
        assert.equal(eraWarnings.find(issue=>issue.message.includes("TOC XML")).file,tocName);
        const lua = eraWarnings.find(issue => issue.message.includes("TOC Lua"));
        const luaLine = selected.split(/\r?\n/).findIndex(line => line.includes("Startup.lua")) + 1;
        assert.deepEqual([lua.file, lua.line, lua.column], [tocName, luaLine, 1]);
        const startup = path.join(root, "PilotClient", "Classic", "Startup.lua");
        await fs.writeFile(startup, "return\n");
        await waitForWarnings(era.filter(message => message !== lua.message), "TOC Lua warning clears on creation");
        await fs.unlink(startup);
        await waitForWarnings(era, "TOC Lua warning returns on deletion");
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(root,"PilotClient","Classic","Family.xml")));
        await showEvidence("before",{...context,client:"classic-era",warnings:eraWarnings});

        await set("xmlReferenceClient","retail");
        const retailWarnings = await waitForWarnings(retail,"Retail warnings only after client switch");
        assert.equal(retailWarnings.find(issue=>issue.message.includes("RetailFamilyMissing")).file,path.join("PilotClient","Mainline","Family.xml"));
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(root,"PilotClient","Mainline","Family.xml")));
        await showEvidence("after",{...context,client:"retail",warnings:retailWarnings});

        await set("xmlReferenceTextLocale","enUS");
        const localeWarnings = await waitForWarnings([...retail,"Missing Script file: LocaleControlMissing.lua"],"enUS locale");
        assert.equal(localeWarnings.find(issue=>issue.message.includes("LocaleControl")).file,path.join("PilotClient","enUS","Locale.xml"));
        await set("xmlReferenceTextLocale","");
        await waitForWarnings(retail,"clear locale warnings");
        await fs.writeFile(toc,selected+"## AllowLoadGameType: vanilla\r\n");
        await waitForWarnings([],"manifest condition excludes Retail");
        await set("xmlReferenceClient","classic-era");
        await waitForWarnings(era,"manifest condition permits Classic Era");
        await set("xmlReferenceClient","");
        await waitForWarnings([],"unknown client yields no client-specific warnings");
        await showEvidence("complete",{...context,client:"unspecified",warnings:[],
            classicEraOnly:true,retailOnly:true,localeChecked:true,manifestConditionChecked:true,
            unknownConditionsSuppressed:true,missingTocSourceChecked:true});
    } finally {
        await fs.writeFile(toc,originalToc);
        await set("xmlReferenceClient",initialClient);
        await set("xmlReferenceTextLocale",initialLocale);
    }
};

