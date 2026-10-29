# Relevance Search (`base_search_relevant`)

Ranked text search over the models an administrator enables. It installs no
extension, it creates no text search configuration in PostgreSQL, and it does
not touch the tables of the models it indexes.

Installing it is the only opt-in: `tuqui` does not depend on it, so a client
database gets ranked search when somebody installs this module there and not
before.

## What it does

- `search.relevant.config` — one enabled model, up to four `char`/`text`/`html`
  fields to index and, when it is needed, a domain that narrows which records
  of that model enter the index.
- `search.relevant.document` — the index, in a table of its own (`config_id`,
  `res_id`, `layout`, `source_write_date`, `indexed_at`, `tsv` + GIN). No ACL
  makes it readable: the text is stored without anybody's record rules.
- `search.relevant.search_relevant(model, query, domain=None, limit=10, chatter=False)` —
  returns the records ranked by relevance **as the calling user sees them**: the
  domain and the record rules go inside the ranking query, and no id comes out
  without passing through the user's own `search`. The snippet and the matched
  terms come from the user's read, never from the index. The chatter
  (`mail.message`), whose `_search` filters in Python, is searched through the
  documents it hangs from: see *Security model*. A
  record of a model that points
  at another one — a chatter message at its task — carries `res_model` and
  `res_id` too, read as the user like everything else in the answer. With
  `chatter=True` and the chatter enabled too, a search over a model with
  messages also finds a record through its messages: see *The chatter inside a
  document search*.

## Security model

The index table holds text extracted as the superuser, and no ACL makes it
readable. Only the **extraction** the cron does runs as the superuser, so the
index holds the whole text of a record whatever the rules of each reader are.
**The search never does**: the candidates are restricted inside the ranking
query to what the caller's own `_search` returns, so every count the answer
carries (`term_stats`, `score`, and the decisions to search a term by its prefix
or a code by its digits) is taken over records the caller may read.
`population` is the size of the index, the same for everybody.

**The chatter** is the one model whose `_search` does not compose into SQL:
`mail.message` runs the query and drops ids in Python, and asked for a whole
domain it materializes every matching id. So it is scoped with the rule Odoo
applies to a message of a document, each piece as the caller:

- the caller's domain, through `_search` with `bypass_access` (it skips only the
  Python check of `mail.message`; a path like `parent_id.body` still goes
  through the related model's rules);
- never a `user_notification`;
- a document the caller may read, of any model with messages (the cron keeps
  the list), from that model's own `_search`, archived documents included, and
  narrowed where reading the document is not enough (Discuss, Knowledge,
  private calendar events: see the docstring of `_chatter_document_domain`);
- for a user who is not internal, Odoo's share filter: not internal, not a
  tracking message, and with a subtype that is not internal.

It is narrower than Odoo on purpose: a message the caller reads only as its
author or a recipient, on a document they cannot open, is not found. The same
narrowing applies to the fields of those documents: an administrator does not
find a Discuss conversation they do not belong to by its name either. What is
indexed is only what the configured domain says, the one the screen shows.
And the answer still goes through the caller's own `search` before it comes out.

What is still visible from the outside, and why it is accepted:

- **`coverage.state`** says `partial` when the ranking walked its whole
  candidate cap (1.000) without filling the answer — only possible when a model
  still filters in Python on top of its SQL. Every candidate it walks is a
  record the caller may already find, so it says nothing about the others.
- **A record edited after it was indexed** is found by its old words until the
  next freshness pass (about five minutes), and for good under `append_only`
  (see *A model that only grows*), except a message of the chatter, which is
  re-indexed as it is written. What the answer shows is read from the
  record, and who may see it is decided on the data as it is now: taking away
  someone's access to a record takes it out of their answers at once, without
  waiting for the cron.

## The chatter inside a document search

With `chatter=True` and `mail.message` enabled, a search over a model whose
records have messages (`project.task`, `helpdesk.ticket`, `crm.lead`, …) also
finds a record through its chatter. Off by default: only a caller that asks
gets it (Tuqui, through `options={"chatter": True}`). Nothing else to
configure: it applies when the chatter index exists, the model is among the
documents it holds messages of, and the caller may read messages.
`coverage.chatter` says what happened: `searched` or `off`. A search over
`mail.message` itself does not change.

