# Two-week ship plan: Plenty on the iPhone App Store

Written 2026-10-04 with a hard limit of two weeks. Decisions made: **paid plans at launch**; **Apple in-app purchase on iPhone, Stripe on the web**, one subscription per household that works everywhere; **iPhone only** for now (no Android, no push notifications, no iPad-specific layout).

Day-of-week labels use the 2026 calendar (4 Oct 2026 is a Sunday). Apple's banking and identity checks run on business days, so anything started on the weekend may not move until Monday.

The critical path is not code. These are slow, and only the account holder can start them, so do them first:

| Slow thing | Why it's slow | Start |
|---|---|---|
| Apple Developer Program enrolment | Identity checks. An organisation account also needs a D-U-N-S number, which can take weeks: if the account must be in a company name, start today or enrol as an individual and move later | Day 1 |
| Paid Applications agreement, banking and tax in App Store Connect | Apple verifies them before subscriptions can be sold | Day 1 |
| Subscription products in App Store Connect | They are reviewed with the first build, so they must be complete and "Ready to Submit" before you submit | Day 3 |
| Lawyer's read of the Privacy Policy and Terms | Needed before launch (audit item 4) | Day 1 |

## Calendar (two weeks, ending Sun 18 Oct)

| Day | What | Who |
|---|---|---|
| **Sun 4 – Mon 5 Oct** | Enrol in the Apple Developer Program. Start the Paid Applications agreement, banking and tax. Create hosting, Postgres and object-storage accounts and buy the domain. Send the legal text to a lawyer. Choose the bundle id (permanent). | You |
| | Deploy kit (Docker, photo storage, `npm run check:prod`), iOS app project with the purchase bridge, iPhone purchase screen, listing and review notes. | Claude |
| **Tue 6 – Wed 7** | Deploy to production and run `npm run check:prod` until it passes. Set the production environment (`docs/deploy.md`). Create the Stripe live products and webhook. Create the App Store Connect app record and the subscription group with four products. Add the App Store Server Notification URLs. | You, with the guides |
| | Put the GitHub Actions secrets in (App Store Connect API key) and run the first TestFlight build. Fix what the Mac build reports. | You run it, Claude fixes |
| **Thu 8 – Fri 9** | **Real iPhone test via TestFlight:** sign-up, receipt camera, barcode scanner, keyboard, safe areas, offline screen, a sandbox purchase, restore, delete account. | You on the phone, Claude fixing |
| **Sat 10** | Freeze the build. Screenshots, privacy labels, age rating, review notes, demo login. | Both |
| **Sun 11** | **Submit for review.** (Latest sensible day: Tue 13.) | You |
| **Mon 12 – Fri 16** | Apple review. Usually a day or two, but a first submission often needs one fix-and-resubmit round: that is what this buffer is for. | Apple; Claude fixes fast |
| **Sat 17 – Sun 18** | Release (set the release to manual so you choose the moment). | You |

## What can't be confirmed from the build sandbox

The Swift code and the Xcode build can't run on Linux, so the first real compile is on the GitHub Actions Mac runner, and the first purchase test is a sandbox purchase on a real iPhone. If either turns up a problem late, the fallback is to submit **without** the purchase button (Free plan only, version 1.0) and add subscriptions in 1.1: the app is built so the Free plan is a complete product. Decide that fallback on Fri 9 Oct, not later.

## Things that get an app rejected, and where they're handled

* **Subscriptions bought elsewhere** must also be buyable in the app (3.1.3(b)): done, the app sells both plans through Apple.
* **No Stripe link, price comparison or web checkout inside the app** (3.1.1/3.1.3): the server hides them whenever the app's user agent says it's the iPhone app.
* **Restore Purchases, Terms and Privacy links beside the buy button** (3.1.2): in the plan screen.
* **Account deletion inside the app** (5.1.1(v)): done, Settings → Account.
* **Looking like a repackaged website** (4.2): native camera, StoreKit, a native shell; explained in the review notes (`docs/store/listing.md` §8).
* **Demo login and a reachable back end** (2.1): `DEMO_MODE=true` and `npm run db:seed` on production; the server must be up during review.
* **Honest metadata** (2.3): re-run the claims check in `docs/store/listing.md` §10 against the exact build.
