const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const directoryParts = ["Editor", "LuaLS"];
const filename = "SavedVariables.lua";

function unsafePath() {
    return new Error("Refusing to generate Editor/LuaLS/SavedVariables.lua because its path contains " +
        "a symbolic link, reparse point, or non-directory component.");
}

function changedFile() {
    return new Error("The generated editor file changed during synchronization.");
}

function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === "" || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep);
}

async function lstatIfPresent(file) {
    try {
        return await fs.lstat(file);
    } catch (error) {
        if (error.code === "ENOENT") return undefined;
        throw error;
    }
}

async function inspectDirectory(root, directory) {
    const item = await fs.lstat(directory);
    if (item.isSymbolicLink() || !item.isDirectory()) throw unsafePath();
    const resolved = await fs.realpath(directory);
    if (!isInside(root, resolved)) throw unsafePath();
}

async function prepareLayout(rootPath) {
    const root = await fs.realpath(rootPath);
    await inspectDirectory(root, root);
    let library = root;
    for (const part of directoryParts) {
        await inspectDirectory(root, library);
        library = path.join(library, part);
        if (!await lstatIfPresent(library)) {
            try {
                await fs.mkdir(library);
            } catch (error) {
                if (error.code !== "EEXIST") throw error;
            }
        }
        await inspectDirectory(root, library);
    }
    return { root, library, target: path.join(library, filename) };
}

function sameFile(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}

async function inspectTarget(layout) {
    const item = await lstatIfPresent(layout.target);
    if (!item) return undefined;
    if (item.isSymbolicLink() || !item.isFile()) throw unsafePath();
    const resolved = await fs.realpath(layout.target);
    if (!isInside(layout.root, resolved)) throw unsafePath();
    return item;
}

async function readTarget(layout) {
    const before = await inspectTarget(layout);
    if (!before) return undefined;
    let handle;
    try {
        const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
        handle = await fs.open(layout.target, flags);
    } catch (error) {
        if (error.code === "ENOENT") throw changedFile();
        if (error.code === "ELOOP") throw unsafePath();
        throw error;
    }
    let opened;
    let bytes;
    try {
        opened = await handle.stat();
        if (!opened.isFile() || !sameFile(before, opened)) throw changedFile();
        bytes = await handle.readFile();
    } finally {
        await handle.close();
    }
    const after = await inspectTarget(layout);
    if (!after || !sameFile(opened, after)) throw changedFile();
    return { bytes, stat: after };
}

async function refreshedLayout(rootPath, expectedRoot) {
    const layout = await prepareLayout(rootPath);
    if (layout.root !== expectedRoot) throw changedFile();
    return layout;
}

async function expectedTarget(layout, expectedBytes) {
    const current = await readTarget(layout);
    if (expectedBytes === undefined) {
        if (current) throw changedFile();
    } else if (!current || !Buffer.from(current.bytes).equals(Buffer.from(expectedBytes))) {
        throw changedFile();
    }
    return current;
}

async function writeExclusive(file, bytes, mode) {
    const handle = await fs.open(file, "wx", mode);
    try {
        await handle.writeFile(bytes);
        if (mode !== undefined) await handle.chmod(mode);
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function readSavedVariablesFile(rootPath) {
    const layout = await prepareLayout(rootPath);
    const current = await readTarget(layout);
    return { path: layout.target, bytes: current?.bytes };
}

async function replaceSavedVariablesFile(rootPath, expectedBytes, replacementBytes) {
    const initial = await prepareLayout(rootPath);
    const current = await expectedTarget(initial, expectedBytes);
    const mode = current ? current.stat.mode & 0o777 : undefined;
    let backup;
    if (expectedBytes !== undefined) {
        const layout = await refreshedLayout(rootPath, initial.root);
        await expectedTarget(layout, expectedBytes);
        backup = layout.target + "." + randomUUID() + ".bak";
        await writeExclusive(backup, expectedBytes, mode);
    }

    const stagedLayout = await refreshedLayout(rootPath, initial.root);
    await expectedTarget(stagedLayout, expectedBytes);
    const staged = path.join(stagedLayout.library, "." + filename + "." + randomUUID() + ".tmp");
    try {
        await writeExclusive(staged, replacementBytes, mode);
        const finalLayout = await refreshedLayout(rootPath, initial.root);
        await expectedTarget(finalLayout, expectedBytes);
        if (finalLayout.library !== stagedLayout.library) throw changedFile();
        // Renaming a same-directory staged file replaces the final entry instead of following it.
        await fs.rename(staged, finalLayout.target);
        const completed = await readTarget(finalLayout);
        if (!completed || !Buffer.from(completed.bytes).equals(Buffer.from(replacementBytes))) throw changedFile();
        return { path: finalLayout.target, backup };
    } finally {
        try {
            await fs.unlink(staged);
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }
}

module.exports = { readSavedVariablesFile, replaceSavedVariablesFile };
