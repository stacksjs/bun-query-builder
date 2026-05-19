# Stacks ORM / Query Builder / Migration Audit

**Date:** 2026-05-08
**Scope:** Four parallel agent audits across:
- `bun-query-builder/packages/bun-query-builder/src` (query builder)
- `stacks/storage/framework/core/orm/src` (ORM / model layer)
- `stacks/storage/framework/core/database/src` (migrations / schema)
- ORM codegen pipeline

**TL;DR:** It's worse than the missing `withPivot`. ~80 distinct gaps surfaced. The most alarming aren't features but **silent correctness bugs masquerading as working code**.

---

## The five things to be most freaked out about

### 1. Every migration column is silently `NULL`-able
`bun-query-builder/src/migrations.ts:341` hardcodes `const isNullable = true`. Validation rules (`required`, `min`) are never read. Confirmed in production schema: `payments.order_id`, `payments.amount`, `payments.method`, `print_devices.name` are all nullable when they shouldn't be. **Whatever NOT NULL constraints you think you have, you don't.**

### 2. Mass assignment is not enforced anywhere
`fillable` and `guarded` are declared in `ModelDefinition` and used by codegen/route generation, but `Model.create()` and `Model.update()` accept any keys (`define-model.ts:415-432`, `486-507`). If any controller pipes `req.json()` into `User.create()`, an attacker sets `is_admin: true`. There is no `MassAssignmentException`.

