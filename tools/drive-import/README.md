# drive-import

Bulk-imports a folder of PDFs into the library. Run it on a computer that has the PDFs, as a library admin.

For each PDF it reads the text with `pdftotext` (poppler), finds the DOI, PubMed ID or ATOTW number (or does a strict
title search), fills in the details through the same code the Worker uses for "Fill missing details", takes the abstract
from the lookup, else from the PDF's own abstract/summary section, else from a local `ollama` model, skips papers
already in the library (by DOI, then title; a paper without a PDF gets the file attached), then uploads the paper, the
PDF and its page text for search.

## Run

```
cd tools/drive-import
npm install                      # firebase-admin only
node import.js --key sa.json --state state.jsonl --folder "D:\pdfs\a=tag-a" --folder "D:\pdfs\b" --report dry.csv
node import.js ... --apply --max 100
```

- Without `--apply` nothing is written: it prints counts by status and writes the CSV report (file, status, how it was
  identified (`via`: an ID, `title` search, `ai-title`, `heading` or `filename`), DOI, title, abstract source, duplicate of, problem).
- `--folder DIR=tag` puts the tag on every paper from that folder; subfolders are included.
- `--state` makes it resumable and cheap to re-run: every file's analysis and upload stage is appended to it.
- `--redo field=value` analyses again the files whose saved record matches, e.g. `--redo via=heading` after a change to
  how titles are read; repeat it for several. Files that failed (`status=error`) are only tried again with
  `--redo status=error`.
- Title when no DOI or PubMed ID is printed: the local model reads it from page 1 (kept only if its words are on the
  page), else the first title-like line of page 1 (wrapped lines joined, side boxes, affiliations and captions skipped),
  else the file name. Series file names (AICM) win over a heading that is only their start.
- `--max N` limits how many papers one `--apply` run uploads. `--no-ai` skips the local summaries; `--model` picks the
  ollama model (default `gemma4:12b`).
- `--key` is a Firebase service-account key file kept on this computer only. Never commit it. The tool makes sure a
  member `libraryimport` (admin, name "Library import") exists, and signs in as that member to call the Worker.

Statuses: `new`, `attach` (library paper without a PDF), `in-library` (skipped), `dup-in-batch`, `needs-ocr` (no text
layer), `too-big` (over 25 MB), `error`, `done`.

Tests: `npm run test:unit` at the repo root (made-up text, no network).
