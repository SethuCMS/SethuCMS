# The core, explained without code

Think of SethuCMS as a **reception desk in front of a database**. People send requests
("give me the 10 newest posts"). The core is the rulebook the desk follows before anything
reaches the database. It never talks to the database itself; it only decides what is allowed.

## The seven jobs, in the order a request meets them

| # | File | Plain-English job | Everyday comparison |
|---|------|-------------------|---------------------|
| 1 | `content-model.ts` | Knows what data exists: which collections (tables), which fields, what type each field is, which are required. Also checks that a record someone wants to save is acceptable. | The form template. "Name is required, age must be a number 0-150." |
| 2 | `query-ast.ts` | Reads a request and turns it into one standard shape, rejecting anything strange. | The reception desk's intake form. Messy handwriting or hidden extra instructions are refused. |
| 3 | `query-validate.ts` | Checks the request against reality: do these fields exist, do the filters make sense for their types, and can this specific database do it? | Asking "do we even have a room 404?" and "does this hotel have a pool?" |
| 4 | `permissions.ts` | Applies who-may-see-what: hide fields, mask fields (show `***`), limit which rows a person can see. | A visitor badge. Some doors closed, some papers blacked out. |
| 5 | `pagination.ts` | Splits long lists into pages using a sealed "bookmark" that cannot be forged or reused for a different search. | A numbered, tamper-proof bookmark. |
| 6 | `redact.ts` | Removes passwords and keys before anything is written to logs. | Blacking out card numbers on a receipt. |
| 7 | `errors.ts` | One consistent set of error messages, never leaking internal details. | A polite "sorry, can't do that" that never reveals how the building is wired. |

`capabilities.ts` is a small checklist each database fills in ("I can do OR, I cannot sort by any field...").
`field-types.ts` is the list of 12 data types everything is translated into. `util.ts` has tiny helpers.

## The file you have open: `content-model.ts`

It does three things:

1. **Describes the shapes** (top of file): what a *field* is (name, type, required?), what a *collection* is (a name plus fields), what a *relation* is ("a post belongs to an author").
2. **Checks definitions** (`defineCollection` and the `check...` functions): when someone defines a collection, it makes sure names are safe, there is a primary key, and no duplicates. The part around line 78 (`NESTED_QUANTIFIER`) only blocks one nasty kind of text pattern that could freeze the server.
3. **Checks records** (`validateRecord`, bottom of file): before saving, it rejects unknown fields, fields the user may not set (like an auto-generated ID), wrong types, and rule violations. This stops someone sneaking in `{"isAdmin": true}`.

## One request, start to finish

1. Request arrives: *"posts where title starts with Hello, 10 per page"*
2. `parseQuery` turns it into a clean, standard form (or refuses it).
3. `resolveAccess` + `restrictQuery` apply this user's permissions.
4. `planQuery` confirms the fields exist and the database can run it.
5. An adapter (later work) talks to the real database.
6. `maskRecord` removes or masks fields the user may not see.
7. `CursorCodec` adds the sealed bookmark for the next page.

## Why so strict?

Everything here assumes requests may come from someone hostile. Each "reject" in the code
closes a known attack: injection, reading hidden data by guessing, forging bookmarks, saving fields
you should not control. The tests in `tests/` try those attacks and prove they fail.
