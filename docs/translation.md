# Bundled books and translations

The app ships a small library of Japanese novels with an English translation aligned to
each paragraph. Everything is reproducible from the repo:

```
books/catalog.json              shelf order (slugs)
books/<slug>/source.epub        the original Japanese EPUB — the source of truth
books/<slug>/en/<chapter>.json  English, one entry per unit (see below)
books/<slug>/glossary.md        names, terms, voice — the translator's reference
scripts/books/                  lib.mjs · extract.mjs · build.mjs
public/books/                   build output (committed): <slug>.epub, <slug>.webp, catalog.json
```

```sh
npm run books:extract -- <slug>   # (re)write en/*.json units from source.epub, keeping existing English
npm run books:build               # all books → public/books/ (deterministic; ids are SHA-256)
npm run books:build -- <slug>     # one book
```

## Units

A **unit** is one leaf block (`<p>`, `<h2>`, …) of a spine document, or one
`<br/>`-separated line of it (森崎書店の日々 writes whole scenes as one `<p>`). Units are
numbered per chapter in document order after Kobo markup is stripped.

```json
{ "id": 12, "ja": "「島崎《しまざき》、わたしはこの夏を西武に捧げようと思う」", "en": "\"Shimazaki, I'm going to devote this summer to Seibu.\"" }
```

- `ja` is the unit's text with ruby as `base《reading》`. It guards the numbering: the
  build fails if the source no longer matches (re-run extract).
- `en` empty = untranslated; nothing is inserted.

## Built markup (the reader's contract)

`build.mjs` inserts, directly after each translated unit's last node (before its `<br/>`):

```html
<span class="tsuzuri-en" lang="en" xml:lang="en" data-tz="12">…</span>
```

and `<meta name="tsuzuri-translated" content="en"/>` into the head of every chapter that
has one. The Japanese is never wrapped or modified. It also strips Kobo sync markup
(`koboSpan`, `kobo.js`), and re-encodes JPEGs over 400 KB (mozjpeg q80).

## Translation standard

The Japanese is the source of truth. The English must be a correct, complete translation
that carries the meaning, nuance, intention and tone of the original — readable as
literary English, used by a learner reading alongside the Japanese.

- **Faithful:** nothing added, nothing dropped, no explanations or glosses. Keep
  sentence-level emphasis, hedging, irony, understatement, and humor. Don't flatten a
  deadpan narrator into neutral prose, or brighten a flat one.
- **Aligned:** each unit's English translates that unit only — a reader can reveal one
  unit at a time. Don't pull content from the next unit to smooth a sentence.
- **Register and voice:** match each speaker (polite/casual, dialect, age, gender
  markers expressed through word choice rather than stereotype). Keep a narrator's
  person and tense consistent with the glossary.
- **Names:** Hepburn romanization without macrons (Otsu, Shimazaki). A name as it appears
  (surname alone, given name alone); full names in Japanese order (Naruse Akari).
  Honorifics are kept: -san, -kun, -chan, -sensei, -senpai. Kinship terms are translated
  (叔父さん → Uncle / Uncle Satoru, per glossary).
- **Punctuation:** 「」 → "…", 『』 → '…' inside dialogue, titles in italics are not
  marked (plain text). ASCII quotes and apostrophes (`"` `'`). ……/… → "...", ——/― → "—".
  No Japanese characters in the English.
- **Headings, TOC, front/back matter:** translate. A unit with nothing translatable
  (an ISBN, a lone number) may be translated as-is or left empty.
- **Titles:** use an established English title only where certain (コンビニ人間 →
  *Convenience Store Woman*; 森崎書店の日々 → *Days at the Morisaki Bookshop*);
  otherwise translate.