### 3. Instance writes skip the mutator pipeline
`Model.update(id, { password })` runs `applyDefinedSetters` → bcrypt. But `inst.password = 'plain'; inst.save()` skips it (proxy `set` trap at `define-model.ts:160-189` doesn't invoke `set:`). **Plaintext passwords waiting to land.**

### 4. `migrate:rollback` does not roll back
`actions/migrate-rollback.ts:42-110` deletes the migration row and unlinks the file. **Schema unchanged.** Worse than no rollback because the command claims success. Also: rollback issues `WHERE migration = $1` for all dialects, so on MySQL/SQLite it throws before doing even the no-op delete.

### 5. Polymorphic relations are declared, not implemented
Types accept `morphTo` / `morphMany` / `morphToMany` / `morphedByMany` (`types/src/model.ts:218-224`); `getRelations()` only handles `morphOne` (`utils.ts:91-93`). The other four are silently ignored at runtime — declaring them does nothing. Same trap for `hasManyThrough` (declared, never resolved on `.with()`).

---

## The structural finding

**`ModelQueryBuilder` exposes ~40% of `bun-query-builder`.** Roughly two-thirds of QB features (`withPivot`, `wherePivot*`, `whereHas`, `whereDoesntHave`, `withCount`, `withTrashed`/`onlyTrashed`, `cursorPaginate`, `chunkById`, `lazy`, `union`/`unionAll`, `whereExists`, `whereJsonContains`, `lockForUpdate`/`sharedLock`, `tap`, `joinSub`) exist on the underlying `SelectQueryBuilder` (`client.ts`) but are never re-exposed on the model chain (`orm.ts:1296-2050`). Stacks' `builder.ts:320` types declare some of them — so consumers trust the types and hit runtime "method does not exist."

**`withPivot` is one symptom of this larger pattern.** Fix the pattern, not just the symptom.

---

## The codegen finding

There is essentially **no model→ORM codegen**. `storage/framework/orm/src/` is one 15-line `index.ts` re-exporting `prunable`. `core/orm/src/index.ts:313-319` admits it: `InferFillableAttributes`, `ModelCreateData`, `ModelRowLoose`, `InferColumnNames` are all stubbed as `any`. `UserModel`, `NewUser` resolve to `any`. The "fully typed model row" promise that other Stacks packages depend on is not delivered.

The cast registry is duplicated by hand at `core/orm/src/index.ts:21-73` AND `storage/framework/orm/routes.ts:101-111`, with a comment at `routes.ts:98-100` openly admitting the drift hazard.

`make:model NAME` overwrites without confirmation (`make.ts:399-408`) and emits a 20-line stub with no relations / fillable / traits — vs the 113-line `defaults/User.ts` that's the actual idiomatic model.

Model load errors are silently swallowed (`routes.ts:41-43`, `core/orm/src/index.ts:79, 92` — bare `catch {}`). A typo in a model = invisible failure, zero CRUD routes registered, no log line.

---

## Top 12 cross-cutting fixes (ranked by blast radius)

| # | Fix | Layer | Severity |
|---|---|---|---|
| 1 | `isNullable = true` hardcode at `bun-query-builder/src/migrations.ts:341` — read validation rules | migrations | critical |
| 2 | Enforce `fillable`/`guarded` at `Model.create`/`update` write boundary; throw `MassAssignmentException` | orm | critical |
| 3 | Run `applyDefinedSetters` in proxy `set` trap so `inst.password = ...; inst.save()` hashes | orm | critical |
| 4 | Real rollback: emit paired `down.sql` (or invert from snapshot) and execute it | migrations | critical |
| 5 | Wrap each migration file in BEGIN/COMMIT + `pg_advisory_lock` (primitive already at `client.ts:5389`) | migrations | critical |
| 6 | Wire polymorphic + `hasManyThrough` runtimes (`utils.ts:58-95`); types currently lie | orm | critical |
| 7 | Mirror QB → `ModelQueryBuilder`: `withPivot`, `wherePivot*`, `whereHas`, `whereDoesntHave`, `withCount`, `lockForUpdate`, `cursorPaginate`, `chunkById`, `withTrashed`/`onlyTrashed`, `union`/`unionAll`, `whereExists`, `whereJsonContains`, `tap` | qb | critical |
| 8 | `belongsToMany` runtime: `attach` / `detach` / `sync` / `toggle` / `syncWithoutDetaching` / `updateExistingPivot` / `wherePivot` | orm | critical |
| 9 | Replace `any`-stub type utilities at `core/orm/src/index.ts:313-319, 328-331`; emit per-model `.d.ts` row+insert+update types | codegen | critical |
| 10 | Fix Postgres `modifyColumn` (`drivers/postgres.ts:132-137`) — no nullable/default toggle; SQLite `modifyColumn` returns `-- comment` (`drivers/sqlite.ts:136-140`); rollback `$1` placeholder mismatch (`migrate-rollback.ts:86`) | migrations | critical |
| 11 | Add lifecycle: `saving`/`saved`, `restoring`/`restored`, `retrieved`; `saveQuietly`/`withoutEvents` escape hatch | orm | high |
| 12 | Stop swallowing model load errors (`routes.ts:41-43`, `core/orm/src/index.ts:79, 92`); make `make:model` non-destructive + feature-rich | codegen | high |

## Suggested batching

- **Batch A (security, fast wins, ~1-2 days):** #2, #3, #12. Pure orm-side, no QB changes. Closes the two biggest security holes and stops invisible model failures.
- **Batch B (correctness, ~3-5 days):** #1, #4, #5, #10. All migration/schema. One PR per fix, each independently verifiable. After this, "I ran the migrations" actually means something.
- **Batch C (capability, ~1-2 weeks):** #7, #8. The `ModelQueryBuilder` rebuild — adds chain methods that delegate to QB. `withPivot` falls out of this. Mostly mechanical.
- **Batch D (correctness, ~3-5 days):** #6, #11. Wire the missing relation types and lifecycle events. Touches `define-model.ts` and `utils.ts`.
- **Batch E (DX, ~1 week):** #9. Real codegen pipeline. Highest leverage long-term but easiest to defer.

---

# Audit 1 — Query Builder (`bun-query-builder`)

## Pivot / many-to-many

| # | Feature | What it does | Evidence | Severity |
|---|---|---|---|---|
| 1 | `withPivot` on **ORM `ModelQueryBuilder`** | Pull extra pivot columns onto the related row when eager-loading via `.with()` | Exists on raw QB at `client.ts:906–915` and `client.ts:2295` (`pivotColumns Map`), but **absent from `ModelQueryBuilder`** in `orm.ts:1296–2050`. Eager-loader at `orm.ts:1740–1801` collects pivot extras into a `pivot` proxy, but no public method to opt-in or rename. | **Critical** |
| 2 | `wherePivot` / `wherePivotIn` / `wherePivotNotIn` / `wherePivotNull` / `wherePivotNotNull` on **ORM** | Filter the parent query by pivot columns | Exists on raw QB (`client.ts:917–952`) and on `BelongsToManyRelation` mutation object (`orm.ts:1031–1066`), but **not on `ModelQueryBuilder`**. Means you can't write `User.query().with('roles').wherePivot('roles', 'role', 'admin')`. | **Critical** |
| 3 | `wherePivotBetween` | Range filter on pivot column | No matches anywhere. | High |
| 4 | `withPivotValue(col, val)` | Auto-attach a constant filter + auto-set on attach | No matches. Common for tagged unions like `roles.scope='org'`. | High |
| 5 | `withTimestamps()` chained on relation | Auto-stamp pivot `created_at`/`updated_at` on attach | Pivot timestamps are auto-filled when `pivot.timestamps: true` is in the model definition (`orm.ts:1152`), but no chained `withTimestamps()` API; must hardcode on the model. | Medium |
| 6 | `using(PivotModel)` — custom pivot model class | Treat pivot rows as instances of a model with hooks/casts | No matches. The `through:` config (`orm.ts:910–960`) supports through-model name for **discovery**, but pivot rows return as plain `_pivot` objects. | High |
| 7 | Pivot column aliasing (`->as('membership')`) | Rename the pivot accessor on returned instances | Eager-loader hardcodes pivot accessor as `_pivot` (`orm.ts:1796–1803`). | Medium |
| 8 | `attach` / `detach` / `sync` / `toggle` / `updateExistingPivot` | CRUD on pivot rows | All present in `orm.ts:1156–1289` on `BelongsToManyRelation`. **All present.** | — |
| 9 | `syncWithoutDetaching` | `sync()` that only adds missing rows | No matches. | High |

## Relationships

| # | Feature | What it does | Evidence | Severity |
|---|---|---|---|---|
| 10 | `hasOne` / `hasMany` / `belongsTo` / `belongsToMany` | Standard relations | All present (`orm.ts:143–148`, eager loader `orm.ts:1674–1801`). | — |
| 11 | `hasOneThrough` / `hasManyThrough` | Distant relation through intermediate model | Declared in types (`orm.ts:147–148`); resolved in `Stacks` ORM (`utils.ts:130 processHasThrough`); but ORM eager-loader at `orm.ts:1658–1801` has **no branch for `hasOneThrough`/`hasManyThrough`**. So declaring them does nothing on `.with()`. | **Critical** |
| 12 | `morphOne` / `morphMany` | Polymorphic one/many | Declared in types (`orm.ts:149–150`). Raw QB handles them in `client.ts:2910–2935`. **No branch in the ORM eager loader.** | High |
| 13 | `morphTo` (inverse) | "Belongs to one of many parent types" | Declared (`orm.ts:151`) but never resolved in QB or ORM eager loaders. `morphMap` registry is missing entirely. | High |
| 14 | `morphToMany` / `morphedByMany` | Polymorphic many-to-many | Declared (`orm.ts:152–153`); QB handles `morphToMany` and `morphedByMany` at `client.ts:2866–2909`; no ORM-level eager-load branch and no pivot mutation API for morph pivots. | High |
| 15 | `whereHasMorph(rel, [Type1, Type2], cb)` | Constrain morphTo by concrete model types | No matches. | Medium |
| 16 | `hasOneOfMany` / `latestOfMany` / `oldestOfMany` | "Latest order per user" sub-aggregation | No matches in either repo. | High |
| 17 | `chaperone` | Auto-set inverse relation when accessing children | No matches. | Low |
| 18 | Self-referencing relations | `User.belongsTo(User)` etc. | No special handling; `client.ts:2804` `pick` chain doesn't dedupe self-keys; possible alias collision in JOIN paths. | Medium |
| 19 | `load(rel)` / `loadMissing` / `loadCount` / `loadMax` / `loadAvg` / `loadSum` / `loadExists` | Lazy eager-load on already-fetched instances | No matches. Forces refetch when relations weren't preloaded. | High |
| 20 | `withCount` on **ORM** | Aggregate child count column | Exists on QB (`client.ts:3207`, `2509–2534`); **not exposed on `ModelQueryBuilder`**. | **Critical** |
| 21 | `withSum` / `withAvg` / `withMax` / `withMin` / `withExists` | Relation aggregates beyond count | No matches anywhere. | High |
| 22 | `whereHas` / `whereDoesntHave` / `orWhereHas` on **ORM** | Constrain parent by relation existence | Exists on QB (`client.ts:2997`, `3052`). Stacks `builder.ts:320` declares `whereHas` in its type interface and `subquery.ts` builds subquery args, but bun-query-builder `ModelQueryBuilder` (`orm.ts`) does not implement `whereHas`. | **Critical** |
| 23 | Constrained eager loading (`with({ posts: q => q.where(...) })`) | Pass a callback to filter eagerly loaded children | `ModelQueryBuilder.with()` only accepts string relation names (`orm.ts:1580–1585`). No callback overload. | **Critical** |

## Query features

| # | Feature | What it does | Evidence | Severity |
|---|---|---|---|---|
| 24 | `selectSub(query, alias)` / `fromSub` | Subquery in SELECT or FROM clause | `joinSub` exists (`client.ts:668`, `3948`); `selectSub`/`fromSub` — no matches. | High |
| 25 | `whereExists` / `whereNotExists` on **ORM** | EXISTS subquery filter | `whereExists` exists on QB (`client.ts:843`, `3502`); **not on `ModelQueryBuilder`**. `whereNotExists` is missing from QB too. | High |
| 26 | `whereJsonContains` / `whereJsonLength` / `whereJsonContainsKey` on **ORM** | JSON column ops | Exist on QB (`client.ts:512`, `857`, `881`); **not on `ModelQueryBuilder`**. | High |
| 27 | Window functions | ROW_NUMBER / RANK / DENSE_RANK | QB hardcodes these inline (`client.ts:2601–2640`); no public `.window(...)` API for arbitrary partitions/order/aggregates. | Medium |
| 28 | CTE `with('cteName', subquery)` / recursive CTEs | Common Table Expressions | QB declares "non-recursive" and "recursive" CTE support at `client.ts:988–1005` (comments only — verify). ORM has no surface for it. | Medium |
| 29 | `union` / `unionAll` on **ORM** | Combine queries | Exist on QB (`client.ts:777`, `791`, `4095`); **not on `ModelQueryBuilder`**. | High |
| 30 | `intersect` / `except` | Set ops | No matches anywhere. | Medium |
| 31 | `lockForUpdate` / `sharedLock` on **ORM** | Pessimistic row locks | Exist on QB (`client.ts:971`, `983`, `4539–4548`); **not on `ModelQueryBuilder`**. Critical for any concurrent transactional code. | **Critical** |
| 32 | `cursorPaginate` on **ORM** | Keyset pagination | Exists on QB (`client.ts:1085`, `4158`); **not on `ModelQueryBuilder`**. Only offset `paginate(page, perPage)` exists at `orm.ts:1948`. | High |
| 33 | `chunkById` / `lazy` / `lazyById` on **ORM** | Memory-safe iteration via PK cursoring | Exist on QB (`client.ts:1111`, `1277`, `4202`, `4416`); **not on `ModelQueryBuilder`**. The ORM `chunk()` (`orm.ts:1925`) uses **OFFSET-based** chunking, which silently skips/duplicates rows when concurrent inserts/deletes happen mid-iteration. Classic Eloquent bug warned against. | **Critical** |
| 34 | `upsert` / `insertOrIgnore` on **ORM** | Bulk upsert / conflict ignore | Exist on QB (`client.ts:1800–1803`); **no ORM equivalent**. ORM only has `updateOrCreate`/`firstOrCreate` row-by-row. | High |
| 35 | `updateOrCreate` / `firstOrCreate` | Find-or-write | Both present (`orm.ts:2209`, `2225`, also `define-model.ts:470`, `487`). Implementation is non-atomic (read-then-write race). | Medium |
| 36 | Soft deletes ORM surface | `withTrashed` / `onlyTrashed` / `restore` / `forceDelete` | `withTrashed`, `onlyTrashed`, `forceDelete` are wired in Stacks `define-model.ts:1049–1051`. `restore` — no matches. Trait `useSoftDeletes` is recognised in `orm.ts:208–209`, but `ModelQueryBuilder` has **no `withTrashed()` / `onlyTrashed()` chain methods** — they live on static `define-model` helpers. | High |
| 37 | Global scopes / local scopes | Auto-applied query constraints; named filter methods | The `scopes` field at `orm.ts:159` is for attribute *mutators*, not query scopes. No `addGlobalScope` / `withoutGlobalScope` / scope method generation. | High |
| 38 | `tap` on **ORM** | Side-effect inspection of builder | Exists on QB (`client.ts:1148`, `4275`); **not on `ModelQueryBuilder`**. `when` is present (`orm.ts:1534`). | Medium |
| 39 | Raw expression safety | Parameterized vs string concat | `whereRaw` parameterizes (`orm.ts:1453`, good). `_addGroup` re-injects raw with concat (`orm.ts:1499`); `buildQuery` interpolates `_select`, `_orderBy`, `_limit`, `_offset` directly into SQL strings (`orm.ts:1623–1636`). Identifier validation enforced at QB layer (`validateIdentifier` calls in `client.ts`) but **not in `ModelQueryBuilder`**. | High |

### Macro finding

`ModelQueryBuilder` in `orm.ts:1296–2050` is dramatically thinner than the underlying `SelectQueryBuilder` in `client.ts`. Roughly 60% of QB feature surface is implemented at the lower layer but never re-exposed on the model query chain. Stacks `builder.ts` types **declare** several of these (e.g. `whereHas`, `whereExists`) which means consumers will hit a runtime "method does not exist" if they trust the types. `withPivot` is the symptom you noticed.

---

# Audit 2 — Stacks ORM / Model Layer

## Lifecycle / events

| gap | description | evidence | severity |
| --- | --- | --- | --- |
| `saving` / `saved` events | Only `creating/created`, `updating/updated`, `deleting/deleted` are dispatched. Eloquent's `saving`/`saved` (fires on every persist) absent. | `define-model.ts:925-957`; no grep hits | high |
| `restoring` / `restored` events | Soft-delete restore writes directly via `q.update({deleted_at: null})` without firing observer events. | `traits/soft-deletes.ts:98-105` | high |
| `retrieved` event | No dispatch on read. | no grep hits | medium |
| `replicating` event | Bound to the missing `replicate()` feature below. | no grep hits | low |
| Class-based observers | `traits.observe` only takes `true \| string[]` to enable lifecycle dispatch through `@stacksjs/events`. No `Model.observe(MyObserver)` pattern. | `define-model.ts:887-957` | medium |
| `$dispatchesEvents` map (custom event classes per lifecycle) | Eloquent lets you map `created → UserCreated::class`. Stacks dispatches a fixed `${model}:created` string. | no grep hits | low |
| `withoutEvents()` / `saveQuietly()` / `deleteQuietly()` escape hatch | No way to suppress events for a single operation. | no grep hits | high |
| `beforeSave` / `afterSave` hooks | Only `beforeCreate/afterCreate`, `beforeUpdate/afterUpdate`, `beforeDelete/afterDelete` exist. | `define-model.ts:931-953` | medium |

## Casts & accessors

| gap | description | evidence | severity |
| --- | --- | --- | --- |
| Missing built-in casts | `builtInCasters` covers only `string, number, integer, float, boolean, json, datetime, date, array`. Missing: `object`, `collection`, `timestamp`, `decimal`, `enum`, `encrypted`, `hashed`. | `define-model.ts:11, 21-73` | high |
| `decimal` cast with precision | Critical for money columns. Currently `cast: 'number'` rounds wrong. | no grep hits | high |
| `enum` cast | No way to map a DB string to a TS enum / union. | no grep hits | medium |
| `hashed` cast | User must hand-write `set: { password: makeHash }`. A `cast: 'hashed'` would make this declarative. | hand-written setter, not a cast | medium |
| Custom CastsAttributes interface | `CasterInterface { get, set }` is supported via passing the object directly. No way to register a *named* custom cast. | `define-model.ts:16-19, 75-77` | low |
| Accessors / mutators | Supported as `get: { name: (attrs) => ... }` and `set: { password: async (attrs) => ... }`. **Setter pipeline (`applyDefinedSetters`) only fires on static `Model.update(id, data)`; instance `inst.field = x; inst.save()` skips it.** | `define-model.ts:350-367`; no `set:` invocation in proxy `set` trap (`define-model.ts:160-189`) | high |
| `$appends` (computed attributes appended to JSON output) | `get:` defines accessors but they aren't auto-included in `toJSON()`. No `appends: ['salutation_name']` array. | no grep hits | medium |
| `makeVisible` / `makeHidden` runtime overrides | `hidden: true` is static per attribute. | no grep hits | low |
| `$visible` allowlist | Only `hidden` denylist exists. | only `getHiddenAttributes` (`utils.ts:413-420`) | low |

## Mass assignment

| gap | description | evidence | severity |
| --- | --- | --- | --- |
| `$guarded` runtime enforcement | `guarded: true` is collected (`utils.ts:422-433`) but no path strips guarded fields from `Model.create()` / `Model.update()` payloads. | `utils.ts:422-433`; `define-model.ts:415-432`, `486-507` accept any keys | critical |
| `MassAssignmentException` | No error type, no enforcement. | no grep hits | high |
| `forceFill` | No documented escape hatch. | no grep hits | low |
| Fillable enforcement on writes | `fillable: true` is collected for migration/route generation but isn't enforced at runtime write boundary. | `utils.ts:435-470` only returns the list; `define-model.ts` write wrappers don't filter | critical |

## Soft deletes

All present. `useSoftDeletes` trait wires `softDelete`, `restore`, `forceDelete`, `withTrashed`, `onlyTrashed` plus cascade option (`traits/soft-deletes.ts:86-130, 312-334`). One nit: cascade is hardcoded to `<parent>_id` foreign key (`soft-deletes.ts:326`) — models with custom FK names break silently.

## Serialization

| gap | description | evidence | severity |
| --- | --- | --- | --- |
| Date format control | `datetime` caster always emits `toISOString()`. No `$dateFormat` knob. | `define-model.ts:53-60` | medium |
| Pivot serialization (`withPivot`, `as`) | No belongsToMany pivot column control on output. | no grep hits | medium |
| Relationship serialization control | Eager-loaded relations serialized via wrapped proxy chain; no per-relation `hidden`/`visible` override. | `define-model.ts:151-155` | low |
| `toArray()` (vs `toJSON()`) | Only `toJSON()` is referenced. | no grep hits | low |

## Relations

| gap | description | evidence | severity |
| --- | --- | --- | --- |
| Polymorphic relation runtime | Type definitions exist for `morphTo`, `morphMany`, `morphToMany`, `morphedByMany` (`types/src/model.ts:218-224`) but `getRelations()` only processes `morphOne` (`utils.ts:91-93`). The other four are silently ignored. | `utils.ts:58-95` | critical |
| `belongsToMany` runtime ops | No `attach()`, `detach()`, `sync()`, `toggle()`, `wherePivot()`, `withPivot()` methods. Pivot tables only used for migration generation. | no grep hits in `core/orm/src/` | critical |
| Inverse-relation auto-resolution | A `belongsTo: ['Author']` on Post does not auto-define `Author.posts`. | no auto-inverse logic | low |
| `touches` (timestamp propagation to parents) | Updating a comment doesn't bump the post's `updated_at`. | no grep hits | medium |
| `chaperone` / inverse hydration | Eager-loaded children don't get back-references to parent set on them. | no grep hits | low |
| `hasManyThrough` runtime | Type-declared (`types/src/model.ts:214`) but `getRelations()` only processes `hasOneThrough` (`utils.ts:79-83`). | `utils.ts:58-95` | high |

## Factories & seeding

| gap | description | evidence | severity |
| --- | --- | --- | --- |
| Per-attribute factory only | `factory: faker => ...` defined per *attribute*, not per *model*. No `Model.factory().create()` method, no factory class. | `define-model.ts:750`; `seeder.ts:244-249` | high |
| States (`->state('admin')`) | No way to define named variations of a model's defaults. | no grep hits | high |
| Sequences | No per-call counter / cycling values. | no grep hits | medium |
| `for(parent)` / `has(child)` chaining | Cannot say `User.factory().has(Post.factory().count(3)).create()`. | no grep hits | high |
| `afterCreating` / `afterMaking` callbacks | No factory lifecycle hooks. | no grep hits | medium |
| Idempotent seeders | `seeder.ts` has `truncate` option but no upsert-on-key seeding, no "seed once" markers. | `seeder.ts:48-60` | medium |
| Class-based `Seeder`s with explicit dependencies | Seeder is data-driven. No `DatabaseSeeder.run()` ordering primitive. | `seeder.ts:467+` flat loop | medium |

## Validation

| gap | description | evidence | severity |
| --- | --- | --- | --- |
| `unique:ignoringSelf` on update | Validator has `unique(table, column, exceptId?)` but auto-route update path doesn't pass row's id, so updating with existing email triggers "already taken." | `validation/dist/validator.d.ts:15` | high |
| Per-attribute validation | Present via `validation: { rule: schema.x() }`. | all present | — |

## Misc

| gap | description | evidence | severity |
| --- | --- | --- | --- |
| ULID primary keys | UUID supported via `traits.useUuid`. ULID isn't. | no grep hits | medium |
| Composite primary keys | `primaryKey: 'id'` is a single string. No tuple support. | `define-model.ts:743` | medium |
| Custom primary key column | Supported (`primaryKey: 'uuid'`). | `define-model.ts:381, 743` | — |
| `incrementing = false` | `autoIncrement?: boolean` exists (`define-model.ts:744`) but no code path consumes it at model layer (only migration generators). | `define-model.ts:743-744` | medium |
| Multiple connections / read replicas | `DatabaseConnections` interface only allows one of each driver type. Models can't declare a connection. | `database/src/driver-config.ts:102-107` | high |
| Table prefix / schema qualifier | Driver config has `prefix` but isn't threaded through `define-model.ts`. | `define-model.ts` never references `prefix` | medium |
| `replicate()` / clone with overrides | No way to deep-copy a model row with optional overrides. | no grep hits | medium |
| `firstOr` / `findOr` (callback variant) | `firstOrFail`, `findOrFail`, `firstOrCreate` exist. Callback forms don't. | `define-model.ts:445-466` | low |
| `is()` / `isNot()` (model identity) | No model-equality helper. | no grep hits | low |
| Batch `upsert` / `insertMany` | `Model.create()` is single-row. No `Model.upsert(rows, conflictKeys)` or `Model.insertMany(rows)`. | no grep hits | high |
| Global scopes | `ModelDefinition.scopes?` field exists in types (`types/src/model.ts:226-228`) but isn't consumed in `define-model.ts`. Default queries can't auto-apply tenancy or `where active = 1`. | `define-model.ts` never reads `definition.scopes` | high |
| Local scopes | Same as above — declared in types, ignored at runtime. | same evidence | medium |

---

# Audit 3 — ORM Codegen Pipeline

## TL;DR

The "model→ORM auto-generation pipeline" is **mostly absent**. The advertised `storage/framework/orm/src/` directory contains exactly one 15-line `index.ts` (re-exports `prunable`) and one utility file — **no generated model classes, no generated row types, no generated query builders, no factories, no seeder stubs, no controllers, no schema artifacts**. Models are loaded at runtime via `loadUserlandModel()` in `storage/framework/core/orm/src/index.ts:69-95`, and types are inferred lazily from `bun-query-builder` (with several type utilities currently stubbed as `any` — `core/orm/src/index.ts:313-319`). The only real generator emits SQL migration files.

## Generation Triggers

| Command | Output | Notes |
|--|--|--|
| `buddy generate:migrations` | SQL files in `database/migrations/` | Delegates to `qbGenerateMigration` (bun-query-builder); stacks code wraps it in `generateMigrations()` at `core/database/src/migrations.ts:540` |
| `buddy generate:openapi` | `storage/framework/api/openapi.json` | Reads runtime route registry only — not models — `core/api/src/generate-openapi.ts:96` |
| `buddy generate:types` | Delegates to `bun --filter generate:types` script in `frameworkPath()/package.json` | If script missing, **silently disables itself** (`core/actions/src/generate/index.ts:157`) |
| `buddy make:model NAME` | Single file `app/Models/NAME.ts` from a 20-line stub template | `core/actions/src/templates.ts:139-159`; stub omits relations, traits, hidden, casts, `set`/`get`, indexes |
| `buddy generate` (with no args) | **Nothing — entire prompt is commented out** | `core/buddy/src/commands/generate.ts:54-72` is dead code |

## Generated Artifacts — What's Emitted vs Missing

| Feature | Emitted? | Evidence | Severity |
|--|--|--|--|
| TS row type per model | No (runtime-only via `ModelRow<T>`) | `core/orm/src/types.ts:48` | High |
| Per-model query-builder narrowing | Stubbed | `core/orm/src/index.ts:313-319` — `InferFillableAttributes`, `ModelCreateData`, etc. = `any`. README at `core/orm/src/index.ts:6-7` admits "stubs … intentionally fall back to `any`" | **Critical** |
| Relation methods on the model | Runtime via proxy only | `core/orm/src/define-model.ts:117-238`; no static type for `post.author` / `post.comments` — hits `any` | High |
| Factory stubs | None | `generateSeeder()` at `core/actions/src/generate/index.ts:235` is empty `async () => {}` | Medium |
| Seeder stubs | None | Same as above | Medium |
| API controller / route scaffolding | Runtime CRUD via `useApi` trait inside `storage/framework/orm/routes.ts` (1012 lines) — **not codegen** | No file emitted | Medium |
| OpenAPI per model | No | `generate-openapi.ts:96` only reflects `listRegisteredRoutes()`; does NOT walk `model.attributes` | High |
| GraphQL schema | Not implemented anywhere | grep "graphql" yields zero hits | Low |
| Migration SQL from attributes | Yes (delegated to bun-query-builder) | `core/database/src/migrations.ts:551` | — |
| Frontend / dashboard types | None per-model | `storage/framework/types/orm-globals.d.ts` is hand-written (95 lines, generic-only) | High |
| `NewUser`/`UserModel` typed exports | **Hardcoded to `any`** | `core/orm/src/index.ts:328-331`: `export type UserModel = ModelRowLoose<unknown>` and `ModelRowLoose<_M> = any` | **Critical** |

## Drift / Correctness Traps

| Trap | Status | Evidence | Severity |
|--|--|--|--|
| Polymorphic morph columns (`morph_type`/`morph_id`) | **Trait pivot tables hand-typed**; no auto-add when a model declares `commentable: true` | `core/orm/src/index.ts:340-388` hard-codes `CategorizableTable`, `CommentablesTable`, `TaggableTable`. `define-model.ts` has zero `morphTo`/`morphMany` references. | High |
| `belongsToMany` pivot generation | Schema generation delegated to bun-query-builder; nothing in stacks layer auto-creates the pivot file or types its row | `core/orm/src/utils.ts:85-87, 335-372` | High |
| Composite indexes | Defined on the model (`indexes: [{name, columns}]`) but **never mentioned** in any generator | `defaults/app/Models/User.ts:14-19` | Medium |
| Partial / functional indexes | Not expressible in `StacksModelDefinition` | `core/orm/src/define-model.ts:746` lacks `where` / `expression` field | Medium |
| Foreign key cascade rules (`onDelete`, `onUpdate`) | Not in attribute schema | `define-model.ts:740-755` lacks any cascade declaration; SQLite `ALTER TABLE ADD CONSTRAINT` is **deleted at preprocess** (`migrations.ts:184-188`) — even bun-query-builder's emitted constraints silently dropped | High |
| Soft-delete column auto-add | Trait detected at runtime (`useSoftDeletes`) but no migration generator stamps `deleted_at` | `core/orm/src/traits/soft-deletes.ts` | Medium |
| Timestamp columns auto-add | Same — runtime trait only | `routes.ts:743-747, 841-843` | Low |
| Enum columns | MySQL-only path; no SQLite/Postgres branch, no TS enum type emission | `core/database/src/drivers/helpers.ts:305-320` | High |
| Generated/computed columns | Not modeled anywhere | grep `generatedAs\|alwaysGenerated` returns zero hits | Medium |
| Full-text indexes | Not modeled | grep `fullText\|FULLTEXT` returns zero hits | Medium |
| Spatial / GEOMETRY | Not modeled | Same | Low |
| Nullable column inference | `attributes.foo.nullable` flag is **not in the StacksModelDefinition type** | `define-model.ts:748-753` | High |
| Default values | Not in StacksModelDefinition | Same | Medium |
| Cast/accessor type signatures | Cast resolvers exist twice — `core/orm/src/index.ts:21-73` and `storage/framework/orm/routes.ts:101-111`. Drift hazard explicitly acknowledged in comment at `routes.ts:98-100` | High |
| `routes.ts` → `define-model.ts` cast drift | Same registry duplicated by hand | `routes.ts:98-100` "duplicate here is the simplest way to keep auto-CRUD parity" | High |
| Generated `belongsTo` FK type | Forces `number` only — `${Lowercase<K>}_id: number` | `core/orm/src/types.ts:35-38` — breaks for UUID/string PKs | Medium |
| SQLite migration preprocessing deletes files | `preprocessSqliteMigrations()` `unlink`s any migration whose only statement is `ALTER TABLE ADD CONSTRAINT` or duplicate `CREATE UNIQUE INDEX` | `migrations.ts:101-292` | Medium |

## Developer Ergonomics

| Concern | Status | Severity |
|--|--|--|
| Malformed-model error messages | Routes loader silently swallows broken models: `routes.ts:41-43` `catch { /* Skip models that fail to import */ }`. ORM index also: `core/orm/src/index.ts:79, 92` `catch { /* fall through */ }`. A typo in a model = invisible failure. | **Critical** |
| Generated code formatted/lint-clean | N/A — almost nothing is generated. Migration SQL is concatenated by hand at `migrations.ts:606`; no `prettier`/lint pass. | Low |
| Stable output / no spurious diffs | Migrations dedupe by substring match (`migrations.ts:592-593, 600`) — whitespace differences could leak through. | Medium |
| Override generated method without clobber | `make:model` overwrites `app/Models/<Name>.ts` if it exists — `core/actions/src/make.ts:391-409` calls `createFileWithTemplate` with no `force`/`exists` check. | High |
| "This file is generated" header | Migration SQL has no header; OpenAPI JSON has no header. | Low |
| CI verifies generated files | No git-clean check anywhere. | Medium |
| Make:model template is anemic | `templates.ts:139-159` emits 20 lines: name/table/PK/autoIncrement/useTimestamps/useSeeder + an empty `attributes: {}`. **No relations stub, no traits.useApi, no fillable example, no validation example.** Compare to `defaults/app/Models/User.ts` (113 lines) — docs example is ~6x richer. | Medium |
| Model loader race | `core/orm/src/index.ts:7` documents a TDZ cycle that required a pre-import of `@stacksjs/validation` to fix; the workaround is brittle. | High |

## Top 5 codegen fixes

1. **Replace the `any`-stub type utilities** at `core/orm/src/index.ts:313-319` with real implementations. `InferFillableAttributes`, `ModelCreateData`, `ModelRowLoose`, `InferColumnNames` are referenced *throughout* the framework but currently are aliases to `any`. Also fix `UserModel = ModelRowLoose<unknown>` and `NewUser = ModelCreateDataLoose<unknown>` (lines 328-331). Until this is done, the entire "fully typed model row" promise is a lie.
2. **Generate per-model `.d.ts` (or `.ts`) row + insert + update types into `storage/framework/orm/src/models/<Name>.d.ts`**, indexed by an auto-built barrel. Today every consumer must hand-write `import type Post from '../models/Post'; type PostRow = ModelRow<typeof Post>`. The `make:model` command should also write a sibling `factory.ts` + `seeder.ts` stub.
3. **De-duplicate the cast registry**. Same `AUTO_CRUD_CASTERS` table at `storage/framework/orm/routes.ts:101-111` and `core/orm/src/index.ts:21-73`. Move to a shared `@stacksjs/orm/casts` module imported by both. Same problem for `toSnakeCase`/`pluralize` (`routes.ts:148-160`) — duplicated of bun-query-builder's helpers.
4. **Make `make:model` non-destructive and feature-complete**. At minimum: refuse to overwrite without `--force`, accept `--with-relations`, `--with-api`, `--with-soft-deletes`, `--fillable=`, and emit relations / traits.useApi / a `fillable: true` example.
5. **Surface model-load errors instead of swallowing them**. `routes.ts:41-43`, `core/orm/src/index.ts:79, 92` all `catch { /* skip */ }`. A broken `app/Models/Foo.ts` causes silent zero-route registration, the Foo CRUD endpoints just don't exist, the developer sees nothing in the dev-server log. Pair with: emit OpenAPI `components.schemas.<Model>` from `model.attributes` so the generated spec actually reflects the data layer.

### Bonus quick wins
- `BelongsToForeignKeys<TDef>` hardcodes `number` (`types.ts:35-38`) — breaks for UUID/string PKs.
- `defineModel`'s attribute schema is `[key: string]: any` (`define-model.ts:751`) — no compile-time check that a typo'd `fillible: true` is invalid.
- `generateMigrations2` (`migrations.ts:672`) — undocumented "fresh" alias never wired to a CLI command.
- `generateSeeder()` at `generate/index.ts:235-237` is an empty function — either remove or implement.

---

# Audit 4 — Migrations & Schema Layer

The migration system has two layers: a vestigial Kysely-style DSL (`Schema.createTable` / `Table` / `Column`) that is essentially dead code, and the real engine — bun-query-builder's `buildMigrationPlan` → `generateSql` → SQL files in `database/migrations/`.

## Schema DSL completeness

| feature | description | evidence | severity |
|---|---|---|---|
| Column types — `text/mediumText/longText/char/varchar(n)`, `tinyInt/smallInt/mediumInt/bigInt`, `unsigned`, `binary/blob`, `uuid` (native), `ulid`, `year`, `time`, `set`, `geometry/point/polygon`, `ipAddress`, `macAddress`, `jsonb` (Postgres-specific) | `NormalizedColumnType` is a closed union of 12 types only. `string` is always `varchar(255)`, `decimal` is always `decimal(10,2)`, `text` width is fixed, `boolean` on MySQL is `tinyint(1)` (no native bool) | `bun-query-builder/src/migrations.ts:88-101`; `drivers/postgres.ts:26-46`; `drivers/mysql.ts:26-47` | high |
| Column modifiers — `nullable()`, `default()`, `unsigned`, `comment`, `after`, `first`, `change/modify`, `useCurrent`, `useCurrentOnUpdate`, `generatedAs`, `virtualAs`, `storedAs`, `charset`, `collation` | `ColumnPlan` only carries `isNullable | isUnique | isPrimaryKey | hasDefault | defaultValue | references | enumValues`. No positional control, no comment, no generated columns, no per-column collation, no `ON UPDATE CURRENT_TIMESTAMP` (MySQL `updated_at` won't auto-update) | `bun-query-builder/src/migrations.ts:102-112`; `drivers/mysql.ts:60-85` | high |
| **Default nullability inverted vs Laravel/Knex** | Every non-PK attribute gets `isNullable = true` hardcoded — validation rule's required/min checks never consulted. Confirmed in production: `payments.amount`, `payments.method`, `print_devices.name`, even FK columns like `payments.order_id` emitted as nullable | `bun-query-builder/src/migrations.ts:341` (`const isNullable = true`); `database/migrations/0000000004-create-payments-table.sql` | **critical** |
| Numeric precision is hardcoded | All `decimal` becomes `decimal(10,2)`. No way to spec money as `decimal(19,4)`. `string` is always 255 chars even when validation says `max(64)` | `drivers/postgres.ts:35`; `drivers/mysql.ts:35`; `migrations.ts:228-234` | high |
| Boolean storage on SQLite | Booleans become `INTEGER` with no `CHECK (col IN (0,1))` and no marker | `drivers/sqlite.ts:36` | medium |
| FK columns auto-coerced to INTEGER on SQLite | Any column ending `_id` becomes `INTEGER`, period — overrides explicit user type. Comment calls this a "safety net" but silently breaks UUID/ULID FKs | `drivers/sqlite.ts:28-31` | high |
| Index types — `fulltext`, `spatial`, `gin/gist/spgist/brin/hash`, expression-based (`lower(email)`), descending column order | `IndexPlan.type` is `'index' | 'unique'`. No way to spec method, order, or expression columns. Partial-index `where` clause supported on Postgres + SQLite, throws on MySQL | `bun-query-builder/src/migrations.ts:114-124`; `drivers/mysql.ts:97-101` | high |
| Primary keys — composite, non-`id` named PK | `primaryKey` is single-column field; `autoIncrement` honored but composite PK + UUID PK unrepresentable. Generated PK is always `bigint`/`SERIAL`/`BIGSERIAL` | `bun-query-builder/src/migrations.ts:312-332`; `drivers/postgres.ts:48-54` | high |
| Foreign keys — named constraints, deferred, composite | FK name is hardcoded `${tableName}_${columnName}_fk`; no override. No `INITIALLY DEFERRED`. Composite FKs unrepresentable. | `drivers/postgres.ts:106-114`; `drivers/mysql.ts:110-118` | medium |
| Drop/rename column / index / FK / table | `dropTable`, `dropColumn`, `dropIndex`, `dropEnumType` exist. **No** `renameTable`, `renameColumn`, `renameIndex`, or `dropForeignKey` operation in any driver. `safe-migrations.ts:189` adds `renameColumnSafely` but never participates in auto-diff and stacks-side `Schema` has no rename | `drivers/*.ts`; `safe-migrations.ts:189-208` | high |
| Table options — `temporary`, `engine=InnoDB`, `charset`, `collation`, `comment`, `IF NOT EXISTS` toggle | All `CREATE TABLE` is `IF NOT EXISTS`, no engine/charset/collation/comment hooks. | `drivers/postgres.ts:93-96`; `drivers/mysql.ts:92-95` | medium |
| **Vestigial DSL is broken** | `storage/.../database/src/schema.ts` has `Schema.createTable` callback API, but `Table` only exposes `increments`, `string(name, varchar=255)`, `timestamps()` and `Column` only has `notNullable/defaultTo/primary/autoIncrement`. **`Table.execute()` literally just `log.info`s and runs no SQL.** Looks like an API surface a user could call expecting Laravel parity and silently get nothing | `database/src/schema.ts:1-15`; `table.ts:1-32`; `column.ts:1-37` | **critical** |
| Generated `modifyColumn` on SQLite is a no-op | Returns a `-- comment` instead of valid SQL. If diff produces a column-modify on SQLite, migration runs to "completion" but schema is unchanged | `drivers/sqlite.ts:136-140` | high |
| Postgres `modifyColumn` cannot change nullability or default | Driver only emits `ALTER COLUMN ... TYPE`, never `SET/DROP NOT NULL` or `SET/DROP DEFAULT`. Toggling `nullable: false` produces SQL that passes but doesn't enforce | `drivers/postgres.ts:132-137` | high |

## Migration runner

| feature | description | evidence | severity |
|---|---|---|---|
| **`down()` / rollback** | No `down()` migrations exist. `migrateRollback` only `DELETE`s rows from the `migrations` table and unlinks the `.sql` file — schema is unchanged. The function's own log says "Rollback only removes migration records." | `bun-query-builder/src/actions/migrate-rollback.ts:42-110` | **critical** |
| **Concurrent migration locking (multi-instance deploys)** | None. `executeMigration` reads the `migrations` table, picks pending files, runs them. No `pg_advisory_lock`, no `GET_LOCK`, no `BEGIN EXCLUSIVE`. Two app instances starting simultaneously will both try to apply the same migration. Advisory-lock primitives exist on the client (`client.ts:5389`) but the runner never uses them | `actions/migrate.ts:196-291` | **critical** |
| **Per-migration transaction wrapping** | Each `.sql` file is fed to `qb.file(filePath)` with no surrounding `BEGIN`/`COMMIT`. A multi-statement file that fails mid-way leaves the database half-migrated, and the runner re-throws — no automatic rollback | `actions/migrate.ts:253-256` | **critical** |
| Migration ordering | Lexical sort of filenames. Framework migrations use `String(counter).padStart(10, '0')` — collides with itself (counter resets each run), and every regen shuffles the same `00000001-`/`00000002-` prefixes onto different content. User-diff migrations use `Math.floor(Date.now()/1000) + counter` (seconds, not millis) — two diffs in the same second get the same prefix | `bun-query-builder/src/migrations.ts:62-83` | high |
| Idempotency / re-run safety | `executeMigration` tracks executed filenames in the `migrations` table BUT classifies anything with `alter-` and `-table` as "transient" — never recorded, deleted after run. So a flaky `ALTER` retried after partial failure re-runs against already-modified table and errors. The duplicate-CREATE-TABLE preprocessor (stacks-side) only runs on SQLite | `actions/migrate.ts:228-281`; `database/src/migrations.ts:101-293` | critical |
| Pending migrations report | `migrateStatus` exists and works (compares `migrations` table vs `.sql` files), classifying `executed | pending | transient`. Decent | `actions/migrate-status.ts:41-140` | low |
| Schema dump / `schema:dump` / squash | None. No `schema:dump` action, no consolidation. Stacks already has 98 sequentially-named files; new install replays all of them | "no grep hits" | high |
| Per-environment migrations | None. No `--env` switch, no env-scoped paths | "no grep hits" | medium |
| Migration generator can drop a user's data without preview | `generateMigration` writes `DROP TABLE`/`DROP COLUMN` to a file the moment it sees a removed model attribute, with no `--pretend`/`--dry-run`/confirmation | `actions/migrate.ts:163-187` | high |
| Preprocessor mutates committed files | `preprocessSqliteMigrations` (stacks) deletes `.sql` files from disk (`unlinkSync`) and writes new ones during a normal `migrate` run, then inserts skip-rows into the `migrations` table. Migration state committed to git, so a fresh-clone dev deletes files mid-CI | `database/src/migrations.ts:101-293` | high |
| `INSERT INTO migrations` SQL hardcodes `$1` placeholder for Postgres but `?` for MySQL/SQLite, while rollback path issues `DELETE ... WHERE migration = $1` for all dialects | MySQL/SQLite rollback throws on the placeholder; that path is reached every time the user calls `migrate:rollback` on those engines | `drivers/mysql.ts:184` (`?`); `actions/migrate-rollback.ts:86` (`$1`) | high |
| Seed integration | `seed.ts` calls reset → generate → execute → seed in sequence; no per-seeder transaction | `actions/seed.ts:240-254` | low |

## Multi-DB parity

| feature | description | evidence | severity |
|---|---|---|---|
| Type translation matrix | `string`, `text`, `boolean`, `integer`, `bigint`, `float`, `double`, `decimal`, `date`, `datetime`, `json`, `enum`. Drift: Postgres `json` → `jsonb` (correct), MySQL `json` → `json`, SQLite `json` → `TEXT` (no JSON1 functions hooked). MySQL `boolean` → `tinyint(1)`, no `BOOLEAN` alias. Postgres `float` → `real`, MySQL `float` → `real` (vendor-specific double meaning) | `drivers/{postgres,mysql,sqlite}.ts:26-46` | medium |
| Engine-specific feature gating | Partial: MySQL throws on `where`-clause indexes (correct); SQLite preprocessor strips `ALTER TABLE ADD CONSTRAINT` (correct). But `DROP COLUMN` on indexed/PK columns on SQLite is silently emitted then errors at run time. Postgres-only `jsonb` operators / array types unrepresentable | `drivers/sqlite.ts:147-153`; `mysql.ts:97-101` | medium |
| `CREATE INDEX` MySQL has no `IF NOT EXISTS` | Re-running migrations after partial failure errors on duplicate index name | `drivers/mysql.ts:106-107` | medium |
| DynamoDB | Has its own driver/migration path (`drivers/dynamodb.ts` in qb), separate single-table API in stacks `dynamodb-tooling-adapter.ts`. Out of scope for SQL migrations but worth flagging that schema layer doesn't unify them | `bun-query-builder/src/drivers/dynamodb.ts` | low |
| `ensureDatabaseExists` only runs the very first time | After CREATE DATABASE on Postgres/MySQL the helper resets the connection but error 42P04 on Postgres uses `errno` instead of `code` (Postgres uses `code` for SQLSTATE); the `e.errno === '42P04'` branch never fires | `database/src/migrations.ts:340` | low |

## Generation from models / diff preview

| feature | description | evidence | severity |
|---|---|---|---|
| Auto-migrate from model diffs | Implemented end-to-end | `actions/migrate.ts:112-194`; `migrations.ts:879-1106` | n/a |
| Diff preview before apply | None — no `--dry-run` shows the SQL without writing a file. `opts.apply` writes a temp file but always writes the migration files via `createMigrationFile()` regardless | `migrations.ts:62-84`; `actions/migrate.ts:169-187` | high |
| Snapshot drift / corruption recovery | If `.qb/model-snapshot.<dialect>.json` is deleted/diverged from production, next `generateMigration` emits a full CREATE for already-existing tables. `generateSql` always uses `CREATE TABLE IF NOT EXISTS` so it no-ops, but the migrations-table tracking still records the file | `actions/migrate.ts:25-78` | medium |
| Column modify detection | `columnsAreDifferent` compares type/nullability/default/unique — does NOT compare `references`, `isPrimaryKey`, `enumValues` for non-enum→enum transitions. Switching FK target table emits no migration | `migrations.ts:834-856` | high |
| FK constraints on existing-table column adds always added even if column was modified | Diff emits `addColumn` then `addForeignKey` for new columns but never `dropForeignKey` for columns whose `references` changed | `migrations.ts:1052-1066` | high |

## Top 5 migration/schema fixes

1. **Add real rollback semantics.** Either generate matching `down.sql` files alongside each `up.sql` (or store the inverse plan in the snapshot) and have `migrateRollback` execute them. (`actions/migrate-rollback.ts:42-110`)
2. **Wrap each migration file in a transaction and take an advisory lock.** The advisory-lock primitive already exists at `client.ts:5389`. Wire it into `executeMigration` (`actions/migrate.ts:196-291`), wrap the `qb.file(filePath)` call in `BEGIN`/`COMMIT` per file, and fall back to per-statement on engines that disallow transactional DDL.
3. **Fix the broken nullability default + the SQLite FK coercion.** `isNullable = true` (`migrations.ts:341`) needs to read the validation rule. Pair with removing the unconditional `_id → INTEGER` override at `drivers/sqlite.ts:28-31`.
4. **Fix the rollback placeholder mismatch and the broken Postgres modifyColumn.** `actions/migrate-rollback.ts:86` uses `$1` for all dialects — MySQL/SQLite rollback throws. `drivers/postgres.ts:132-137` only emits `ALTER COLUMN ... TYPE`, ignoring nullability/default toggles. `drivers/sqlite.ts:136-140` returns a `-- comment` so column-modifies on SQLite are silently dropped.
5. **Either delete or properly implement `Schema.createTable` / `Table` / `Column`.** `database/src/schema.ts:1-15` exposes a Laravel-shaped DSL whose `execute()` is `log.info(...)` and supports two column types. Either route it through `bun-query-builder` or remove it from `index.ts`. While at it, expose `renameColumn`/`renameTable` and `dropForeignKey` in the dialect drivers — they're missing from every driver and `safe-migrations.ts:189`'s rename helper is unreachable from the model-driven generator.

---

# Key files referenced

**Query builder:**
- `bun-query-builder/packages/bun-query-builder/src/orm.ts` (`ModelQueryBuilder` class, 1296–2050; eager loader 1658–1804)
- `bun-query-builder/packages/bun-query-builder/src/client.ts` (full QB surface — what to mirror)
- `bun-query-builder/packages/bun-query-builder/src/pivot.ts` (pivot resolver)
- `stacks/storage/framework/core/orm/src/builder.ts` (Stacks-side type declarations)
- `stacks/storage/framework/core/orm/src/define-model.ts`

**ORM/Models:**
- `stacks/storage/framework/core/orm/src/define-model.ts`
- `stacks/storage/framework/core/orm/src/utils.ts`
- `stacks/storage/framework/core/orm/src/traits/soft-deletes.ts`
- `stacks/storage/framework/core/orm/src/transaction.ts`
- `stacks/storage/framework/core/database/src/seeder.ts`
- `stacks/storage/framework/core/types/src/model.ts`
- `stacks/storage/framework/defaults/app/Models/User.ts`

**Migrations:**
- `bun-query-builder/packages/bun-query-builder/src/migrations.ts`
- `bun-query-builder/packages/bun-query-builder/src/actions/migrate.ts`
- `bun-query-builder/packages/bun-query-builder/src/actions/migrate-rollback.ts`
- `bun-query-builder/packages/bun-query-builder/src/actions/migrate-status.ts`
- `bun-query-builder/packages/bun-query-builder/src/drivers/{postgres,mysql,sqlite}.ts`
- `stacks/storage/framework/core/database/src/migrations.ts`
- `stacks/storage/framework/core/database/src/schema.ts` (vestigial DSL)
- `stacks/storage/framework/core/database/src/safe-migrations.ts`

**Codegen:**
- `stacks/storage/framework/core/orm/src/index.ts:21-73` (cast registry, type stubs)
- `stacks/storage/framework/orm/routes.ts:101-111` (duplicated cast registry)
- `stacks/storage/framework/orm/src/index.ts` (15-line re-export)
- `stacks/storage/framework/core/actions/src/templates.ts:139-159` (anemic make:model template)
- `stacks/storage/framework/core/actions/src/make.ts:391-409` (overwrites silently)
- `stacks/storage/framework/core/actions/src/generate/index.ts:235` (empty `generateSeeder`)
