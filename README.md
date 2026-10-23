# journalclub

Journal club and paper library for the department, at journalclub.anantf.com. Members only, by invitation.

- `public/`: static shell. `src/app.js` is bundled to `public/app.js` (`npm run build`).
- `worker/index.js`: Cloudflare Worker serving `public/` (`wrangler.jsonc`) and the members-only API:
  `GET /api/lookup?id=<DOI or PMID>` (Crossref, PubMed, Unpaywall; `worker/lookup.js`) and `/api/file/<paper>`
  (PDFs in the private R2 bucket `journalclub-files`). The Worker has no service account: it reads the caller's own
  member row from the Firestore REST API with the caller's ID token, so the rules decide.
- PDFs: the person who added a paper (or an admin) can upload its PDF; there is no licence check. `#/import` takes many
  PDFs or a folder at once: it reads each DOI from the first pages (`src/doi.js`), fills in the details by lookup, names
  PDFs without a DOI from the file name, and skips papers already in the library.
- Library (`src/library.js`): papers, one note and rating per member, reading lists. PDF text is extracted in the browser
  with PDF.js at upload (`src/pdf.js`) and kept per page in `texts/<paper>`; `src/search.js` builds a MiniSearch index over
  titles, tags, notes, abstracts and PDF pages, so a hit opens the PDF at its page.
- Search (`#/`) is the default page. Journal club (`src/club.js`): the club home (`#/home`) shows the next session and the most-voted papers; members vote once per
  paper (`papers/<paper>/votes/<uid>`); admins build the presenter rota from the members list (`rota/main`) and plan
  sessions (`sessions/<id>`: date, paper, presenter), which moves the rota on; the presenter adds the summary and slides link.
- `firestore.rules`: members read only their own row, admins manage members and invites; joining needs an unused, unexpired invite.
- Tests: `npm run test:unit` (lookups on saved fixtures in `test/fixtures/`, DOI finder, Worker API), `npm run test:rules` (Firestore emulator, needs Java) and `npm run test:e2e` (Playwright at 390 px).

## First admin

The first admin row is written once, out of band, in the Firebase console or with an admin credential:
`members/<uid>` = `{ email, name, role: "admin", inviteId: "seed" }`. After that, admins invite everyone else from `#/admin`.

## Config

`src/config.js` holds the public Firebase web config (the web client key is added after the project exists). Access is enforced by the rules, not by hiding the config.

## R2

The Worker binds the bucket `journalclub-files` as `FILES`; create it once with `npx wrangler r2 bucket create journalclub-files`
(R2 must be enabled on the Cloudflare account). Without the binding the file routes answer 503 and the rest works.
`CONTACT_EMAIL` is the address Unpaywall asks API callers to send.
