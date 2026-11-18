const { execFileSync } = require("node:child_process");
const { copyFile } = require("node:fs/promises");
const path = require("node:path");
const { build } = require("esbuild");

const input = process.argv[2];
if (!input) throw new Error("Usage: npm run build:sdk -- <built wow-addon-sdk checkout>");
const sdk = path.resolve(input);
const pin = require("./sdk-source.json");
const revision = execFileSync("git", ["-C", sdk, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const version = require(path.join(sdk, "package.json")).version;
if (revision !== pin.revision || version !== pin.version) {
    throw new Error("Expected wow-addon-sdk " + pin.version + " at " + pin.revision);
}
const entry = name => JSON.stringify(path.join(sdk, "packages", name, "dist", "index.js"));
const source = "export {parseToc} from " + entry("toc-parser") + ";\n"
    + "export {toGlobalDeclarations} from " + entry("toc-metadata-adapter") + ";\n"
    + "export {analyzeXml} from " + entry("xml-analysis") + ";\n";
build({
    stdin: { contents: source, resolveDir: sdk },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: path.join(__dirname, "dist", "sdk.cjs"),
}).then(() => copyFile(path.join(sdk, "LICENSE"), path.join(__dirname, "dist", "SDK-LICENSE.txt")))
    .catch(error => { console.error(error); process.exitCode = 1; });
