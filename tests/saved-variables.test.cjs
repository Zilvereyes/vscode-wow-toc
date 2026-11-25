const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { generateSavedVariables, generatedHeader } = require("../saved-variables.cjs");
const { readSavedVariablesFile, replaceSavedVariablesFile } = require("../saved-variables-file.cjs");
const sdk = require("../dist/sdk.cjs");

const name = "Fixture.toc";
test("SDK groups account and character SavedVariables and updates additions and removals", () => {
    const initial = generateSavedVariables(name, "## SavedVariables: ZUI, Counter\n## SavedVariablesPerCharacter: LocalState, ZUI\n", sdk);
    assert.deepEqual(initial.names, ["ZUI", "Counter", "LocalState"]);
    assert.ok(initial.text.startsWith(generatedHeader));
    const changed = generateSavedVariables(name, "## SavedVariables: ZUI, NewValue\n", sdk);
    assert.deepEqual(changed.names, ["ZUI", "NewValue"]);
    assert.doesNotMatch(changed.text, /Counter|LocalState/);
    assert.equal(generateSavedVariables(name, "# Empty manifest\n", sdk).text, generatedHeader);
});
test("declarations cannot introduce Lua keywords or malformed Lua identifiers", () => {
    assert.throws(() => generateSavedVariables(name, "## SavedVariables: end\n", sdk), /Lua global/);
    assert.throws(() => generateSavedVariables(name, "## SavedVariables: a-b\n", sdk));
});

async function workspace(t) {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "wow-toc-saved-variables-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const root = path.join(parent, "workspace");
    const outside = path.join(parent, "outside");
    await fs.mkdir(root);
    await fs.mkdir(outside);
    return { root, outside };
}

async function linkOrSkip(t, target, link, type) {
    try {
        await fs.symlink(target, link, type);
        return true;
    } catch (error) {
        if (!["EACCES", "EPERM", "ENOTSUP"].includes(error.code)) throw error;
        t.skip("This platform does not permit symbolic links for the regression test.");
        return false;
    }
}

test("generated file creation and replacement stay in a regular workspace directory", async t => {
    const { root } = await workspace(t);
    const first = Buffer.from(generatedHeader + "First = nil\n");
    const second = Buffer.from(generatedHeader + "Second = nil\n");
    const empty = await readSavedVariablesFile(root);
    assert.equal(empty.bytes, undefined);
    await replaceSavedVariablesFile(root, undefined, first);
    assert.deepEqual((await readSavedVariablesFile(root)).bytes, first);
    const replaced = await replaceSavedVariablesFile(root, first, second);
    assert.deepEqual((await readSavedVariablesFile(root)).bytes, second);
    assert.deepEqual(await fs.readFile(replaced.backup), first);
});

test("generated file writes reject linked parents and targets", async t => {
    const payload = Buffer.from(generatedHeader + "Outside = nil\n");
    for (const linkedPart of ["Editor", "LuaLS", "SavedVariables.lua"]) {
        const { root, outside } = await workspace(t);
        const editor = path.join(root, "Editor");
        const library = path.join(editor, "LuaLS");
        const target = path.join(library, "SavedVariables.lua");
        const outsideTarget = path.join(outside, linkedPart === "Editor" ? "LuaLS" : "", "SavedVariables.lua");
        if (linkedPart === "Editor") {
            if (!await linkOrSkip(t, outside, editor, process.platform === "win32" ? "junction" : "dir")) return;
        } else {
            await fs.mkdir(editor);
            if (linkedPart === "LuaLS") {
                if (!await linkOrSkip(t, outside, library, process.platform === "win32" ? "junction" : "dir")) return;
            } else {
                await fs.mkdir(library);
                if (!await linkOrSkip(t, outsideTarget, target, "file")) return;
            }
        }
        await assert.rejects(() => replaceSavedVariablesFile(root, undefined, payload), /symbolic link/);
        await assert.rejects(() => fs.stat(outsideTarget), { code: "ENOENT" });
        assert.deepEqual(await fs.readdir(outside), []);
    }
});

test("generated file writes reject links to existing generated files", async t => {
    const { root, outside } = await workspace(t);
    const library = path.join(root, "Editor", "LuaLS");
    const target = path.join(library, "SavedVariables.lua");
    const outsideTarget = path.join(outside, "SavedVariables.lua");
    const original = Buffer.from(generatedHeader + "External = nil\n");
    await fs.mkdir(library, { recursive: true });
    await fs.writeFile(outsideTarget, original);
    if (!await linkOrSkip(t, outsideTarget, target, "file")) return;
    await assert.rejects(() => replaceSavedVariablesFile(root, original, Buffer.from(generatedHeader)), /symbolic link/);
    assert.deepEqual(await fs.readFile(outsideTarget), original);
});
