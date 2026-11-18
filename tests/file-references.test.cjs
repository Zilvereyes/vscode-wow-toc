const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { findMissingFileReferences, inspectAddonSources } = require("../xml-references.cjs");
const sdk = require("../dist/sdk.cjs");

test("checks active Lua entries in the manifest without traversing them as XML", async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wow-toc-load-files-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const name = "Fixture.toc";
    const manifest = path.join(root, name);
    await fs.mkdir(path.join(root, "Classic"));
    await fs.writeFile(path.join(root, "Existing.lua"), "return 1\n");
    await fs.writeFile(manifest, [
        "## Interface: 11508",
        "Existing.lua",
        "[Family]\\Startup.LUA [AllowLoadGameType vanilla]",
        "[Unresolved]\\Unknown.lua",
        "Foreign.lua [AllowLoadGameType unknown-future]",
        "Missing.xml",
        "",
    ].join("\n"));
    const check = (client, report) => findMissingFileReferences(root, name, sdk, report, { client });
    const notes = [];
    const [initial] = await check("classic-era", note => notes.push(note));
    assert.equal(initial.file, manifest);
    assert.deepEqual(initial.missing.map(({ kind, target }) => [kind, target.value, target.source.range.start.line]), [
        ["toc-lua", "Classic\\Startup.LUA", 2], ["toc", "Missing.xml", 5],
    ]);
    const [retail] = await check("retail");
    assert.deepEqual(retail.missing.map(({ target }) => target.value), ["Missing.xml"]);
    await fs.writeFile(path.join(root, "Classic", "Startup.LUA"), "return 2\n");
    const [updated] = await check("classic-era", note => notes.push(note));
    assert.deepEqual(updated.missing.map(({ target }) => target.value), ["Missing.xml"]);
    assert.deepEqual(notes, []);
});

test("reports Includes at their reference position and keeps repeated references without looping", async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wow-toc-check-report-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const namespace = ' xmlns="http://www.blizzard.com/wow/ui/"';
    const xml = entries => "<Ui" + namespace + ">\n" + entries.join("\n") + "\n</Ui>\n";
    await fs.writeFile(path.join(root, "Demo.toc"), [
        "## SavedVariables: MyDB",
        "## SavedVariablesPerCharacter: MyChar",
        "Root.xml",
        "Root.xml",
        "After.lua",
        "Retail.lua [AllowLoadGameType standard]",
        "",
    ].join("\n"));
    await fs.writeFile(path.join(root, "Root.xml"), xml([
        '  <Include file="Child.xml"/>', '  <Script file="After.lua"/>',
    ]));
    await fs.writeFile(path.join(root, "Child.xml"), xml([
        '  <Script file="Missing.lua"/>', '  <Include file="Root.xml"/>',
    ]));
    await fs.writeFile(path.join(root, "After.lua"), "return\n");

    const settings = { client: "classic-era" };
    const result = await inspectAddonSources(root, "Demo.toc", sdk, settings);
    assert.equal(result.manifestStatus, "found");
    assert.equal(result.skippedTocEntries, 1);
    assert.deepEqual(result.savedVariables.map(item => [item.name, item.scope]), [
        ["MyDB", "account"], ["MyChar", "character"],
    ]);
    const branch = [
        ["Root.xml", "found", 0], ["Child.xml", "found", 1], ["Missing.lua", "missing", 2],
        ["Root.xml", "cycle", 2], ["After.lua", "found", 1],
    ];
    assert.deepEqual(result.files.map(row => [row.target.value, row.status, row.depth]),
        [...branch, ...branch, ["After.lua", "found", 0]]);
    const [missing] = await findMissingFileReferences(root, "Demo.toc", sdk, undefined, settings);
    assert.equal(path.basename(missing.file), "Child.xml");
    assert.deepEqual(missing.missing.map(reference => reference.target.value), ["Missing.lua"]);
});