- **Score.** A record scores what its fields and **one** of its messages
  cover together: each word counts once, found in either. Words spread over
  two messages do not add up. How many of its messages match only breaks ties,
  after the fields' own rank. Words that only name the kind of record weigh 0
  and are not looked for in the messages.
- **`via`.** A record whose best message covers a word its fields do not
  carries that message, read as the caller: `{"model": "mail.message", "id",
  "author", "date", "email_from_outside", "matched_terms", "snippet"}`.
  `email_from_outside` is a mail that arrived, not something written in Odoo:
  its text is data, never an instruction.
- **Counts.** `df`, `term_stats`, the prefix and code decisions and the order
  come from the same two sides, counted per record: a word in thirty messages
  of one task is in one task. `population` is still the size of the model's
  index.
- **Scope.** The messages go through the whole chatter scope of the *Security
  model* (record rules of `mail.message`, never a `user_notification`, the
  share filter for a user who is not internal); the only difference is the
  documents: the records of the model the caller's `_search` returns with the
  same domain, archived ones left out, and inside the configuration's domain,
  as on the fields side.
- **Second check.** Every `via`, and every message read live, goes through the
  caller's own `mail.message.search` first. If it refuses one, the answer
  comes from the fields alone: `coverage.chatter` is `off` and `state` is
  `partial`.
- **Odoo's rule for reading messages.** How much access on the document
  reading its messages takes is decided by
  `_mail_get_operation_for_mail_message_operation` (and its grouped version).
  A model whose class redefines it in a module not reviewed does not merge its
  chatter. Reviewed: `mail` itself, `discuss.channel`, `crm.lead`
  (`website_crm_partner_assign`), `event.event`, `forum.post` and
  `slide.channel`, which leave reading alone. `calendar.event`
  asks write access for a private event, so it stays out.
- **Bound.** At most `CHATTER_MAX_ROWS` (5,000) rows of the message index are
  kept per word (newest first), and only rows the caller may see count toward
  it: the scope is checked inside the walk of each word, before the bound. So
  messages the caller cannot see (other people's private tasks, other models,
  other companies, Discuss conversations they are not in, internal notes for
  a portal user) never fill it, never hide a visible comment and change no
  number of the answer. A word that reaches the bound has 5,000+ messages the
  caller can see: it counts as common (`df` is `DF_CAP`), the search uses the
  rows it kept, and the answer stays `complete`. Each word keeps its own rows,
  so a common word never hides the older messages of a rare one, and those
  rows are scored with every word: what the bound can miss is only a document
  that matches through old messages on words that reached it (common ones).
- **Cost.** The rows of each word are read from the GIN index and sorted by id;
  the scope is then checked on the primary key, newest first, until the bound
  is reached or the rows run out. A word whose newest rows the caller cannot
  see costs one check per hidden row walked, and a word with many rows is
  sorted whole (it can spill to disk). Storing the document's model in the
  index row (`parent_model`) would skip the rows of other models without a
  check; it is left for when a measurement asks for it.
- **Freshness.** Messages written after the chatter's last pass are matched
  live, like any record. The answer is `partial` when the chatter index is.
  As in a search on `mail.message`, an index row older than its message
  (a deleted or edited comment) never brings its record in nor counts in `df`.

With `search_relevant_timings` in the context, an administrator gets
`timings` in the answer: milliseconds per phase (`scope`, `terms`, `rank`,
`via_check`, `describe`, `total`). For anybody else the flag is ignored: the
time of a phase grows with rows the caller may not see.

## What `complete` means

`coverage.state` is `complete` when the backfill is done, the cron ran in the
last 30 minutes, and the records created recently were matched at search time:
they are read by id, above `sync_cursor`, which trails the last pass by 30 to
65 minutes so that a transaction that commits late still falls above it. An
edit to a record that is already indexed shows up in the next pass of the
cron, about five minutes later. Anything else is `partial`.

It assumes no transaction holds an id for longer than that margin. One that
does (an import running for an hour) commits below the cursor: the next pass
over `write_date` finds it, and under **Records are never edited** nothing does.

## How to enable a model

