#!/usr/bin/env node
/**
 * Guard rails for the iOS shell. Runs in `npm run check` (and so in CI) before Xcode starts,
 * and catches the mistakes that would otherwise only show up on a phone or in App Review:
 *
 *  - the user-agent token matches what the server looks for (src/lib/billing/platform.ts),
 *  - the StoreKit test products match the product ids the server expects (src/lib/billing/product-ids.ts),
 *  - every Swift file in the app folder is part of the Xcode project (a forgotten file compiles on nobody's machine),
 *  - Info.plist has the camera purpose string and no permission Plenty doesn't use,
 *  - the App Store icon is 1024x1024 with no alpha channel,
 *  - the privacy manifest declares no tracking.
 *
 * It reads files only; it needs no packages.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(root, "..");
const appDir = join(root, "ios", "App", "App");
const failures = [];
const notes = [];
const fail = (message) => failures.push(message);

// 1. The user-agent token the shell sends must be one the server recognises.
{
  const config = readFileSync(join(root, "capacitor.config.ts"), "utf8");
  const token = /SHELL_USER_AGENT\s*=\s*"([^"]+)"/.exec(config)?.[1];
  const platformFile = join(repo, "src", "lib", "billing", "platform.ts");
  if (!token) {
    fail("capacitor.config.ts: SHELL_USER_AGENT not found.");
  } else if (!existsSync(platformFile)) {
    notes.push("src/lib/billing/platform.ts not found (mobile/ checked out on its own): user-agent check skipped.");
  } else {
    const literal = /\/(PlentyApp[^\n]*?)\/i\.exec/.exec(readFileSync(platformFile, "utf8"))?.[1];
    if (!literal) {
      fail("src/lib/billing/platform.ts: could not find the PlentyApp user-agent pattern to check against.");
    } else {
      const match = new RegExp(literal, "i").exec(`Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 ${token}`);
      if (match?.[1]?.toLowerCase() !== "ios") fail(`User-agent token "${token}" is not recognised as iOS by detectPlatform (/${literal}/i).`);
    }
  }
}

// 2. StoreKit test products match the ids the server expects.
{
  const storekit = JSON.parse(readFileSync(join(root, "ios", "App", "Plenty.storekit"), "utf8"));
  const subs = storekit.subscriptionGroups?.flatMap((g) => g.subscriptions ?? []) ?? [];
  const have = new Map(subs.map((s) => [s.productID, s]));
  const productIdsFile = join(repo, "src", "lib", "billing", "product-ids.ts");
  if (existsSync(productIdsFile)) {
    const block = /DEFAULT_STORE_PRODUCTS[^{]*\{([\s\S]*?)\}/.exec(readFileSync(productIdsFile, "utf8"))?.[1] ?? "";
    const expected = [...block.matchAll(/"([a-z]+)\.(monthly|annual)":\s*"([^"]+)"/g)].map((m) => ({ plan: m[1], period: m[2], id: m[3] }));
    if (expected.length !== 4) fail(`Expected 4 default store products in product-ids.ts, found ${expected.length}.`);
    for (const { period, id } of expected) {
      const sub = have.get(id);
      if (!sub) fail(`Plenty.storekit has no product ${id}.`);
      else if (sub.recurringSubscriptionPeriod !== (period === "monthly" ? "P1M" : "P1Y")) fail(`Plenty.storekit: ${id} has period ${sub.recurringSubscriptionPeriod}, expected ${period}.`);
    }
    if (have.size !== expected.length) fail(`Plenty.storekit has ${have.size} products, the server knows ${expected.length}.`);
  } else {
    notes.push("src/lib/billing/product-ids.ts not found: StoreKit product check skipped.");
  }
  if ((storekit.subscriptionGroups ?? []).length !== 1) fail("Plenty.storekit must have exactly one subscription group (one subscription at a time).");
}

// 3. Every Swift file in the app folder is in the Xcode project, in the Sources phase.
{
  const pbx = readFileSync(join(root, "ios", "App", "App.xcodeproj", "project.pbxproj"), "utf8");
  for (const file of readdirSync(appDir).filter((f) => f.endsWith(".swift"))) {
    if (!new RegExp(`${file.replace(".", "\\.")} in Sources`).test(pbx)) fail(`${file} is not compiled: add it to the Xcode project (Sources build phase).`);
  }
  if (!/PrivacyInfo\.xcprivacy in Resources/.test(pbx)) fail("PrivacyInfo.xcprivacy is not in the app target's Resources.");
  if (/TARGETED_DEVICE_FAMILY = "?1,2"?;/.test(pbx)) fail("TARGETED_DEVICE_FAMILY includes iPad; the shell is iPhone-only (App Store iPad screenshots and rotation rules would apply).");
}

// 4. Info.plist: purpose strings and nothing extra.
{
  const plist = readFileSync(join(appDir, "Info.plist"), "utf8");
  const keys = [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
  for (const required of ["NSCameraUsageDescription", "NSPhotoLibraryUsageDescription", "ITSAppUsesNonExemptEncryption", "UILaunchStoryboardName"]) {
    if (!keys.includes(required)) fail(`Info.plist is missing ${required}.`);
  }
  if (!/<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/.test(plist)) fail("ITSAppUsesNonExemptEncryption must be false (HTTPS only).");
  const unusedPermissions = keys.filter((k) => /^NS(Microphone|Location|Contacts|Calendars|Reminders|Bluetooth|HealthShare|HealthUpdate|Motion|FaceID|SpeechRecognition|UserTracking|LocalNetwork|PhotoLibraryAdd|AppleMusic|HomeKit|SiriUsage)/.test(k));
  if (unusedPermissions.length) fail(`Info.plist declares permissions Plenty doesn't use (Apple questions unexplained ones): ${unusedPermissions.join(", ")}.`);
  if (keys.includes("NSAppTransportSecurity")) fail("Info.plist weakens App Transport Security; the app must only talk HTTPS.");
  if (/UIInterfaceOrientation(Landscape|PortraitUpsideDown)/.test(plist)) fail("Info.plist allows more than portrait; the shell is portrait-only on iPhone.");
}

// 5. The App Store icon: 1024x1024, no alpha.
{
  const icon = readFileSync(join(appDir, "Assets.xcassets", "AppIcon.appiconset", "AppIcon-1024.png"));
  const isPng = icon.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!isPng) {
    fail("AppIcon-1024.png is not a PNG.");
  } else {
    const width = icon.readUInt32BE(16);
    const height = icon.readUInt32BE(20);
    const colorType = icon[25];
    const hasTransparencyChunk = icon.includes(Buffer.from("tRNS"));
    if (width !== 1024 || height !== 1024) fail(`AppIcon-1024.png is ${width}x${height}, must be 1024x1024.`);
    if (colorType === 4 || colorType === 6 || hasTransparencyChunk) fail("AppIcon-1024.png has an alpha channel; the App Store rejects that.");
  }
}

// 6. Privacy manifest: no tracking, no tracking domains.
{
  const manifest = readFileSync(join(appDir, "PrivacyInfo.xcprivacy"), "utf8");
  if (!/<key>NSPrivacyTracking<\/key>\s*<false\/>/.test(manifest)) fail("PrivacyInfo.xcprivacy: NSPrivacyTracking must be false.");
  if (!/<key>NSPrivacyTrackingDomains<\/key>\s*<array\/>/.test(manifest)) fail("PrivacyInfo.xcprivacy: NSPrivacyTrackingDomains must be empty.");
  if (/<key>NSPrivacyCollectedDataTypeTracking<\/key>\s*<true\/>/.test(manifest)) fail("PrivacyInfo.xcprivacy: no data type may be used for tracking.");
  // Required-reason APIs: the app's own Swift code must not use any without declaring it.
  const reasonApis = [
    ["UserDefaults", "NSPrivacyAccessedAPICategoryUserDefaults"],
    ["creationDate|modificationDate|fileModificationDate|contentModificationDateKey|creationDateKey|attributesOfItem|NSFileCreationDate|NSFileModificationDate", "NSPrivacyAccessedAPICategoryFileTimestamp"],
    ["systemUptime|mach_absolute_time", "NSPrivacyAccessedAPICategorySystemBootTime"],
    ["volumeAvailableCapacity|volumeTotalCapacity|systemFreeSize|systemSize", "NSPrivacyAccessedAPICategoryDiskSpace"],
    ["activeInputModes", "NSPrivacyAccessedAPICategoryActiveKeyboards"],
  ];
  for (const file of readdirSync(appDir).filter((f) => f.endsWith(".swift"))) {
    const code = readFileSync(join(appDir, file), "utf8").replace(/\/\/.*$/gm, "");
    for (const [pattern, category] of reasonApis) {
      if (new RegExp(`\\b(${pattern})\\b`).test(code) && !manifest.includes(category)) {
        fail(`${file} uses an API that needs a reason in the privacy manifest (${category}); add it to PrivacyInfo.xcprivacy.`);
      }
    }
  }
}

for (const note of notes) console.log(`note: ${note}`);
if (failures.length) {
  console.error(failures.map((f) => `verify-shell: ${f}`).join("\n"));
  process.exit(1);
}
console.log("verify-shell: all checks passed.");
