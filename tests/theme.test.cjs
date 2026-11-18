const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { Registry, parseRawGrammar, INITIAL } = require("vscode-textmate");
const { parse } = require("jsonc-parser");
const onig = require("vscode-oniguruma");

const builtins = process.env.WOW_VSCODE_BUILTINS;
const themePath = path.join(__dirname, "../themes/wow-toc-color-theme.json");
function tokenColors(file) {
    const errors = [];
    const theme = parse(readFileSync(file, "utf8"), errors);
    assert.deepEqual(errors, [], file);
    return [...(theme.include ? tokenColors(path.resolve(path.dirname(file), theme.include)) : []), ...(theme.tokenColors ?? [])];
}

test("VS Code built-in Lua and XML grammars retain multiple colors with the TOC theme", {
    skip: !builtins && "Set WOW_VSCODE_BUILTINS to the VS Code built-in extensions folder",
}, async () => {
    const wasm = readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"));
    await onig.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
    const grammarFiles = {};
    for (const language of ["lua", "xml"]) {
        const root = path.join(builtins, language);
        const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
        for (const grammar of pkg.contributes.grammars) grammarFiles[grammar.scopeName] = path.join(root, grammar.path);
    }
    const registry = new Registry({
        theme: { settings: tokenColors(themePath) },
        onigLib: Promise.resolve({
            createOnigScanner: p => new onig.OnigScanner(p),
            createOnigString: v => new onig.OnigString(v),
        }),
        loadGrammar: async scope => {
            const f = grammarFiles[scope];
            return f ? parseRawGrammar(readFileSync(f, "utf8"), f) : null;
        },
    });
    for (const [scope, line, words] of [
        ["source.lua", 'local function example() return "text", 3 end -- comment', ["local", "example", "text", "3", "comment"]],
        ["text.xml", '<Ui><Script file="Foo.lua" /></Ui>', ["Ui", "file", "Foo.lua"]],
    ]) {
        const grammar = await registry.loadGrammar(scope);
        assert.ok(grammar, scope);
        const { tokens } = grammar.tokenizeLine2(line, INITIAL);
        const colors = words.map(word => {
            const col = line.indexOf(word);
            for (let i = 0; i < tokens.length; i += 2) {
                if (tokens[i] <= col && (i + 2 === tokens.length || tokens[i + 2] > col)) {
                    return registry.getColorMap()[(tokens[i + 1] & 0x00ff8000) >>> 15];
                }
            }
        });
        assert.ok(colors.every(Boolean), scope);
        assert.ok(new Set(colors).size >= 3, scope + ": " + colors.join(", "));
    }
});
