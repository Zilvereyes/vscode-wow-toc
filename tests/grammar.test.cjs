const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { before, test } = require("node:test");
const { Registry, parseRawGrammar, INITIAL } = require("vscode-textmate");
const onig = require("vscode-oniguruma");

const root = path.join(__dirname, "..");
const file = path.join(root, "grammars", "toc.tmLanguage.json");
let grammar;
let registry;

before(async () => {
    const wasm = fs.readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"));
    await onig.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
    registry = new Registry({
        onigLib: Promise.resolve({
            createOnigScanner: patterns => new onig.OnigScanner(patterns),
            createOnigString: value => new onig.OnigString(value),
        }),
        loadGrammar: async () => parseRawGrammar(fs.readFileSync(file, "utf8"), file),
    });
    grammar = await registry.loadGrammar("source.toc");
});

function expectScope(line, word, scope, state = INITIAL, offset = 0) {
    const column = line.indexOf(word, offset);
    assert.ok(column >= 0, word);
    const result = grammar.tokenizeLine(line, state);
    const token = result.tokens.find(t => t.startIndex <= column && t.endIndex > column);
    assert.equal(token.scopes.at(-1), scope, line + " / " + word);
    return result.ruleStack;
}

test("valid and invalid metadata use separate markers", () => {
    expectScope("## Interface : 11509", "##", "punctuation.definition.metadata.toc");
    expectScope("##Interface:11509", "11509", "string.value.toc");
    expectScope("## RequiredDeps: Core", "RequiredDeps", "entity.name.tag.toc");
    expectScope("## Secure: 1", "Secure", "entity.name.tag.restricted.toc");
    expectScope("## NotAField: example", "##", "invalid.illegal.metadata-marker.toc");
    expectScope("# Normal comment", "#", "comment.line.number-sign.toc");
});

test("locale and custom fields keep their scopes", () => {
    expectScope("## Title-deDE : ZilverUI", "Title", "entity.name.tag.toc");
    expectScope("## Title-deDE : ZilverUI", "deDE", "entity.name.tag.localized-code.toc");
    expectScope("## Title-deDE : ZilverUI", ":", "punctuation.separator.key-value.toc");
    expectScope("## X-Website: https://example.org", "X-Website", "entity.name.tag.custom.toc");
    expectScope("## Version: @project-version@", "@project-version@", "constant.other.packager.toc");
});

test("conditions and file variables work in the same file entry", () => {
    const prefix = "[AllowLoadGameType classic] Modules\\Core-[Family].lua";
    expectScope(prefix, "AllowLoadGameType", "keyword.tag.conditional.toc");
    expectScope(prefix, "classic", "string.unquoted.conditional-value.toc");
    expectScope(prefix, "Family", "entity.name.tag.variable.toc");
    expectScope(prefix, ".lua", "storage.type.lua.toc");
    const suffix = "[Game]\\Locale-[TextLocale].XML [AllowLoadTextLocale enUS]";
    expectScope(suffix, "Game", "entity.name.tag.variable.toc");
    expectScope(suffix, "TextLocale", "entity.name.tag.variable.toc");
    expectScope(suffix, ".XML", "storage.type.xml.toc");
    expectScope(suffix, "AllowLoadTextLocale", "keyword.tag.conditional.toc");
    expectScope(suffix, "enUS", "string.unquoted.conditional-value.toc");
    expectScope("Docs/Core.lua", "/", "invalid.path.separator.toc");
    expectScope("Docs\\Core.lua", "\\", "constant.character.path.separator.good.toc");
    expectScope("\\", "\\", "constant.character.path.separator.good.toc");
    expectScope("[Other]\\Core.lua", "Other", "entity.name.file.toc");
    expectScope("## Notes: [Game] and [AllowLoadGameType classic]", "[Game]", "string.value.toc");
});

test("WoW colors, texture and atlas tokens coexist without leaking to the next line", () => {
    const line = "## Notes: |cFF66CCFFColor|r |cnGREEN_FONT_COLOR:Name|r |cnIQ3:Rare|r|nNext";
    expectScope(line, "FF66CCFF", "constant.numeric.hex.toc");
    expectScope(line, "GREEN_FONT_COLOR", "support.constant.globalcolor.toc");
    expectScope(line, "3:Rare", "constant.numeric.itemquality.toc");
    expectScope(line, "|n", "constant.character.escape.toc");
    const media = "## Notes: |TInterface\\Icons\\Foo:16:24|t |A:common-icon-checkmark:16:24|a";
    expectScope(media, "\\", "constant.character.path.separator.good.toc");
    expectScope(media, "Foo", "support.constant.texture.toc");
    expectScope(media, "16:24", "constant.numeric.texture.toc");
    expectScope("## Notes: |TInterface/Icons/Foo:16:24|t", "/", "invalid.path.separator.toc");
    expectScope(media, "common-icon-checkmark", "string.unquoted.atlas-name.toc");
    expectScope(media, "|a", "constant.character.escape.toc");
    const state = expectScope("## Notes: |cFF66CCFFunfinished", "unfinished", "string.value.toc");
    expectScope("## Interface: 11509", "Interface", "entity.name.tag.toc", state);
});

test("theme contributes the recovered TOC palette to emitted scopes", () => {
    const manifest = require("../package.json");
    const contribution = manifest.contributes.themes.find(theme => theme.label === "WoW TOC Theme");
    const theme = JSON.parse(fs.readFileSync(path.join(root, contribution.path), "utf8"));
    registry.setTheme({ settings: theme.tokenColors });
    const colors = new Map(theme.tokenColors.flatMap(r => r.scope.map(s => [s, r.settings.foreground])));
    for (const [scope, value] of Object.entries({
        "punctuation.definition.metadata.toc": "#66CCFF",
        "invalid.illegal.metadata-marker.toc": "#F44747",
        "entity.name.tag.toc": "#99FF99",
        "entity.name.tag.variable.toc": "#66CCFF",
        "entity.name.tag.localized-code.toc": "#4A7DFF",
        "string.value.toc": "#FFD966",
        "constant.character.path.separator.good.toc": "#C586C0",
    })) {
        assert.equal(colors.get("source.toc " + scope), value, scope);
    }
    for (const [line, word, expected] of [
        ["## Interface: 11509", "##", "#66CCFF"],
        ["## Interface: 11509", "Interface", "#99FF99"],
        ["## Interface: 11509", "11509", "#FFD966"],
        ["## Title-deDE: ZilverUI", "deDE", "#4A7DFF"],
        ["## Invalid: value", "##", "#F44747"],
        ["Libs\\Core-[Family].lua", "\\", "#C586C0"],
        ["\\", "\\", "#C586C0"],
        ["Libs\\Core-[Family].lua", "Family", "#66CCFF"],
        ["## Notes: |TInterface\\Icons\\Foo:16:24|t", "\\", "#C586C0"],
    ]) {
        const column = line.indexOf(word);
        const { tokens } = grammar.tokenizeLine2(line, INITIAL);
        const palette = registry.getColorMap();
        for (let i = 0; i < tokens.length; i += 2) {
            if (tokens[i] <= column && (i + 2 === tokens.length || tokens[i + 2] > column)) {
                const foreground = (tokens[i + 1] & 0x00ff8000) >>> 15;
                assert.equal(palette[foreground], expected, line + " / " + word);
                break;
            }
        }
    }
});
