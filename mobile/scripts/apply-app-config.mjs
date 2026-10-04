#!/usr/bin/env node
/**
 * Keeps the Xcode project in step with mobile/app.config.json, the one place that
 * says what the app is called, its bundle id, version, build number and team.
 *
 *   node scripts/apply-app-config.mjs            write the values into the Xcode project
 *   node scripts/apply-app-config.mjs --check    change nothing; exit 1 if they differ
 *
 * `npx cap sync` runs this by itself (package.json: "capacitor:sync:before"), so the
 * project can't drift from the config. capacitor.config.ts reads the same file for
 * the bundle id and app name that Capacitor writes into its own config.
 *
 * Environment overrides (used by CI, never committed):
 *   PLENTY_BUILD_NUMBER   the build number (CI passes the run number)
 *   PLENTY_TEAM_ID        the Apple developer team id (10 letters and digits)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

const config = JSON.parse(readFileSync(join(root, "app.config.json"), "utf8"));

const bundleId = String(config.bundleId ?? "");
const version = String(config.version ?? "");
const appName = String(config.appName ?? "");
const buildNumber = String(process.env.PLENTY_BUILD_NUMBER?.trim() || config.buildNumber || "");
const teamId = String(process.env.PLENTY_TEAM_ID?.trim() || config.teamId || "");

const problems = [];
if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(bundleId)) {
  problems.push(`bundleId "${bundleId}" must look like app.plenty.household (letters, digits, hyphens, dots).`);
}
if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`version "${version}" must look like 1.0.0.`);
if (!/^[1-9]\d{0,8}$/.test(buildNumber)) problems.push(`buildNumber "${buildNumber}" must be a whole number of 1 or more.`);
if (teamId && !/^[A-Z0-9]{10}$/.test(teamId)) problems.push(`teamId "${teamId}" must be 10 capital letters and digits (Apple Developer account, Membership details).`);
if (!appName.trim() || /[<>&"]/.test(appName)) problems.push(`appName "${appName}" must be non-empty and contain none of < > & ".`);
if (problems.length) {
  console.error(problems.map((p) => `app.config.json: ${p}`).join("\n"));
  process.exit(1);
}

const pbxPath = join(root, "ios", "App", "App.xcodeproj", "project.pbxproj");
const plistPath = join(root, "ios", "App", "App", "Info.plist");

function replaceSetting(text, key, value, expectedCount) {
  const pattern = new RegExp(`(\\b${key} = )[^;]*;`, "g");
  const found = text.match(pattern)?.length ?? 0;
  if (found !== expectedCount) {
    throw new Error(`Expected ${expectedCount} "${key}" settings in project.pbxproj, found ${found}. The Xcode project changed shape; update scripts/apply-app-config.mjs.`);
  }
  return text.replace(pattern, `$1${value};`);
}

let pbx = readFileSync(pbxPath, "utf8");
const pbxBefore = pbx;
// Two build configurations (Debug, Release) on the one app target.
pbx = replaceSetting(pbx, "PRODUCT_BUNDLE_IDENTIFIER", bundleId, 2);
pbx = replaceSetting(pbx, "MARKETING_VERSION", version, 2);
pbx = replaceSetting(pbx, "CURRENT_PROJECT_VERSION", buildNumber, 2);
pbx = replaceSetting(pbx, "DEVELOPMENT_TEAM", teamId ? teamId : '""', 2);

let plist = readFileSync(plistPath, "utf8");
const plistBefore = plist;
const displayName = /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/;
if (!displayName.test(plist)) throw new Error("Info.plist has no CFBundleDisplayName.");
plist = plist.replace(displayName, `$1${appName}$2`);

const changed = [];
if (pbx !== pbxBefore) changed.push("ios/App/App.xcodeproj/project.pbxproj");
if (plist !== plistBefore) changed.push("ios/App/App/Info.plist");

if (checkOnly) {
  if (changed.length) {
    console.error(`Out of step with app.config.json: ${changed.join(", ")}. Run: npm run apply-config`);
    process.exit(1);
  }
  console.log(`Xcode project matches app.config.json (${bundleId}, ${version} (${buildNumber})).`);
} else {
  if (pbx !== pbxBefore) writeFileSync(pbxPath, pbx);
  if (plist !== plistBefore) writeFileSync(plistPath, plist);
  console.log(
    `${changed.length ? "Updated" : "Already up to date:"} ${bundleId}, version ${version} (${buildNumber})` +
      `${teamId ? `, team ${teamId}` : ", no team set"}${changed.length ? ` in ${changed.join(", ")}` : ""}.`,
  );
}