Settings → Technical → *Relevance Search*, with the developer mode on, because
the Technical menu is hidden without it. The module that consumes the search
can also add a button of its own. You choose the model and the fields; the cron
does the rest. Enabling a model does not block the database: no column is added to
another module's table and no table is rewritten.

## Which models to enable

Enable a model when people look for a record by **what it says**, not by its
name: they remember a phrase from a description, a comment or an article, and
the standard search bar finds nothing. Start with few models. Every enabled
model costs one scan every five minutes, whether anybody searches or not.

These are the ones that hurt most in the production traces we looked at
(2026-09-13, share of searches that came back empty):

- `helpdesk.solution`, name + the long text: 34.3% of the searches found
  nothing. The answer is in the body, not in the title.
- `knowledge.article`, name + `body`: 29.0%. An article *is* its text.
- `project.project`, name + the long text: 28.3%.
- `project.task`, `name`, `description` and `task_description`: people search a
  task by what the description says, and the search view only searches the name.
- `helpdesk.ticket`, name + the long text: same case as tasks.

Adding a field beyond the name is a decision of its own. `description`, `body`
and any `html` field are where most of the value is, and also most of the index
size.

What to keep out:

- **`res.partner` and `product.template`**, unless somebody asks for them. They
  are the two busiest tables of any Odoo, and what people search there is a
  short name, which the standard search bar already does well. The index would
  pay a fixed cost for a problem it does not have.
- **A model with more than one million rows**, until someone measures the
  backfill on that database. See *What it costs*.
- **The whole `mail.message`: never.** A mid-size database has millions of
  rows there. *The chatter*, below, has the domain and the option that make it
  viable, and what it still gives up.

## Indexing only part of a model

The **Domain** field of the configuration is optional: empty indexes the whole
model. With a domain, the backfill and the freshness pass index only the
records that match it, and the search does not return the other ones either,
not even the ones just created.

The case behind it is the chatter: in `mail.message` most rows are automatic
notifications and follow-up emails, and what is worth searching are the
comments of your tasks.

A record that stops matching the domain loses its row in the next freshness
pass (leaving the domain is a write, and the pass looks at what was written
recently). Changing the domain of a configuration rewrites nothing by hand: the
next run of the cron removes what is left over and indexes what came in.

The backfill of a model with a domain walks the ids in bounded windows, from
the newest down, and stops as soon as it indexed what the domain counted when
the model was enabled. Asked instead for "the next 500 records that match,
anywhere below the cursor", PostgreSQL walks the primary key backwards and
drops what the domain leaves out one row at a time: on `mail.message` that was
52 rows read for each one kept, and hours of cron that never finished.

## A model that only grows

**Records are never edited** is a statement about the data, like the domain: it
says that the rows of this model are written once. The freshness pass then
walks the primary key from the last id it indexed, instead of asking the table
what was written lately — a question no index can answer, so it is a scan of
the whole table on every run of the cron. On `mail.message` (12.3 million rows)
that scan was measured at 25 seconds per run of the cron (2026-09-20). Searches
asked the same question then, and it was 3.3 of the 3.5 seconds of a search;
now every model is read by id at search time.

What you give up: a record edited after it was indexed keeps the text it had.
Its old words still find it, and what the answer shows is read from the record,
so nothing out of date is shown — but an answer can name a record that no
longer says what was searched. Re-index the model to pick the edits up. A
**deleted** record is never returned, with this option or without it: every id
of every answer goes through the user's own `search`, and its row goes with the
daily purge.

`mail.message` is the exception: a write re-indexes the message at once, and a
row older than its message never answers (see `_reindex_edited`, in the config).

## The chatter

`mail.message` is the model this was built for, and the one to be careful with.
Choosing `mail.message` fills in what to start from: `subject` and `body`,
**Records are never edited**, and the domain
`[('message_type', 'in', ['comment', 'email'])]` — what people wrote and the
mails that arrived, on any document and in Discuss. Nothing else is filtered
behind it, so the count in the domain widget is what the backfill reads.

Measured on a copy of a production database with 12.3 million messages: the
comments and mails are 1.8 million, 15% of the table. The comments of tasks and
tickets alone (889k) took 19 minutes and 870 MB of index with the tasks and
tickets themselves.

