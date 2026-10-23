# journalclub

Journal club and paper library for the department, at journalclub.anantf.com. Members only, by invitation.

- `public/`: static shell. `src/app.js` is bundled to `public/app.js` (`npm run build`).
- `worker/index.js`: Cloudflare Worker serving `public/` (`wrangler.jsonc`) and the members-only API:
  `GET /api/lookup?id=<DOI or PMID>` (Crossref, PubMed, Unpaywall; `worker/lookup.js`) and `/api/file/<paper>`
  (PDFs in the private R2 bucket `journalclub-files`), and `/api/slides/<session>` (`worker/slides.js`). The Worker has no service account: it reads the caller's own
  member row from the Firestore REST API with the caller's ID token, so the rules decide.
- PDFs: the person who added a paper (or an admin) can upload its PDF; there is no licence check. `#/import` takes many
  PDFs or a folder at once: it reads each DOI from the first pages (`src/doi.js`), fills in the details by lookup, names
  PDFs without a DOI from the file name, and skips papers already in the library.
- Library (`src/library.js`): papers, one note and rating per member, reading lists. The catalogue (paper metadata) is
  kept in Firestore's persistent cache: a repeat open reads only papers whose `changedAt` is newer than the newest seen,
  plus one count (a mismatch, from a paper removed elsewhere, reads it all again). The list shows 50 at a time.
  `src/search.js` builds a MiniSearch index on the phone over titles, authors, journal, tags, why and abstracts.
- PDF and notes search (`worker/search.js`): PDF text is extracted in the browser with PDF.js at upload (`src/pdf.js`) and
  sent to `PUT /api/index/<paper>`; the Worker keeps one FTS5 row per page in the D1 database `journalclub-search`
  (binding `SEARCH`; the table is created on first use), plus page 0 for the paper's notes (`POST /api/index/<paper>/notes`
  after a note is saved; the Worker reads the notes from Firestore itself). `GET /api/search?q=` returns paper ids, the
  best page and a snippet, so a hit opens the PDF at its page. Removing the PDF or the paper removes its rows.
  Older uploads kept their text in Firestore `texts/<paper>` (no longer written or read by the app): an admin copies it
  into D1 once from `#/reindex` (`POST /api/backfill`, safe to repeat).
- Search (`#/`) is the default page. Journal club (`src/club.js`): the club home (`#/home`) shows the next session. Any member plans a
  session from the Plan a session sheet (`#/plan`, or `#/plan/<paper>` from a paper page): date, paper (search as you type),
  presenter, coordinator, optional Teams link. A session (`sessions/<id>`) is edited by its creator, presenter, member coordinator and
  admins; the creator and admins delete it. Each paper keeps a `presented: [{sid, date}]` summary, written in the session's batch, which
  gives the library list its Presented badge. The paper page lists its sessions and their take-home points. Voting and the rota are gone
  (old vote and rota data stay in Firestore, unreadable by the rules). Admins set the club's usual weekday in Admin.
- `firestore.rules`: members read only their own row, admins manage members and invites; joining needs an unused, unexpired invite.
- Tests: `npm run test:unit` (lookups on saved fixtures in `test/fixtures/`, DOI finder, Worker API, D1 search and backfill), `npm run test:rules` (Firestore emulator, needs Java) and `npm run test:e2e` (Playwright at 390 px).

## First admin

The first admin row is written once, out of band, in the Firebase console or with an admin credential:
`members/<uid>` = `{ email, name, role: "admin", inviteId: "seed" }`. After that, admins invite everyone else from `#/admin`.

## Config

`src/config.js` holds the public Firebase web config (the web client key is added after the project exists). Access is enforced by the rules, not by hiding the config.

## D1

Create the database once with `npx wrangler d1 create journalclub-search` and put its `database_id` in `wrangler.jsonc`.
Without the binding the search routes answer 503, uploads still work (their text is not indexed) and metadata search works.
Unit and e2e tests use a local D1 through wrangler (`test/d1.js`), with no Cloudflare account.

## R2

The Worker binds the bucket `journalclub-files` as `FILES`; create it once with `npx wrangler r2 bucket create journalclub-files`
(R2 must be enabled on the Cloudflare account). Without the binding the file routes answer 503 and the rest works.
`CONTACT_EMAIL` is the address Unpaywall asks API callers to send.

## Slides

A session's creator, presenter, coordinator or an admin uploads a PDF or PowerPoint (up to 50 MB), or pastes a share link
(Google Slides, Drive, OneDrive/SharePoint, Dropbox or a direct link): the Worker pulls the file itself and refuses a link it
cannot download. R2 keeps `slides/<session>/original` (PowerPoint) and `slides/<session>/pdf`; the session doc keeps
`slidesFile: {name, size, kind, pdf}`. PowerPoint is turned into a PDF by CloudConvert (Worker secret `CLOUDCONVERT_KEY`,
`npx wrangler secret put CLOUDCONVERT_KEY`); Google Slides links use Google's own PDF export. Without the key, PowerPoint
is still saved and the page says there is no PDF copy.
