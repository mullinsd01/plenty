# iPhone app: build, test and release

A plain-language runbook for getting Plenty onto the App Store. You do not need a Mac or any Xcode experience: GitHub builds the app on a Mac it rents for you, signs it, and sends it to TestFlight.

Written 2026-10-04. Read [`docs/store/ship-plan.md`](store/ship-plan.md) for the calendar and [`docs/billing.md`](billing.md) for how subscriptions work on the server. Apple's screens and rules move; where this guide names a button it describes what was true when it was written, so trust Apple's current wording over this page if they differ.

**Important, in one paragraph.** The iPhone app is a thin native shell around the website: it opens your hosted Plenty site in a web view, adds the camera permission, the "Can't reach Plenty" screen, and Apple's purchase sheet (in-app purchase). It was written on a Linux machine that cannot run Xcode, so the first compile was left to GitHub's Mac machines. **That first Build check passed (4 Oct 2026, Xcode 26.6, simulator, no signing): `BUILD SUCCEEDED`, and the built app's Info.plist, privacy manifest, offline page and user-agent token checked out.** It has still never run on a phone, and signing, export and upload have never run. **The first real test is on your iPhone.** Section 9 lists exactly what is unverified. Expect a round or two of fixes after the first TestFlight build; that is normal and is what the calendar's buffer is for.

