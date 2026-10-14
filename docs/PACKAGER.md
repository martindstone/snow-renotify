# Packager

`npm run package` turns the YAML records under `src/` (and `addons/*/`) into Update Set XML files in `update_set/`,
ready to import on an instance (System Update Sets > Retrieved Update Sets > Import Update Set from XML).

```
npm run package                      # src/ -> update_set/PagerDuty Renotify v<version>.xml (and any addons/<name>/)
npm run package -- --from=src --out=update_set --now=2026-10-08T17:00:00Z
```

Each package directory holds `defaults.yaml` (author, name prefix, version) and `sys_remote_update_set.yaml`
(the Update Set record) next to the records. The Update Set is named `<versionPrefix><version>`.

Packages are `src/` plus any `addons/<name>/` directory, each with its own Update Set (`addons/tests/` is the optional ATF tests package).

## What it checks (all problems are listed together; any problem fails the build, exit code 1)

- every `$ref` file exists (`.js` falls back to `.es12.js`, as in the app); yaml parses;
- required keys on every record (`name`, `type`, `target_name`, `payload.record_update`);
- no two records share an update name; no two share an `update_guid`;
- every record belongs to the Update Set's application;
- `defaults.yaml` / `sys_remote_update_set.yaml` are complete, ids are 32 hex characters;
- after writing, the XML is re-read: well formed, right record count, unique ids, every payload parses, every
  record linked to the Update Set.

## How it differs from the integration app's packager (`scripts/package/index.js`)

| | App packager | This packager |
|---|---|---|
| Record ids | position in the file list (`000…0`, `000…1`, …) | md5 of (update set id, record name): stable, and no two update sets share record ids |
| Update Set ids | fixed in the yaml (shared by every release) | ours are different, so importing this never replaces the app's retrieved Update Set |
| Timestamps | builder's local time | UTC |
| File order | glob order | sorted |
| Failure | prints, exit code 0 | prints every problem, exit code 1 |
| Options | `--release=false` turns release mode on; `--from=` crashes; `a=b` values are cut | unknown options and empty values are errors |
| Scope | `--release` flips it between `x_pd_integration` and `x_pd_integration_dev` | always what the yaml says |
| Extra elements | adds `sys_created_by`/`sys_updated_by` to the `sys_documentation` wrapper element | does not (`--legacy` reproduces it) |

## Checked against the app's own release

`test/packager.test.js` builds the app's source at commit `bd9edf03` with `--legacy` and the app's `--release`
exclusions, and compares it with the committed `releases/pagerduty-v8.4.3.xml`, record by record. The update set
record and 1,833 of 1,856 records are identical. The rest is **drift in the committed release, not packager
differences**: 23 records whose scripts or pages differ (`HealthcheckController`, `PagerDuty_REST`, `PagerDutyProvisioning`,
the `Provision Group` UI Actions, …) and 3 records (`IncidentWebhooksLookup` and a field and its map) that exist in the source
and not in the release. The release file is stamped 2026-06-17 17:54:28 UTC, and was committed on 2026-08-24.
The test pins those numbers.

## Findings about the integration app's packager

Confirmed against its code or against the committed release:

1. **Exit code is always 0.** `run().catch(...)` prints and returns; a missing `defaults.yaml` or an unreadable `$ref` still "succeeds" in CI.
2. **Option parsing.** `--release=false` is the truthy string `"false"` and enables release mode; `--from=` becomes `true`; `--x=a=b` becomes `a`. Checked by running its `parseOptions`.
3. **Local-time timestamps.** `dateformat(now, …)` without UTC. In the release, `sys_recorded_at` decodes to 17:54:28 UTC while `sys_created_on` says 14:54:28: the builder ran at UTC-3.
4. **Stray elements.** For `sys_documentation` it writes `sys_created_by`/`sys_updated_by` on the outer wrapper (which only carries attributes) as well as the real record: 80 records in v8.4.3.
5. **Record ids by position, and one fixed Update Set id.** Every release reuses `000…0` to `000…1855` and Update Set `16199b61…`. That is deliberate for the app's own releases (each replaces the last) but means any other package built the same way would overwrite the app's retrieved Update Set. `glob` does not guarantee order, so the ids are only stable by luck.
6. **No validation.** Duplicate update names are not detected; a record with no `name` throws a `TypeError` (`item.name.startsWith`) instead of naming the file.
7. **`payload_hash` is 0** on every record.
8. **The committed release is not what the committed source builds** (see above), and its commit message says v8.4.1 while it adds v8.4.3.

Not verified: whether item 7 weakens collision detection in the platform's import preview, and whether items 5's
overwrite behaviour is what the platform actually does on import (I have not imported two Update Sets with equal ids).

## Preview after a back-out: "Found a local update that is newer than this one"

If the same records were installed before and then **backed out** (or deleted by hand), the instance keeps local `DELETE`
updates for them. When the update set is imported again, the preview reports one *error* per record ("Found a local update that is
newer than this one"; the problem row names the local update as `missing_item_update`). The platform does not overwrite local
updates on its own: each problem lists the actions *Show local record, Show local update, Compare with local, **Accept remote update**,
Skip remote update*. To reinstall, select all the problems in the preview's related list and choose **Accept remote update**; the
errors clear and **Commit** becomes available.

Rebuilding does **not** help (the build time is not what is compared): the local updates are what trigger it. The same preview
on an instance that never had the records, or after the local update set is removed, is clean.

(An earlier version of this section blamed the build's timestamps. That was wrong: a rebuild stamped later than the local deletes
produced the same errors.)

## Naming of dictionary records

A dictionary record's update name is `sys_dictionary_<table>_<element>`, and for the table's own entry `<element>` is `null`
(`NULL` for import set tables). The packager rejects any other name. The collection record of the renotify table was once named
with a trailing `_` instead, which the platform would have treated as a different record.
