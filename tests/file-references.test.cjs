const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { findFileReferenceProblems, inspectAddonSources } = require("../xml-references.cjs");
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
        "[AllowLoadGameType vanilla] [AllowLoad game]\t[Family]\\Startup.LUA",
        "[Unresolved]\\Unknown.lua",
        "[AllowLoadGameType unknown-future] Foreign.lua",
        "Missing.xml",
        "",
    ].join("\n"));
    const check = async (client, report) => (await findFileReferenceProblems(root, name, sdk, report, { client })).missingByFile;
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
    const { missingByFile: [missing] } = await findFileReferenceProblems(root, "Demo.toc", sdk, undefined, settings);
    assert.equal(path.basename(missing.file), "Child.xml");
    assert.deepEqual(missing.missing.map(reference => reference.target.value), ["Missing.lua"]);
});

test("normalizes prefixed XML paths while preserving unprefixed whitespace", async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wow-prefix-xml-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, "Demo.toc"), [
        "  [AllowLoadGameType vanilla] Root [Classic].xml",
        "[AllowLoadGameType vanilla] Root.xml",
        " Root.xml [AllowLoadGameType vanilla]",
        " Root.xml",
    ].join("\r\n"));
    await fs.writeFile(path.join(root, "Root.xml"),
        '<Ui xmlns="http://www.blizzard.com/wow/ui/"><Script file="Missing.lua"/></Ui>');
    const era = await inspectAddonSources(root, "Demo.toc", sdk, { client: "classic-era" });
    assert.deepEqual(era.files.map(row => [row.target.value, row.status]), [
        ["Root.xml", "found"], ["Missing.lua", "missing"],
        [" Root.xml", "unverifiable"], [" Root.xml", "unverifiable"],
    ]);
    assert.equal(era.skippedTocEntries, 1);
});

test("returns the TOC parser error range and suppresses derived file warnings until the TOC is fixed", async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wow-toc-parse-error-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const name = "Fixture.toc";
    const manifest = path.join(root, name);
    const invalid = "## Title [Unrecognized]: Test";
    const lines = ["## Interface: 11509", invalid, "[AllowLoadGameType vanilla] Missing.lua"];
    const check = () => findFileReferenceProblems(root, name, sdk, undefined, { client: "classic-era" });
    await fs.writeFile(manifest, lines.join("\r\n"));
    const { missingByFile, parserErrors: [issue, ...others] } = await check();
    assert.deepEqual(missingByFile, []);
    assert.deepEqual(others, []);
    assert.equal(issue.code, "TOC0001");
    assert.equal(issue.severity, "error");
    assert.equal(issue.source.file, manifest);
    assert.deepEqual(issue.source.range, {
        start: { line: 1, column: invalid.indexOf("[") },
        end: { line: 1, column: invalid.indexOf("]") + 1 },
    });
    lines[1] = "## Title: Test";
    await fs.writeFile(manifest, lines.join("\r\n"));
    const repaired = await check();
    assert.deepEqual(repaired.parserErrors, []);
    assert.equal(repaired.missingByFile[0].missing[0].target.value, "Missing.lua");
});

test("bounds automatic reference diagnostics without hiding earlier missing files", async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wow-reference-limits-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const namespace = ' xmlns="http://www.blizzard.com/wow/ui/"';
    await fs.writeFile(path.join(root, "Demo.toc"), "Root.xml\n");
    await fs.writeFile(path.join(root, "Root.xml"), [
        "<Ui" + namespace + ">",
        '  <Script file="First.lua"/>',
        '  <Script file="Second.lua"/>',
        '  <Script file="Third.lua"/>',
        "</Ui>",
    ].join("\n"));

    const parsedReferences = await findFileReferenceProblems(root, "Demo.toc", sdk, undefined, {},
        { limits: { maxReferences: 2 } });
    assert.deepEqual(parsedReferences.missingByFile, []);
    assert.equal(parsedReferences.truncationMessage,
        "Reference check stopped before retaining more than 2 parsed XML references.");

    const referenceNotes = [];
    const references = await findFileReferenceProblems(root, "Demo.toc", sdk,
        note => referenceNotes.push(note), {}, { limits: { maxReferences: 3, maxDiagnostics: 10 } });
    assert.deepEqual(references.missingByFile[0].missing.map(item => item.target.value),
        ["First.lua", "Second.lua"]);
    assert.equal(references.truncated, true);
    assert.equal(references.truncationMessage, "Reference check stopped after 3 file references.");
    assert.deepEqual(referenceNotes, [references.truncationMessage]);

    const diagnosticNotes = [];
    const diagnostics = await findFileReferenceProblems(root, "Demo.toc", sdk,
        note => diagnosticNotes.push(note), {}, { limits: { maxDiagnostics: 3 } });
    assert.deepEqual(diagnostics.missingByFile[0].missing.map(item => item.target.value),
        ["First.lua", "Second.lua"]);
    assert.equal(diagnostics.truncationMessage, "Reference diagnostics stopped at the 3 diagnostic limit.");
    assert.deepEqual(diagnosticNotes, [diagnostics.truncationMessage]);
});

test("bounds XML files, depth, bytes, and cancelled scans", async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wow-xml-limits-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const namespace = ' xmlns="http://www.blizzard.com/wow/ui/"';
    const xml = entries => "<Ui" + namespace + ">\n" + entries.join("\n") + "\n</Ui>\n";
    const manifestText = "Root.xml\n";
    await fs.writeFile(path.join(root, "Demo.toc"), manifestText);
    await fs.writeFile(path.join(root, "Root.xml"), xml(['  <Include file="Child.xml"/>']));
    await fs.writeFile(path.join(root, "Child.xml"), xml(['  <Include file="Grandchild.xml"/>']));
    await fs.writeFile(path.join(root, "Grandchild.xml"), xml([]));

    const fileLimited = await inspectAddonSources(root, "Demo.toc", sdk, {},
        { limits: { maxXmlFiles: 1 } });
    assert.deepEqual(fileLimited.files.map(item => item.target.value), ["Root.xml"]);
    assert.equal(fileLimited.truncationMessage, "Reference check stopped after 1 unique XML files.");

    const depthLimited = await inspectAddonSources(root, "Demo.toc", sdk, {},
        { limits: { maxDepth: 0 } });
    assert.deepEqual(depthLimited.files.map(item => item.target.value), ["Root.xml"]);
    assert.equal(depthLimited.truncationMessage, "Reference check stopped at the maximum XML depth of 0.");

    const rootBytes = Buffer.byteLength(await fs.readFile(path.join(root, "Root.xml")));
    const perFileLimited = await inspectAddonSources(root, "Demo.toc", sdk, {},
        { limits: { maxFileBytes: rootBytes - 1 } });
    assert.match(perFileLimited.truncationMessage, /byte per-file limit/);

    const totalLimited = await inspectAddonSources(root, "Demo.toc", sdk, {},
        { limits: { maxTotalBytes: Buffer.byteLength(manifestText) + rootBytes - 1 } });
    assert.match(totalLimited.truncationMessage, /byte total-file limit/);

    const cancelled = await findFileReferenceProblems(root, "Demo.toc", sdk, undefined, {},
        { isCancelled: () => true });
    assert.deepEqual(cancelled, { missingByFile: [], parserErrors: [], cancelled: true });
});
