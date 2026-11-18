const clients = new Map([
    ["retail", ["Mainline", "Standard"]],
    ["classic-era", ["Classic", "Vanilla"]],
    ["tbc-classic", ["Classic", "TBC"]],
    ["wrath-classic", ["Classic", "Wrath"]],
    ["cataclysm-classic", ["Classic", "Cata"]],
    ["mists-classic", ["Classic", "Mists"]],
]);
const gameTypes = new Set([...clients.values()].flat().map(value => value.toLowerCase())
    .concat(["plunderstorm", "wowhack", "forever", "camelot"]));
const localePattern = /^[a-z]{2}[A-Z]{2}$/;
const gameDirectives = new Set(["allowloadgametype", "excludeloadgametype"]);

function isActive(condition, family, game, locale) {
    const values = condition.values;
    if (!values.length) return false;
    const name = condition.name.toLowerCase();
    if (name === "allowloadtextlocale") {
        return !!locale && values.every(value => localePattern.test(value)) && values.includes(locale);
    }
    const folded = values.map(value => value.toLowerCase());
    if (name === "allowload") {
        return folded.every(value => ["game", "glue", "both"].includes(value)) &&
            (folded.includes("game") || folded.includes("both"));
    }
    if (!gameDirectives.has(name) || !game || folded.some(value => !gameTypes.has(value))) return false;
    const matches = folded.includes(game.toLowerCase()) || folded.includes(family.toLowerCase());
    return name === "allowloadgametype" ? matches : !matches;
}

function selectXmlEntries(metadata, { client, textLocale }) {
    const [family, game] = clients.get(client) ?? [];
    const locale = typeof textLocale === "string" && localePattern.test(textLocale) ? textLocale : undefined;

    // Repeated unqualified game-type declarations append their allowed or excluded values.
    const manifestConditions = new Map();
    for (const directive of metadata.directives) {
        const name = directive.normalizedName;
        if (!gameDirectives.has(name)) continue;
        if (directive.conditions.length) return [];
        const values = directive.value.split(",").map(value => value.trim()).filter(Boolean);
        if (!values.length) return [];
        const all = manifestConditions.get(name) ?? [];
        all.push(...values);
        manifestConditions.set(name, all);
    }
    for (const [name, values] of manifestConditions) {
        if (!isActive({ name, values }, family, game, locale)) return [];
    }

    const variables = new Map([["Family", family], ["Game", game], ["TextLocale", locale]]);
    const selected = [];
    for (const entry of metadata.fileEntries) {
        if (!entry.conditions.every(condition => isActive(condition, family, game, locale))) continue;
        const expanded = entry.path.replace(/\[([A-Za-z][A-Za-z0-9_]*)\]/g,
            (raw, token) => variables.get(token) ?? raw);
        if (/\.xml$/i.test(expanded) && !/[\[\]]/.test(expanded)) selected.push({ entry, expanded });
    }
    return selected;
}

module.exports = { selectXmlEntries };

