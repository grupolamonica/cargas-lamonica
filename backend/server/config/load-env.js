import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let hasLoadedEnv = false;

function parseEnvValue(rawValue) {
  const trimmedValue = rawValue.trim();

  if (!trimmedValue) {
    return "";
  }

  const doubleQuoted =
    trimmedValue.startsWith("\"") && trimmedValue.endsWith("\"") && trimmedValue.length >= 2;
  const singleQuoted =
    trimmedValue.startsWith("'") && trimmedValue.endsWith("'") && trimmedValue.length >= 2;

  if (doubleQuoted || singleQuoted) {
    const unquotedValue = trimmedValue.slice(1, -1);

    if (doubleQuoted) {
      return unquotedValue
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, "\"")
        .replace(/\\\\/g, "\\");
    }

    return unquotedValue;
  }

  return trimmedValue.replace(/\s+#.*$/, "").trim();
}

function parseEnvFileContents(contents) {
  const parsedEntries = [];

  contents.split(/\r?\n/).forEach((line) => {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      return;
    }

    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) {
      return;
    }

    const [, key, rawValue] = match;
    parsedEntries.push([key, parseEnvValue(rawValue)]);
  });

  return parsedEntries;
}

export function loadServerEnv() {
  if (hasLoadedEnv) {
    return;
  }

  hasLoadedEnv = true;

  const originalEnvKeys = new Set(Object.keys(process.env));
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDirectory = path.dirname(currentFilePath);
  const projectRoot = path.resolve(currentDirectory, "../../..");
  const envFiles = [".env", ".env.local"];

  envFiles.forEach((envFileName) => {
    const envFilePath = path.join(projectRoot, envFileName);

    if (!fs.existsSync(envFilePath)) {
      return;
    }

    const fileContents = fs.readFileSync(envFilePath, "utf8");
    const parsedEntries = parseEnvFileContents(fileContents);

    parsedEntries.forEach(([key, value]) => {
      if (originalEnvKeys.has(key)) {
        return;
      }

      process.env[key] = value;
    });
  });
}

loadServerEnv();
