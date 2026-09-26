bump: major

### BREAKING

- Butchr no longer creates a Confluence page for a ticket automatically, ever.
  `set_doc` on a ticket with no existing doc now REFUSES (naming the situation
  and pointing at `confluence_create_page`) instead of lazily creating one
  titled `[unwritten] ...` and nesting it under the boss ticket's doc.
  `new_worker`, `adopt_worker`, and `file_where_it_belongs` no longer create or
  report a Confluence doc for a ticket either — `new_worker`'s and
  `file_where_it_belongs`' results no longer carry a `doc` field at all, and
  `adopt_worker`'s `doc` field is now optional, present only when the adopted
  ticket already had a doc linked before the call.

### Changed

- `confluence_create_page` is no longer described as deprecated: it is now the
  only way to create a Confluence page through Butchr, explicit space and
  (optionally) parent required — no defaulting or inference of either.

### Removed

- The provisional-title machinery's creation half (`ensureDoc`'s create/nest/
  label/race-guard logic, and the per-ticket ASSIST-space pointer text it used
  to seed a fresh page with). Reading and writing a PRE-EXISTING doc, including
  one still carrying the `[unwritten]` provisional title from before this
  change, is unaffected.