Contents: [1 What you need](#1-what-you-need-and-two-decisions) · [2 Apple accounts](#2-apple-developer-account-and-app-record) · [3 GitHub secrets](#3-github-secrets-and-variables) · [4 Build and upload](#4-build-and-upload-to-testflight) · [5 Install on your iPhone](#5-install-on-your-iphone) · [6 What to test](#6-what-to-test-on-the-phone) · [7 Subscriptions](#7-subscriptions-app-store-connect-and-sandbox-testing) · [8 Submit for review](#8-submit-for-review) · [9 Not verified](#9-what-has-not-been-verified-and-needs-a-real-device) · [10 Day-to-day](#10-changing-things-later) · [11 Technical notes](#11-technical-notes-for-developers)

---

## 1. What you need, and two decisions

| You need | Notes |
|---|---|
| An Apple ID with two-factor authentication on | Used to enrol. |
| The Apple Developer Program (US$99 a year) | Section 2. |
| The hosted Plenty site, live on https, with the production settings in `docs/billing.md` | The app is useless without it: it loads the site. The site must stay up while Apple reviews. |
| A GitHub repository with Actions enabled | Builds on a rented Mac. macOS minutes cost more than Linux minutes; one build is about 15 to 25 minutes. |
| An iPhone with the TestFlight app | Section 5. |

### Decision 1: the bundle id (permanent)

The bundle id is the app's permanent name on Apple's systems, for example `app.plenty.household`. **Once you create the app record and upload a build you can never change it.** It is set in one place: [`mobile/app.config.json`](../mobile/app.config.json) (`bundleId`). The default is `app.plenty.household`, a placeholder.

* Use a name under a domain you control, written backwards (`com.yourcompany.plenty`).
* **Change it now, before step 2.3.** If you register it or create the App Store Connect record with the placeholder, you are stuck with it.
* The server must be told the same value: `APPLE_BUNDLE_ID` in the production environment ([`docs/billing.md`](billing.md#app-store-ios)). If they differ, every purchase is refused.

### Decision 2: the site address (`PLENTY_URL`)

The app is built to open one address, for example `https://plenty.example.com`.

* https only, the site's root, no path (`https://plenty.example.com`, not `https://plenty.example.com/app`).
* It is baked into the app when it is built. Changing the domain later means a new build and a new App Store release. Use the real production address from the first build.
* It is set as a GitHub **variable** (section 3), not in the code.

---

## 2. Apple Developer account and app record

### 2.1 Enrol in the Apple Developer Program

1. Go to developer.apple.com, choose **Account**, sign in with your Apple ID, and enrol. Choose **Individual** or **Organization**. An organisation needs a D-U-N-S number (a free business identifier that can take days or weeks to arrive), and the app is then published under the company name. An individual account publishes under your own name, and Apple lets you move to an organisation later with some friction.
2. Pay the fee. Approval can take from minutes to several days; Apple may phone or ask for ID.
3. When approved, open **Membership details** and copy your **Team ID** (ten letters and digits). You need it in section 3.

### 2.2 Agreements, banking and tax (needed to sell subscriptions)

In **App Store Connect** (appstoreconnect.apple.com), open **Business** (older name: Agreements, Tax and Banking). Accept the **Paid Applications** agreement and fill in banking and tax details. Apple checks these; it can take a few days. Start this on day one, because subscriptions cannot be tested properly or reviewed until it is "Active".

### 2.3 Register the bundle id

1. developer.apple.com → **Certificates, Identifiers & Profiles** → **Identifiers** → **+** → **App IDs** → **App** → continue.
2. Description: `Plenty`. Bundle ID: choose **Explicit** and type your bundle id exactly as in `mobile/app.config.json`.
3. Leave the capabilities as they are (In-App Purchase is available to every app). Register.

(If you skip this, the first build can usually register it automatically, but doing it by hand shows any problem sooner.)

### 2.4 Create the app record

App Store Connect → **Apps** → **+** → **New App**:

| Field | Value |
|---|---|
| Platforms | iOS |
| Name | Plenty (must be unique on the App Store; Apple will tell you if it is taken) |
| Primary language | English (Australia) or your choice |
| Bundle ID | the one you registered (it appears in the list once registered) |
| SKU | any private label, for example `plenty-ios-1` |
| User access | Full access |

The app's numeric **Apple ID** (App Store Connect → the app → **App Information** → General Information) is needed by the server as `APPLE_APP_ID`.

### 2.5 Create the API key GitHub uses

GitHub signs and uploads with an App Store Connect API key, so it never needs your password.

1. App Store Connect → **Users and Access** → **Integrations** → **App Store Connect API** → **Team Keys** → **Generate API Key** (or **+**).
2. Name: `GitHub builds`. Access: **Admin** (the build needs to create signing certificates and profiles; a lower role may be refused).
3. **Download the `.p8` file straight away: Apple lets you download it once.** Keep it somewhere safe and never commit it (the repository's `.gitignore` blocks `*.p8`).
4. On the same page note the **Key ID** (ten characters, next to the key) and the **Issuer ID** (a UUID at the top of the page).

---

## 3. GitHub secrets and variables

GitHub repository → **Settings** → **Secrets and variables** → **Actions**.

| Name | Kind | Where it comes from |
|---|---|---|
| `APP_STORE_CONNECT_KEY_ID` | Secret | The Key ID from step 2.5. |
| `APP_STORE_CONNECT_ISSUER_ID` | Secret | The Issuer ID from step 2.5. |
| `APP_STORE_CONNECT_KEY_P8` | Secret | The `.p8` file, base64 encoded (below). Pasting the plain text of the file also works. |
| `APPLE_TEAM_ID` | Secret | Team ID from step 2.1. |
| `PLENTY_URL` | **Variable** (the Variables tab, not Secrets) | The site address, for example `https://plenty.example.com`. |

Base64 encoding the key, on whatever computer you have:

* Mac: `base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy` (copies it)
* Linux: `base64 -w0 AuthKey_XXXXXXXXXX.p8`
* Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("AuthKey_XXXXXXXXXX.p8"))`

The build job stops at its first step and names anything missing, so a forgotten secret costs seconds, not a 20-minute build.

---

## 4. Build and upload to TestFlight

The workflow is [`.github/workflows/ios.yml`](../.github/workflows/ios.yml).

* **Automatic check:** every push that changes anything in `mobile/` runs **Build check (simulator, no signing)**. It needs no secrets and shows Swift compile errors in the log. A red check there means the app does not compile.
* **Release to TestFlight:** either
  * GitHub → **Actions** → **iOS** → **Run workflow** (pick the branch), or
  * push a tag: `git tag ios-v1.0.0 && git push origin ios-v1.0.0`. The tag must start with the version in `mobile/app.config.json` (a mismatch stops the build, so you cannot ship the wrong version by accident).

What the release does: checks your settings → installs dependencies → runs the project's guard-rail checks → archives the app with automatic signing → exports an `.ipa` → checks the bundle id, build number and privacy file inside it → uploads it to App Store Connect. The build number is the GitHub run number, so it goes up on every run (Apple refuses a repeat). If an upload fails, run the workflow again rather than "re-running" the old run, which would reuse the number.

After a successful run: App Store Connect → your app → **TestFlight**. The build shows as "Processing" for 10 to 30 minutes, then appears. The encryption question is already answered in the app (it only uses HTTPS), so there is no "Missing Compliance" prompt.

### If a run fails

Open the failed run, read the red step, and download the **logs** artifact at the bottom of the page. Send the log to whoever is fixing the code. Frequent causes:

| What the log says | Meaning |
|---|---|
| `Not set: secret …` | A secret or the `PLENTY_URL` variable is missing (section 3). |
| `PLENTY_URL must start with https://` | The variable is wrong. |
| Swift errors such as `cannot find 'X' in scope` in the *Build for the simulator* step | A real code error in the app. Expected on the first run. |
| `No profiles for 'your.bundle.id' were found` / `Communication with Apple failed` / `forbidden` | The API key lacks permission (make it **Admin**), or the Team ID is wrong, or the bundle id was not registered (step 2.3). |
| `The bundle version must be higher than the previously uploaded version` | The build number was used before. Start a new run. |
| `Xcode 26 or newer is required` | GitHub's Mac image is older than Apple's minimum. Tell the developer; the workflow picks the newest Xcode installed. |
| The altool step fails, the `.ipa` artifact exists | Apple's upload tool failed. The workflow tries a second upload method by itself. If both fail, download the `.ipa` artifact and upload it with Apple's free **Transporter** app (Mac App Store). |

---

## 5. Install on your iPhone

1. App Store Connect → **Users and Access**: make sure your Apple ID is a user (you are, if you are the account holder).
2. App Store Connect → your app → **TestFlight** → **Internal Testing** → **+** to create a group (for example "Me") → add yourself → add the build.
3. On the iPhone: install **TestFlight** from the App Store, sign in with the same Apple ID, open it, and tap **Install** next to Plenty. Internal testers do not need Apple's review. Builds expire after 90 days.
4. Open Plenty. Purchases in a TestFlight build use Apple's **sandbox**: no real money moves.

---

## 6. What to test on the phone

Do this on a real iPhone (the simulator has no camera). Write down anything odd with a screenshot.

**Launch and sign in**
- [ ] Launch screen shows the Plenty mark on cream (dark grey if the phone is in dark mode), then the app. No white flash.
- [ ] Sign in with the demo account (`demo@plenty.app`) and with a new account you create.
- [ ] Close the app completely and reopen it: you are still signed in.

**Safe areas and layout** (the notch, the clock at the top, the home bar at the bottom)
- [ ] On **every** screen, including sign-in, sign-up, onboarding and the legal pages: no text sits under the clock or the camera island, nothing hides under the home bar.
- [ ] The bottom navigation sits above the home bar and its buttons are easy to tap.
- [ ] Turn the phone sideways: the app stays upright (portrait only).

**Camera**
- [ ] Tap **Scan a receipt** → **Take a photo**: iPhone asks once, with the wording "Plenty uses the camera when you choose to photograph a receipt or scan a barcode." The camera opens only after you tap, never at launch.
- [ ] Say Don't Allow, then tap again: the page shows a sensible message rather than hanging, and **Choose a photo** still works. (To allow the camera later: Settings → Plenty → Camera.)
- [ ] Barcode scanner (Plus): the camera opens inside the page, a barcode scans, and leaving the page turns the camera light off.
- [ ] Choose a photo from the library: the photo picker opens and the photo uploads.

**Keyboard**
- [ ] Tapping a text field brings up the keyboard and the field stays visible above it (try the lowest field on a form and a sheet).
- [ ] The fixed buttons at the bottom of a screen do not jump or get stuck when the keyboard closes.

**Navigation and links**
- [ ] Swipe from the left edge goes back.
- [ ] Pulling down at the top of a page does not refresh it.
- [ ] Terms and Privacy open (inside the app) and you can get back.
- [ ] A link to another site (for example a store's subscription page) opens in Safari, not in the app.
- [ ] Selecting and copying recipe text works by long-press.

**Offline screen**
- [ ] Turn on Airplane Mode, force-quit and reopen Plenty: you see **Can't reach Plenty** in the Plenty colours.
- [ ] Turn Airplane Mode off and tap **Try again**: the app loads (it also retries by itself when the network returns).
- [ ] Open the app online, switch to Airplane Mode and tap something that loads a whole new page (for example Terms): the offline screen appears, and Try again recovers it. Note that moving between screens inside the app is done by the website without loading a new page; when that fails offline it is the website's own error handling you see, not this screen.

**Subscriptions** (section 7)
- [ ] The plan screen shows Apple's own prices, a Subscribe button, **Restore purchases**, Terms and Privacy links, and **no** web checkout, billing-portal link or Stripe mention anywhere.

**Privacy**
- [ ] Settings → Account → Delete my account works end to end on a fresh account.

---

## 7. Subscriptions: App Store Connect and sandbox testing

Plenty sells four auto-renewing subscriptions in **one** subscription group, so a person can only hold one at a time. The product ids come from the server ([`src/lib/billing/product-ids.ts`](../src/lib/billing/product-ids.ts)); use them exactly, and keep the prices equal to [`src/lib/billing/plans.ts`](../src/lib/billing/plans.ts).

| Product id | Plan | Duration | US price |
|---|---|---|---|
| `app.plenty.plus.monthly` | Plus | 1 month | $4.99 |
| `app.plenty.plus.annual` | Plus | 1 year | $49.99 |
| `app.plenty.family.monthly` | Family | 1 month | $8.99 |
| `app.plenty.family.annual` | Family | 1 year | $89.99 |

If you must use different ids, set `APPLE_PRODUCTS` on the server instead of changing code (see `docs/billing.md`). Product ids are permanent too.

### 7.1 App Store Connect steps, in order

1. **Paid Applications agreement, banking and tax: Active** (section 2.2). Nothing below can be finished without it.
2. Your app → **Monetization** → **Subscriptions** → **Create** a **Subscription Group**: reference name `Plenty plans`. Add a localisation for the group (display name `Plenty`).
3. In that group, **Create** four subscriptions with the table above:
   - Reference name (for you): for example `Plus monthly`.
   - Product ID: from the table.
   - Subscription duration: 1 month or 1 year.
   - **Subscription price**: set the US price from the table; Apple fills in the other countries (you can edit them). The app shows each person the price for their own country.
   - Leave Family Sharing **off** (the server does not support family-shared subscriptions).
   - **Do not add an introductory offer or free trial.** The server and the listing say there is none (`TRIAL_DAYS = 0`).
4. **Localisation for each product** (at least English): display name `Plenty Plus` or `Plenty Family`, and a short description (Apple limits it to a few dozen characters; for example `Unlimited items, predictions and meal plans` and `Plus for up to 12 people, with private items`). Use the same names for the monthly and annual product of a plan.
5. **Ranking (levels of service).** In the group, open the ranking screen and order the products: the two Family products on the top level and the two Plus products below. If App Store Connect allows two products on one level, put each plan's monthly and annual product together; if it does not, order them Family annual, Family monthly, Plus annual, Plus monthly. This decides what Apple treats as an upgrade (immediate) or a downgrade/switch (at the next renewal), which the server's rules for plan changes follow (`docs/billing.md`, "plan change").
6. **Review screenshot for each of the four products**: a screenshot of the plan screen where that product is bought (taken from the TestFlight build on a real iPhone; Apple wants a picture of the purchase UI, not the app icon). Optionally add a review note ("Sign in to the app, Settings → Plan & billing").
7. Each product should now say **Ready to Submit** (Apple's wording for "all required information is in"). If one says "Missing Metadata", open it: something above is missing (usually the screenshot or a localisation).
8. **Attach them to the first version.** The first time you sell subscriptions they are reviewed *with* an app version: App Store Connect → your app → the iOS version page (version 1.0, "Prepare for Submission") → scroll to **In-App Purchases and Subscriptions** → **+** → select the four products. This option appears once the version exists and a build has been added. Submit them together in section 8.
9. App Store Connect → your app → **App Information** → **App Store Server Notifications**: set the **Production** and **Sandbox** URL to `https://your.domain/api/billing/webhooks/apple`, version **2**. Without this the server never hears about renewals or refunds.
10. On the server (see [`docs/billing.md`](billing.md#app-store-ios)): `APPLE_BUNDLE_ID` (your bundle id), `APPLE_APP_ID` (the numeric Apple ID from step 2.4), `APPLE_ROOT_CERTS`, `BILLING_ACCOUNT_SECRET`, and the product ids if they differ.

### 7.2 Sandbox tester plan

Sandbox accounts are fake Apple IDs for testing, and nobody is charged. A TestFlight build always uses the sandbox.

**Create a tester:** App Store Connect → **Users and Access** → **Sandbox** → **Testers** → **+**. Use an email address that is **not** already an Apple ID (a plus-address of your own mailbox works: `you+plentytest1@gmail.com`), any password you will remember, and your country.

**Sign in on the phone:** in the Settings app look for **Developer → Sandbox Apple Account** (older iOS: **App Store → Sandbox Account**). If you cannot find it, start a purchase in the TestFlight build and sign in with the tester when the purchase sheet asks. Do **not** sign the whole phone out of your own Apple ID.

**Run this in order** with a **new Plenty account** (the demo account is already on the top plan, so it has nothing to buy):

1. Create an account, finish the short setup, open Settings → Plan & billing. Confirm: Apple prices, no web link.
2. Tap **Subscribe to Plus** (monthly). Confirm the Apple sheet, the plan changes to Plus in the app, and `subscriptions` and `billing_events` on the server show an Apple purchase linked to the household.
3. Kill and reopen the app: still Plus. Open the app on a second device or the website signed in to the same household: Plus too.
4. **Restore purchases** on a fresh install (delete the app, reinstall, sign in to Plenty, tap Restore): the plan is recognised, and it says clearly if there is nothing to restore.
5. Wait for a **renewal**. Sandbox time is compressed: a monthly subscription renews after about five minutes and a yearly one after about an hour, a limited number of times. The server should log a renewal from Apple's notification.
6. Switch plan: Plus → Family (an upgrade: immediate) and Family monthly → annual or back (applies at the next renewal). Check the plan screen words match.
7. **Manage subscription** (opens Apple's sheet): cancel. Confirm the plan stays until the period ends, then falls back to Free, and nothing is deleted.
8. Try to restore this subscription from a **second Plenty household**: it must be **refused** with the "belongs to one household" message.
9. Refunds are not testable in the sandbox; the server's refund handling is tested with synthetic notifications only (`docs/billing.md`).
10. Pending purchases (Ask to Buy) cannot be reproduced easily; treat as untested.

**On a Mac with Xcode** (optional, no App Store Connect needed): open `mobile/ios/App/App.xcodeproj`, choose **Product → Scheme → Edit Scheme… → Run → Options → StoreKit Configuration** and pick `mobile/ios/App/Plenty.storekit`. It contains the same four products and prices, so you can buy, renew and cancel in the simulator with Xcode's **Debug → StoreKit → Manage Transactions**. These purchases are signed by a local test certificate, so the real server will reject them; use this to test the screens, not the server.

---

## 8. Submit for review

Everything below is in App Store Connect on the version page. The texts are drafted in [`docs/store/listing.md`](store/listing.md); re-run its claims check (section 10 there) against the exact build first.

1. **Screenshots**: iPhone only. The script `scripts/store-screenshots.ts` makes the 6.9-inch size from the demo household; check the sizes App Store Connect asks for today. On a phone with a notch, take a few real screenshots too, so you see the true safe areas.
2. **Promotional text, description, keywords, support URL, marketing URL**: from `docs/store/listing.md`. The description must show the subscription terms and link to Terms of Use and Privacy Policy.
3. **Privacy Policy URL**: `https://your.domain/privacy`. **Terms of Use**: your own `https://your.domain/terms` (set in the app's EULA field) or Apple's standard one.
4. **App Privacy** ("nutrition label"): answer from `docs/store/listing.md` section 5. The app also ships a privacy manifest (`PrivacyInfo.xcprivacy`) that says the same thing: not tracking, data linked to the account, used for app functionality (analytics: first-party counts, off until the person turns them on). Keep the two in step if either changes.
5. **Age rating**: answer the questionnaire from the draft answers in the listing.
6. **Pricing and availability**: price **Free** (the app is free; subscriptions are the products). Choose the countries. Consider turning off availability on Mac and Apple Vision Pro, which you have not tested.
7. **Build**: choose the build that finished processing.
8. **App Review Information**: the demo account (`demo@plenty.app`) and the review notes from `docs/store/listing.md` section 8, including the sandbox steps and why the app is more than a website (camera, StoreKit, native shell). Keep the production server up and `DEMO_MODE=true`.
9. **Export compliance**: already answered in the app (HTTPS only, exempt). **Content rights**: you own or have rights to the content.
10. **Version release**: choose **Manually release this version** so you pick the moment after approval.
11. **Submit**. The in-app purchases attached in step 7.1.8 go with it. Typical wait: a day or two. If Apple rejects it, read the message in **Resolution Center**, reply or fix, and resubmit.

---

## 9. What has NOT been verified, and needs a real device

The code was written without Xcode and has **never been compiled or run**. What was checked here, and what was not:

| Checked in the build sandbox | How |
|---|---|
| Capacitor config loads and rejects a bad site address | Run `npx cap sync ios` with good and bad `PLENTY_URL` values. |
| Config types | `tsc` in `mobile/`, and the website's own `tsc` with and without `mobile/node_modules`. |
| Swift **syntax** of all six app files | Parsed with a Swift grammar. This does not check types or that the APIs exist. |
| Info.plist, privacy manifest, storyboards, asset catalogs, StoreKit file, workflow | Parsed as plist, XML, JSON, YAML; the Xcode project file was parsed with the `xcode` package; shell steps were syntax-checked and the logic steps run locally. |
| Privacy manifest constant names | Compared with Apple's documentation pages. |
| App icon is 1024x1024 with no alpha | Read back with `sharp` and checked by `scripts/verify-shell.mjs` on every build. |
| User-agent token matches the server's pattern | `scripts/verify-shell.mjs` runs it against `src/lib/billing/platform.ts`. |

| **Not** verified | What will tell you |
|---|---|
| ~~Swift compiles (types, API names and availability, StoreKit 2 calls, delegate signatures)~~ | **Done:** the first Build check run succeeded (simulator build, Xcode 26.6). A device build with signing is still unproven until the first Release run. |
| The Xcode project opens and the storyboards compile (`ibtool`) | Same run. |
| The app launches and loads the site; the user-agent really reaches the server | TestFlight on a phone: the plan screen must show no web checkout. |
| Camera permission wording, getUserMedia in the barcode scanner, camera is refused for anything but Plenty's own page | Section 6, Camera. |
| The native bridge reaches the remote site and `PlentyPurchases` is callable | A purchase attempt (section 7.2). |
| Safe areas on screens outside the main app layout | Section 6. Known gap: see "Web changes needed" below. |
| Signing, export and upload (API key permissions, automatic signing in the cloud, altool) | The first **Release** run. |
| Purchases, restore, renewal, cancel, upgrade, the Apple notifications reaching the server, the household-ownership refusal | Section 7.2. |
| The offline screen's **Try again** (native retry) and the automatic retry | Section 6. |
| App Review's reaction (4.2 "repackaged website", 3.1.1 in-app purchase) | Apple. |

### Web changes the app needs (not done here)

* **Safe areas outside the app layout.** The shell lets the page draw under the clock and home bar (`viewport-fit=cover` is set in `src/app/layout.tsx`, correctly). The signed-in layout pads for it (`pt-safe`, `pb-safe`), but the sign-in/sign-up layout, the landing page, onboarding, the join page, the legal pages and the 404/error pages do not, so on an iPhone with a notch their top content will sit under the clock. Add `pt-safe`/`pb-safe` (or `padding-top: max(1.25rem, env(safe-area-inset-top))`) there. The kitchen filter bar's `sticky top-14` assumes a 56px header, but the header is taller by the top safe area on a notch phone; use `top-[calc(3.5rem+env(safe-area-inset-top))]`. These are the first screens a reviewer sees.
* **Links from emails open in Safari, not the app** (password reset, household invitations). Opening them in the app needs "associated domains" and a small file on the site; not built.

---

## 10. Changing things later

| To change | Do this |
|---|---|
| The site's content or features | Deploy the website. **No app release is needed**: the app loads the site. (Anything that needs a new native piece, like a new permission, does need a release.) |
| Version number (what people see, for example 1.1.0) | Edit `version` in `mobile/app.config.json`, commit, and tag `ios-v1.1.0`. |
| Build number | Automatic (GitHub run number). Locally it comes from `buildNumber` in `app.config.json`. |
| App name shown under the icon | `appName` in `mobile/app.config.json`. |
| Bundle id | **Cannot be changed after the first upload.** |
| Site address (`PLENTY_URL`) | Change the GitHub variable and ship a new build. |
| The icon | Edit `src/app/icon.svg`, run `node mobile/scripts/make-icons.mjs` (needs the website's `npm install`), commit the new PNGs. |
| Splash colours | `mobile/ios/App/App/Assets.xcassets/LaunchBackground.colorset` (light and dark). |
| A permission or new native feature | Needs a developer; Apple reviews the purpose text. Never add a permission "just in case": Apple asks why. |
| Apple's minimum Xcode | The workflow selects the newest Xcode on GitHub's image and refuses to build below Xcode 26. |

---

## 11. Technical notes (for developers)

### Where things are

| Path | What |
|---|---|
| `mobile/app.config.json` | App name, bundle id, team id, version, build number: the single source. |
| `mobile/capacitor.config.ts` | Capacitor config: hosted URL, allowed host, user-agent token, web view options. |
| `mobile/scripts/apply-app-config.mjs` | Writes `app.config.json` (plus `PLENTY_BUILD_NUMBER` / `PLENTY_TEAM_ID` from the environment) into the Xcode project. Runs on every `cap sync`. |
| `mobile/scripts/verify-shell.mjs` | Guard rails run by `npm run check` and CI. |
| `mobile/scripts/make-icons.mjs` | Regenerates the icon and launch logo from `src/app/icon.svg`. |
| `mobile/www/index.html` | The "Can't reach Plenty" page, shown by `server.errorPath`. |
| `mobile/ios/App/App/PlentyBridgeViewController.swift` | The one screen; registers the plugins; back-swipe, no pull-to-refresh, background colour. |
| `mobile/ios/App/App/PlentyWebViewGuard.swift` | Own-origin rules (below). |
| `mobile/ios/App/App/PlentyPurchases.swift` | StoreKit 2 plugin, and the transaction listener. |
| `mobile/ios/App/App/PlentyShell.swift` | `retry()` for the offline page. |
| `mobile/ios/App/App/Info.plist`, `PrivacyInfo.xcprivacy` | Permissions, orientation, encryption answer; privacy manifest. |
| `mobile/ios/App/Plenty.storekit` | Local StoreKit test products (not part of the app). |
| `mobile/purchases.d.ts` | TypeScript types of the plugin, for the website. |
| `.github/workflows/ios.yml` | CI. |

`mobile/` has its own `package.json` and `node_modules`; nothing is added to the website's dependencies. Generated and git-ignored: `ios/App/App/capacitor.config.json`, `ios/App/App/public`, `ios/App/App/config.xml`.

### The user-agent token, and how the option name was verified

The server decides "this is the iPhone app" from `PlentyApp/<version> (ios)` in the user agent (`src/lib/billing/platform.ts`, `detectPlatform`). The shell sets `ios.appendUserAgent: "PlentyApp/1.0 (ios)"` in `capacitor.config.ts`. Verified against the installed `@capacitor/ios` 8.5.2 and `@capacitor/cli` 8.5.2 sources:

* `CAPInstanceDescriptor.swift` reads `ios.appendUserAgent` (falling back to the global `appendUserAgent`) into `appendedUserAgentString`.
* `CAPBridgeViewController.webViewConfiguration(for:)` appends it to `WKWebViewConfiguration.applicationNameForUserAgent`, which WebKit adds to the user agent of every request the web view makes (documents, fetch, XHR) and to `navigator.userAgent`.
* `@capacitor/cli`'s `declarations.d.ts` declares `ios.appendUserAgent`, and `tsc` rejects a misspelt option.
* `npx cap sync ios` writes `"appendUserAgent": "PlentyApp/1.0 (ios)"` into `ios/App/App/capacitor.config.json`, and CI greps for it in the built app bundle. `scripts/verify-shell.mjs` runs the server's own regular expression over a realistic user-agent string ending in the token.

The `1.0` is the shell protocol version, not the marketing version.

### How the website reaches the plugin (`window.Capacitor.Plugins.PlentyPurchases`)

Read from `@capacitor/ios` 8.5.2:

* **The bridge is injected into the remote page.** `CapacitorBridge.exportCoreJS` adds `WKUserScript`s at document start, for the main frame, on **every** load whatever its address: `window.Capacitor = { … Plugins: {} }`, then `native-bridge.js` (read from the Capacitor framework's own bundle, not the app's `public` folder), then one script per registered plugin (`JSExport.exportJS`). `native-bridge.js` talks to native through `webkit.messageHandlers.bridge`, which is registered on the web view's content controller. None of it depends on the page being local, so `server.url` pages get it.
* **Each registered plugin becomes `Capacitor.Plugins.<jsName>`** with one function per declared method, each returning `Capacitor.nativePromise(...)`. It exists synchronously before the site's own scripts run. A browser has no `window.Capacitor`, so the website must check for it.
* **A local plugin must be registered in code.** Capacitor auto-registers only the built-in plugins and the classes named in `packageClassList` inside `capacitor.config.json`, but `cap sync` **rewrites `packageClassList` from the installed npm plugins on every run** (`@capacitor/cli` `util/iosplugin.js`), so a hand-added entry is lost. Therefore `PlentyBridgeViewController.capacitorDidLoad()` calls `bridge?.registerPluginInstance(...)`. (`registerPluginType` returns immediately while auto-registration is on, so the instance form is the one that works.) Registration happens before the first page load, so the injected script is present on the first page.
* Plugin method calls arrive on Capacitor's background queue; the Swift methods start a `Task` and answer with `call.resolve` / `call.reject`. A rejection reaches the page as an exception whose `message` is a plain sentence and `code` is a short code (`mobile/purchases.d.ts`).
* The page's bridge calls are forgotten when it navigates away (`bridge.reset()`), which is fine for purchases: the website sends the signed result to the server straight away.
* Capacitor's other built-in plugins (`Console`, `WebView`, `SystemBars`, `CapacitorHttp` and `CapacitorCookies`, the last two off by default) are also reachable from the page. That is acceptable for a first-party site; any script running on the site could also call `PlentyPurchases.purchase`, though the person still has to confirm in Apple's sheet.

### Web view rules (`PlentyWebViewGuard`)

Capacitor's own handler already sends top-level navigation to any host that is not the app's host (`server.allowNavigation` holds only `PLENTY_URL`'s host) to the system browser (`mailto:` and `tel:` too). Capacitor also, by default, grants camera **and microphone** to any origin and lets any frame load; the guard wraps it (everything else is forwarded to Capacitor unchanged):

* Camera: granted only for the top-level page of Plenty's own origin; microphone refused (the app has no microphone purpose string and iOS would terminate it on a request). Device motion refused.
* A frame can only load Plenty's own pages (a frame could otherwise post to the native bridge).
* `target="_blank"` / `window.open`: Plenty's own pages load in the same web view; other addresses go to the system browser; nothing opens a second web view.
* The offline page is shown only for real connection failures, not for a link deliberately handed to Safari or the offline page failing itself.

Inline media: Capacitor's web view sets `allowsInlineMediaPlayback` and an empty `mediaTypesRequiringUserActionForPlayback` (read from `CAPBridgeViewController.webViewConfiguration`), which the barcode scanner's `<video playsinline>` needs; `getUserMedia` works in `WKWebView` from iOS 14.3 and the app's minimum is iOS 15.

Other settings: back-swipe on; no pull-to-refresh (there is no refresh control and the scroll view does not bounce); link preview off (text selection is untouched); portrait only; pinch-zoom off (Capacitor's default, for a native feel; a deliberate trade-off against accessibility, flip `ios.zoomEnabled` in `capacitor.config.ts` if wanted); the status bar follows light/dark; the web view's background is the site's `canvas` colour in both modes; iPhone only.

### Privacy manifest

`NSPrivacyTracking` false, no tracking domains. Collected data (all linked to the person, none used for tracking): name, email address, user id, photos (receipt photos), other user content (kitchen, lists, notes, recipes), purchase history (subscription status), health (diets and allergies; **a decision flagged in `docs/store/listing.md` section 5: delete this entry only if you also leave it off the App Store label**), all for app functionality; product interaction (first-party, opt-in counts) for analytics. Matches `docs/store/listing.md` section 5 and `docs/compliance/data-map.md`.

Required-reason APIs: **none declared, none used.** Checked in the installed `@capacitor/ios` 8.5.2: its own `PrivacyInfo.xcprivacy` files (and Cordova's) are empty, and a search of its sources found no UserDefaults (its key-value store is file-based), file-timestamp, boot-time, disk-space or keyboard APIs (only `fileExists`, directory creation and `fileSizeKey`). The app's own Swift uses none either, and `verify-shell.mjs` fails the build if one of those APIs appears without a matching declaration. If you add a plugin or SDK, re-check.

### StoreKit notes

* `purchase` resolves with Apple's signed transaction (JWS) and then calls `finish()`. The `appAccountToken` is passed as `Product.PurchaseOption.appAccountToken`. An unverified result is rejected and left unfinished so Restore can find it.
* `restore` runs `AppStore.sync()` (which may ask the person to sign in) and returns every verified auto-renewing entitlement from `Transaction.currentEntitlements`, each with the signed renewal info when available.
* `PlentyTransactions.startListening()` (called at launch from `AppDelegate`) iterates `Transaction.updates` for the life of the app and finishes verified transactions. The server learns of renewals, refunds and approvals from Apple's own notifications, so this only keeps Apple's queue clean.
* Minimum iOS 15 (the StoreKit 2 async API). No In-App Purchase entitlement file is needed on iOS.
* The old `webkit.messageHandlers.plentyRestorePurchases` hook does not exist in this app.

### Known limits

iPhone only, portrait only, no push notifications, no Universal Links, no iPad layout, no dark or tinted icon variants (iOS 18 can use them; add `appearances` entries to the icon set if wanted), no automated UI tests.
