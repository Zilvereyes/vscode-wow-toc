const assert = require("node:assert/strict");
const { test } = require("node:test");
const { generateSavedVariables, generatedHeader } = require("../saved-variables.cjs");
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