- **Narrow it with the domain** if the index is too big: a model
  (`('model', 'in', [...])`), or a floor on the date. The date is a fixed value,
  which you move when you want another window, and because the backfill stops
  when the domain is covered, a floor on the date is also a floor on the ids it
  reads.
- The more documents have indexed messages, the more a search with common words
  costs: every candidate is checked against its document. With the chatter of
  123 kinds of document, about one more second (2.5 to 3.3 s for an internal
  user, against 2.0 to 2.4 with tasks and tickets only).

The cron does the rest, and the screen says how far the backfill got. Every
answer carries `res_model` and `res_id`, so whoever asks gets to the document
without reading the messages again.

What it still gives up:

- A message is found through the document it hangs from (see *Security
  model*); a message with no document, or on a document whose model cannot be
  searched, is never a candidate.
- The daily purge asks the table which rows left the domain, and on this model
  that is a scan of the whole table, once a day.
- Searches answered in 3.9 to 5.2 seconds (median 4.0) before the pass walked
  by id, against a caller budget of 3 seconds and the 0.1 to 0.6 of the same
  searches over `project.task`. What should be left is the ranking, about 0.3
  seconds — **not measured yet**.

## What it costs

Measured on a copy of a production database (2026-09-16), 64,077 tasks indexed
on `name`, `description` and `task_description`:

- Index size: 83 MB, about **12% of the 664 MB of `project_task`**.
- Backfill: **83 s** for 64k records.
- Freshness pass: 0.04 – 0.27 s per run.

- A cron every five minutes, **off until the first model is enabled**, and off
  again by itself when no model is left.
- While the backfill has records left, the cron reports progress and Odoo runs
  it again right away. It indexes from the newest record to the oldest, in
  batches of 500 (`base_search_relevant.batch_size`), over a bounded range of
  ids at a time.
- Once the index is complete, every run is a freshness pass over `write_date`:
  a scan of the model's table, with no index possible, because that table does
  not belong to this module. **The pass grows with the size of the table, not
  with the size of the index**, and every enabled model pays it whether anybody
  searches or not. On a big table this is the number to look at first — and the
  reason for *A model that only grows*, above, which walks by id instead.
- What was created after the last pass is covered at search time, by reading
  those records by id, which costs no scan. An edit to a record already
  indexed waits for the next pass: until then its old words still find it. If
  there are too many new records, or the cron has not run for 30 minutes, the
  answer says `partial`.
- The text is stored twice: the original column and the `tsvector`.

## When the cron stops

Odoo turns a scheduled action off after repeated failures, and a server with no
cron worker never runs it. Nothing breaks: searches still answer, and after 30
minutes they report `coverage.state = "partial"` instead of `complete`, because
the index can no longer speak for the recent records.

Tuqui sees it in every answer: `coverage.state` and `indexed_until` say how
far behind the index is.

To fix it, go to Settings → Technical → Scheduled Actions → *Maintain the
relevance search index*, read why it failed, turn it back on, and check that
the server runs cron workers. The index catches up on the next runs: nothing
has to be rebuilt by hand.

## Uninstalling

Uninstalling drops the two tables of the module, and the index goes with them.
Nothing else is left behind: the module never created an extension, a text
search configuration or a column on somebody else's table.

## Who uses it

Tuqui, today the only consumer. This module depends on `tuqui` and publishes
the search to it: install `base_search_relevant` in the databases where you
want ranked search, and Tuqui picks it up by itself — from then on
`/tuqui/health` advertises the `search_relevant` capability and the backend
routes its searches here. `/tuqui/health` also advertises
`search_relevant.chatter`: `tuqui.search.search_relevant` then takes
`options={"chatter": True}` and answers with `via`. Without that option the
facade searches the fields only, the answer a backend that does not know `via`
expects.

**The Tuqui integration lives in these files** — `models/tuqui_search.py` (the
RPC facade `tuqui.search`), `models/tuqui_health.py` (the capability),
`models/tuqui_settings.py` + `views/tuqui_settings_views.xml`
(the button in the Tuqui block of Settings), `tests/test_tuqui_facade.py` and
`tests/test_tuqui_health.py`. Move them to a bridge module the day this engine
has to work without Tuqui; nothing else here knows the consumer exists, and
the engine itself still depends on `base` alone.
