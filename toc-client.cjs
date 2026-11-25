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

function normalizeTocSelection({ client, textLocale } = {}) {
    const validClient = typeof client === "string" && clients.has(client);
    const validTextLocale = typeof textLocale === "string" && localePattern.test(textLocale);
    return {
        client: validClient ? client : undefined,
        textLocale: validTextLocale ? textLocale : undefined,
        invalidClient: client !== undefined && client !== "" && !validClient,
        invalidTextLocale: textLocale !== undefined && textLocale !== "" && !validTextLocale,
    };
}

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

function selectTocFileEntries({ metadata, entries }, settings) {
    const { client, textLocale: locale } = normalizeTocSelection(settings);
    const [family, game] = clients.get(client) ?? [];

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
    for (const { kind, fileEntry: entry, raw } of entries) {
        if (kind !== "file") continue;
        if (!entry.conditions.every(condition => isActive(condition, family, game, locale))) continue;
        const firstCondition = entry.conditions[0];
        // The SDK removes the condition itself but retains whitespace before and after it.
        const hasPrefix = firstCondition && raw.slice(0, firstCondition.source.range.start.column).trim() === "";
        const filePath = hasPrefix ? entry.path.trimStart() : entry.path;
        const expanded = filePath.replace(/\[([A-Za-z][A-Za-z0-9_]*)\]/g,
            (raw, token) => variables.get(token) ?? raw);
        if (/\.(?:lua|xml)$/i.test(expanded) && !/[\[\]]/.test(expanded)) selected.push({ entry, expanded });
    }
    return selected;
}

module.exports = { normalizeTocSelection, selectTocFileEntries };

