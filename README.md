# journalclub

Journal club and paper library for the department, at journalclub.anantf.com. Members only, by invitation.

- `public/`: static shell. `src/app.js` is bundled to `public/app.js` (`npm run build`).
- `worker/index.js`: Cloudflare Worker serving `public/` (`wrangler.jsonc`).
- `firestore.rules`: members read only their own row, admins manage members and invites; joining needs an unused, unexpired invite.
- Tests: `npm run test:rules` (Firestore emulator, needs Java) and `npm run test:e2e` (Playwright at 390 px).

## First admin

The first admin row is written once, out of band, in the Firebase console or with an admin credential:
`members/<uid>` = `{ email, name, role: "admin", inviteId: "seed" }`. After that, admins invite everyone else from `#/admin`.

## Config

`src/config.js` holds the public Firebase web config (the web client key is added after the project exists). Access is enforced by the rules, not by hiding the config.
