import { inflateRawSync } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = path.join(root, "apps", "vscode");
const requestedPath = process.argv[2];

async function findVsix() {
  if (requestedPath) return path.resolve(requestedPath);
  const candidates = (await readdir(extensionDir))
    .filter((name) => name.endsWith(".vsix"))
    .sort()
    .reverse();
  if (candidates.length === 0) throw new Error("No VSIX found. Run npm run package first.");
  return path.join(extensionDir, candidates[0]);
}

function listZipEntries(buffer) {
  const endOfCentralDirectory = 0x06054b50;
  const centralDirectoryEntry = 0x02014b50;
  const minimumEndRecord = 22;
  const searchStart = Math.max(0, buffer.length - 0xffff - minimumEndRecord);
  let endOffset = -1;

  for (let offset = buffer.length - minimumEndRecord; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === endOfCentralDirectory) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("The VSIX is not a valid ZIP archive.");

  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(endOffset + 16);
  const entries = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== centralDirectoryEntry) {
      throw new Error(`Invalid central-directory entry at offset ${offset}.`);
    }
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const fileName = buffer.toString("utf8", offset + 46, offset + 46 + fileNameLength);
    entries.push(fileName);
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntry(buffer, wantedName) {
  const centralDirectoryEntry = 0x02014b50;
  const localFileEntry = 0x04034b50;
  const endOfCentralDirectory = 0x06054b50;
  const minimumEndRecord = 22;
  const searchStart = Math.max(0, buffer.length - 0xffff - minimumEndRecord);
  let endOffset = -1;
  for (let offset = buffer.length - minimumEndRecord; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === endOfCentralDirectory) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("The VSIX is not a valid ZIP archive.");
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  let offset = buffer.readUInt32LE(endOffset + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== centralDirectoryEntry) throw new Error(`Invalid central-directory entry at offset ${offset}.`);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const fileName = buffer.toString("utf8", offset + 46, offset + 46 + fileNameLength);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (fileName === wantedName) {
      if (buffer.readUInt32LE(localOffset) !== localFileEntry) throw new Error(`Invalid local-file entry for ${wantedName}.`);
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(start, start + compressedSize);
      return method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : (() => { throw new Error(`Unsupported ZIP compression method ${method}.`); })();
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  throw new Error(`VSIX is missing ${wantedName}.`);
}

const vsixPath = await findVsix();
const entries = listZipEntries(await readFile(vsixPath));
const required = [
  "extension/package.json",
  "extension/readme.md",
  "extension/package.nls.json",
  "extension/LICENSE.txt",
  "extension/NOTICE",
  "extension/changelog.md",
  "extension/dist/extension.js",
  "extension/dist/browser.js",
  "extension/dist/browserWorker.js",
  "extension/server/server.js",
  "extension/syntaxes/bend.tmLanguage.json",
];
const missing = required.filter((entry) => !entries.includes(entry));
if (missing.length > 0) {
  throw new Error(`VSIX is missing required files: ${missing.join(", ")}`);
}
const developmentOnly = entries.filter((entry) => /(^|\/)(?:test|tests)\/|\.map$/.test(entry));
if (developmentOnly.length > 0) {
  throw new Error(`VSIX contains development-only files: ${developmentOnly.join(", ")}`);
}

const packagedManifest = JSON.parse(readZipEntry(await readFile(vsixPath), "extension/package.json").toString("utf8"));
const packagedNls = JSON.parse(readZipEntry(await readFile(vsixPath), "extension/package.nls.json").toString("utf8"));
const metadataChecks = [
  ["name", packagedManifest.name],
  ["publisher", packagedManifest.publisher],
  ["version", packagedManifest.version],
  ["license", packagedManifest.license],
  ["repository.url", packagedManifest.repository?.url],
  ["engines.vscode", packagedManifest.engines?.vscode],
];
const missingMetadata = metadataChecks.filter(([, value]) => typeof value !== "string" || value.trim().length === 0).map(([name]) => name);
if (missingMetadata.length > 0) throw new Error(`VSIX manifest is missing release metadata: ${missingMetadata.join(", ")}.`);

const localizationReferences = [];
function collectLocalizationReferences(value, location) {
  if (typeof value === "string") {
    const match = /^%([^%]+)%$/.exec(value);
    if (match) localizationReferences.push({ key: match[1], location });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectLocalizationReferences(item, `${location}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => collectLocalizationReferences(item, `${location}.${key}`));
  }
}
collectLocalizationReferences(packagedManifest, "package.json");
const missingLocalization = localizationReferences.filter(({ key }) => typeof packagedNls[key] !== "string");
if (missingLocalization.length > 0) {
  throw new Error(`VSIX manifest has missing English localization keys: ${missingLocalization.map(({ key, location }) => `${key} (${location})`).join(", ")}.`);
}

const packagedCommands = new Set((packagedManifest.contributes?.commands ?? []).map((command) => command.command));
for (const command of ["bend2.compareProjectBackends", "bend2.probeBackend", "bend2.showExecutionEnvironment", "bend2.copySupportDiagnostics"]) {
  if (!packagedCommands.has(command)) throw new Error(`VSIX manifest is missing command ${command}.`);
}
if (!packagedManifest.contributes?.configuration?.properties?.["bend2.executableArgs"]) {
  throw new Error("VSIX manifest is missing bend2.executableArgs configuration.");
}
if (packagedManifest.browser !== "./dist/browser.js") throw new Error("VSIX manifest does not point to the browser entrypoint.");

console.log(`VSIX contents passed: ${path.relative(root, vsixPath)} (${entries.length} entries).`);
