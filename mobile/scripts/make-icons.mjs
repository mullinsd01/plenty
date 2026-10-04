#!/usr/bin/env node
/**
 * Regenerates the app icon and launch-screen logo from the website's brand icon
 * (src/app/icon.svg). The results are committed, so CI and Xcode never run this.
 *
 *   node mobile/scripts/make-icons.mjs
 *
 * Uses `sharp` from the website's node_modules (the root package.json), because
 * mobile/ deliberately has no image tooling of its own.
 *
 * Outputs (under mobile/ios/App/App/Assets.xcassets):
 *   AppIcon.appiconset/AppIcon-1024.png   1024x1024, opaque, square corners
 *                                         (the App Store rejects alpha and pre-rounded corners;
 *                                         iOS rounds the icon itself)
 *   LaunchLogo.imageset/launch-logo{,@2x,@3x}.png  the coral mark on transparent
 */

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const require = createRequire(join(repoRoot, "package.json"));
const sharp = require("sharp");

const assets = join(here, "..", "ios", "App", "App", "Assets.xcassets");
const svgSource = readFileSync(join(repoRoot, "src", "app", "icon.svg"), "utf8");

// The brand colours, read from the icon itself so they cannot drift from it.
const background = /<rect[^>]*fill="(#[0-9a-fA-F]{6})"/.exec(svgSource)?.[1];
const coral = /<g[^>]*fill="(#[0-9a-fA-F]{6})"/.exec(svgSource)?.[1];
const group = /<g[^>]*>[\s\S]*<\/g>/.exec(svgSource)?.[0];
const groupTransform = /<g[^>]*transform="([^"]+)"/.exec(svgSource)?.[1];
if (!background || !coral || !group || !groupTransform) {
  throw new Error("src/app/icon.svg is not in the shape this script expects (rect background, one <g> with the mark).");
}

// 1024x1024 App Store icon: the brand square with no rounded corners, no alpha.
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="1024" height="1024">
  <rect width="512" height="512" fill="${background}"/>
  ${group}
</svg>`;
mkdirSync(join(assets, "AppIcon.appiconset"), { recursive: true });
const iconPath = join(assets, "AppIcon.appiconset", "AppIcon-1024.png");
await sharp(Buffer.from(iconSvg))
  .resize(1024, 1024)
  .flatten({ background })
  .removeAlpha()
  .png()
  .toFile(iconPath);

// Where the mark sits inside the 512 box, so the launch logo is cropped to it.
const markOnly = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="2048" height="2048">${group}</svg>`;
const { info: trimInfo } = await sharp(Buffer.from(markOnly)).trim({ threshold: 1 }).png().toBuffer({ resolveWithObject: true });
const scale = 2048 / 512;
const box = {
  x: -trimInfo.trimOffsetLeft / scale,
  y: -trimInfo.trimOffsetTop / scale,
  w: trimInfo.width / scale,
  h: trimInfo.height / scale,
};

// Launch logo: the mark alone, 1x/2x/3x of a fixed height in points.
const logoHeightPt = 112;
const logoWidthPt = Math.round((logoHeightPt * box.w) / box.h);
mkdirSync(join(assets, "LaunchLogo.imageset"), { recursive: true });
for (const [suffix, factor] of [["", 1], ["@2x", 2], ["@3x", 3]]) {
  const w = logoWidthPt * factor;
  const h = logoHeightPt * factor;
  const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x} ${box.y} ${box.w} ${box.h}" width="${w}" height="${h}">${group}</svg>`;
  await sharp(Buffer.from(logoSvg)).resize(w, h).png().toFile(join(assets, "LaunchLogo.imageset", `launch-logo${suffix}.png`));
}

// Report, so the storyboard and the offline page can be kept in step.
const m = /translate\(([-\d.]+)\s+([-\d.]+)\)\s*scale\(([-\d.]+)\)/.exec(groupTransform);
const [tx, ty, sc] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 1];
const own = { x: (box.x - tx) / sc, y: (box.y - ty) / sc, w: box.w / sc, h: box.h / sc };
console.log(JSON.stringify({ background, coral, markBoxIn512: box, markBoxInOwnUnits: own, logoPt: [logoWidthPt, logoHeightPt] }, null, 2));
const meta = await sharp(iconPath).metadata();
console.log(`AppIcon-1024.png: ${meta.width}x${meta.height}, channels=${meta.channels}, hasAlpha=${meta.hasAlpha}`);
