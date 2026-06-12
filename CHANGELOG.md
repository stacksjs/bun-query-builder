[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.37...v0.1.38)

## 🚀 Features

- **migrations**: self-heal by diffing against the live database schema ([f71da25](https://github.com/stacksjs/bun-query-builder/commit/f71da25)) _(by Chris <chrisbreuer93@gmail.com>)_
- **migrations**: data-preserving renames, SQLite table rebuild, structured ops ([75495ea](https://github.com/stacksjs/bun-query-builder/commit/75495ea)) _(by Chris <chrisbreuer93@gmail.com>)_

## 🧪 Tests

- **migrations**: cover renames, SQLite rebuild, self-heal, and no-churn ([77a0a66](https://github.com/stacksjs/bun-query-builder/commit/77a0a66)) _(by Chris <chrisbreuer93@gmail.com>)_

## 🧹 Chores

- release v0.1.38 ([43b4b65](https://github.com/stacksjs/bun-query-builder/commit/43b4b65)) _(by Chris <chrisbreuer93@gmail.com>)_
- **deps**: refresh bun.lock to pick up pickier 0.1.35 ([39240f1](https://github.com/stacksjs/bun-query-builder/commit/39240f1)) _(by glennmichael123 <gtorregosa@gmail.com>)_

## Contributors

- _Chris <chrisbreuer93@gmail.com>_
- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.36...v0.1.37)

## 🚀 Features

- **orm**: hasManyThrough / hasOneThrough eager loading on the model layer ([b9efdbf](https://github.com/stacksjs/bun-query-builder/commit/b9efdbf)) _(by Chris <chrisbreuer93@gmail.com>)_

## 🧹 Chores

- release v0.1.37 ([e28b266](https://github.com/stacksjs/bun-query-builder/commit/e28b266)) _(by Chris <chrisbreuer93@gmail.com>)_

## Contributors

- _Chris <chrisbreuer93@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.35...v0.1.36)

## 🐛 Bug Fixes

- **client**: toParams() returned garbage instead of the bound params ([b48721f](https://github.com/stacksjs/bun-query-builder/commit/b48721f)) _(by Chris <chrisbreuer93@gmail.com>)_
- selectFromSub() produced [object Promise] SQL and dropped subquery params ([a8bb7dc](https://github.com/stacksjs/bun-query-builder/commit/a8bb7dc)) _(by Chris <chrisbreuer93@gmail.com>)_

## 🧹 Chores

- release v0.1.36 ([91298a5](https://github.com/stacksjs/bun-query-builder/commit/91298a5)) _(by Chris <chrisbreuer93@gmail.com>)_

## Contributors

- _Chris <chrisbreuer93@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.34...v0.1.35)

## 🐛 Bug Fixes

- transactions were completely broken on sqlite; honor builder connection; support nesting ([a40e961](https://github.com/stacksjs/bun-query-builder/commit/a40e961)) _(by Chris <chrisbreuer93@gmail.com>)_

## 🧹 Chores

- release v0.1.35 ([939a93c](https://github.com/stacksjs/bun-query-builder/commit/939a93c)) _(by Chris <chrisbreuer93@gmail.com>)_

## Contributors

- _Chris <chrisbreuer93@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.33...v0.1.34)

## 🐛 Bug Fixes

- **config**: getConfig() now applies the loaded config file + env to the live singleton ([292fe37](https://github.com/stacksjs/bun-query-builder/commit/292fe37)) _(by Chris <chrisbreuer93@gmail.com>)_

## 🧹 Chores

- release v0.1.34 ([a9bf77b](https://github.com/stacksjs/bun-query-builder/commit/a9bf77b)) _(by Chris <chrisbreuer93@gmail.com>)_

## Contributors

- _Chris <chrisbreuer93@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.32...v0.1.33)

## 🐛 Bug Fixes

- chained where double-WHERE, chunk() infinite loop, cursorPaginate() row-skip ([4c20d43](https://github.com/stacksjs/bun-query-builder/commit/4c20d43)) _(by Chris <chrisbreuer93@gmail.com>)_

## 🧹 Chores

- release v0.1.33 ([1ae0325](https://github.com/stacksjs/bun-query-builder/commit/1ae0325)) _(by Chris <chrisbreuer93@gmail.com>)_

## Contributors

- _Chris <chrisbreuer93@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.31...v0.1.32)

## 🐛 Bug Fixes

- *Raw fragments broken on real drivers, returning() missing row methods, distinct().select() drops DISTINCT ([01f8d9a](https://github.com/stacksjs/bun-query-builder/commit/01f8d9a)) _(by Chris <chrisbreuer93@gmail.com>)_

## 🧹 Chores

- release v0.1.32 ([c7e680e](https://github.com/stacksjs/bun-query-builder/commit/c7e680e)) _(by Chris <chrisbreuer93@gmail.com>)_

## Contributors

- _Chris <chrisbreuer93@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.30...v0.1.31)

## 🐛 Bug Fixes

- .with() eager loading broken on real drivers; implement constraint callbacks; perf hoists ([58f2bbb](https://github.com/stacksjs/bun-query-builder/commit/58f2bbb)) _(by Chris <chrisbreuer93@gmail.com>)_

## 🧹 Chores

- release v0.1.31 ([69328f4](https://github.com/stacksjs/bun-query-builder/commit/69328f4)) _(by Chris <chrisbreuer93@gmail.com>)_

## Contributors

- _Chris <chrisbreuer93@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.29...v0.1.30)

## ⚡ Performance Improvements

- 4.7x faster query building; fix dynamic whereX on real DBs + whereHas callback escaping ([ee54eea](https://github.com/stacksjs/bun-query-builder/commit/ee54eea)) _(by Chris <chrisbreuer93@gmail.com>)_

## 🧹 Chores

- release v0.1.30 ([0ed8333](https://github.com/stacksjs/bun-query-builder/commit/0ed8333)) _(by Chris <chrisbreuer93@gmail.com>)_

## Contributors

- _Chris <chrisbreuer93@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.28...v0.1.29)

## 🐛 Bug Fixes

- result-shape typing for pluck/value/select/min/max & friends; MAX(text) no longer NaN ([b9c94cb](https://github.com/stacksjs/bun-query-builder/commit/b9c94cb)) _(by Chris <chrisbreuer93@gmail.com>)_

## 🧹 Chores

- release v0.1.29 ([90ef3e1](https://github.com/stacksjs/bun-query-builder/commit/90ef3e1)) _(by Chris <chrisbreuer93@gmail.com>)_

## Contributors

- _Chris <chrisbreuer93@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.27...v0.1.28)

## 🐛 Bug Fixes

- persist fill()/update() changes, param-aware cache keys, pk-aware types; add extensive type-usage suite ([d7c3a16](https://github.com/stacksjs/bun-query-builder/commit/d7c3a16)) _(by Chris <chrisbreuer93@gmail.com>)_

## 🧹 Chores

- release v0.1.28 ([5b7f2c9](https://github.com/stacksjs/bun-query-builder/commit/5b7f2c9)) _(by Chris <chrisbreuer93@gmail.com>)_

## Contributors

- _Chris <chrisbreuer93@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.26...v0.1.27)

## 🚀 Features

- narrow relation typing end-to-end, harden SQL boundaries, true LRU cache ([3827868](https://github.com/stacksjs/bun-query-builder/commit/3827868)) _(by Chris <chrisbreuer93@gmail.com>)_

## 🐛 Bug Fixes

- **db**: prefer DB_* env in createConnectionString ([4b92f81](https://github.com/stacksjs/bun-query-builder/commit/4b92f81)) _(by glennmichael123 <gtorregosa@gmail.com>)_

## 🧹 Chores

- release v0.1.27 ([a158c8e](https://github.com/stacksjs/bun-query-builder/commit/a158c8e)) _(by Chris <chrisbreuer93@gmail.com>)_
- **deps**: refresh bun.lock to pick up pickier 0.1.33 ([b9cde8c](https://github.com/stacksjs/bun-query-builder/commit/b9cde8c)) _(by glennmichael123 <gtorregosa@gmail.com>)_

## Contributors

- _Chris <chrisbreuer93@gmail.com>_
- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.25...v0.1.26)

## 🚀 Features

- **client**: snapshot-consistent paginate({ tx }) (#1051) ([d836ca1](https://github.com/stacksjs/bun-query-builder/commit/d836ca1)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1051](https://github.com/stacksjs/bun-query-builder/issues/1051), [#1051](https://github.com/stacksjs/bun-query-builder/issues/1051))
- **client**: generalized window functions (#1050) ([0974c06](https://github.com/stacksjs/bun-query-builder/commit/0974c06)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1050](https://github.com/stacksjs/bun-query-builder/issues/1050), [#1050](https://github.com/stacksjs/bun-query-builder/issues/1050))
- **client**: INTERSECT / EXCEPT set operators (#1049) ([6a8b4f4](https://github.com/stacksjs/bun-query-builder/commit/6a8b4f4)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1049](https://github.com/stacksjs/bun-query-builder/issues/1049), [#1049](https://github.com/stacksjs/bun-query-builder/issues/1049))
- **migrate**: reversible rollback — derive and run down DDL (#1048) ([edb2f6c](https://github.com/stacksjs/bun-query-builder/commit/edb2f6c)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1048](https://github.com/stacksjs/bun-query-builder/issues/1048), [#1048](https://github.com/stacksjs/bun-query-builder/issues/1048))
- **introspect**: reverse-introspect a live DB into defineModel() source (#1047) ([70ea4ff](https://github.com/stacksjs/bun-query-builder/commit/70ea4ff)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1047](https://github.com/stacksjs/bun-query-builder/issues/1047), [#1047](https://github.com/stacksjs/bun-query-builder/issues/1047))
- **client**: withSum/withAvg/withMax/withMin relation aggregates (#1046) ([0d6b1f5](https://github.com/stacksjs/bun-query-builder/commit/0d6b1f5)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1046](https://github.com/stacksjs/bun-query-builder/issues/1046), [#1046](https://github.com/stacksjs/bun-query-builder/issues/1046))
- **hooks**: slow-query threshold/onSlowQuery + populate params on hook events (#1045) ([71d0d9e](https://github.com/stacksjs/bun-query-builder/commit/71d0d9e)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1045](https://github.com/stacksjs/bun-query-builder/issues/1045), [#1045](https://github.com/stacksjs/bun-query-builder/issues/1045))
- **config**: expose connection-pool tuning via DatabaseConfig.pool (#1014) ([d91259a](https://github.com/stacksjs/bun-query-builder/commit/d91259a)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1014](https://github.com/stacksjs/bun-query-builder/issues/1014), [#1014](https://github.com/stacksjs/bun-query-builder/issues/1014))

## 🐛 Bug Fixes

- **client**: rebuild upsert/insertOrIgnore/insertGetId/updateOrInsert with explicit SQL (#1052) ([2d33f86](https://github.com/stacksjs/bun-query-builder/commit/2d33f86)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1052](https://github.com/stacksjs/bun-query-builder/issues/1052), [#1052](https://github.com/stacksjs/bun-query-builder/issues/1052))
- **config**: store config on a globalThis singleton to harden against bundler splits (#1043) ([014a86d](https://github.com/stacksjs/bun-query-builder/commit/014a86d)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1043](https://github.com/stacksjs/bun-query-builder/issues/1043), [#1043](https://github.com/stacksjs/bun-query-builder/issues/1043))
- **db**: connection cache keys on full connection signature (#1041) ([c5d4457](https://github.com/stacksjs/bun-query-builder/commit/c5d4457)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1041](https://github.com/stacksjs/bun-query-builder/issues/1041), [#1041](https://github.com/stacksjs/bun-query-builder/issues/1041))
- **db**: stop installing a process-wide unhandledRejection handler (#1040) ([83854a3](https://github.com/stacksjs/bun-query-builder/commit/83854a3)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1040](https://github.com/stacksjs/bun-query-builder/issues/1040), [#1040](https://github.com/stacksjs/bun-query-builder/issues/1040))
- **migrations**: diff detects foreign-key reference changes (#1037) ([04e2629](https://github.com/stacksjs/bun-query-builder/commit/04e2629)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1037](https://github.com/stacksjs/bun-query-builder/issues/1037), [#1037](https://github.com/stacksjs/bun-query-builder/issues/1037))
- **orm**: belongsToMany SELECT aliases related columns to avoid pivot collision (#1036) ([44daffd](https://github.com/stacksjs/bun-query-builder/commit/44daffd)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1036](https://github.com/stacksjs/bun-query-builder/issues/1036), [#1036](https://github.com/stacksjs/bun-query-builder/issues/1036))
- upsert no-mergeColumns -> DO NOTHING/INSERT IGNORE; make lazy bunSql callable (#1035) ([a4e1011](https://github.com/stacksjs/bun-query-builder/commit/a4e1011)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1035](https://github.com/stacksjs/bun-query-builder/issues/1035), [#1035](https://github.com/stacksjs/bun-query-builder/issues/1035))
- **client**: chained having() joins with AND, not a second HAVING (#1034) ([b21dd32](https://github.com/stacksjs/bun-query-builder/commit/b21dd32)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1034](https://github.com/stacksjs/bun-query-builder/issues/1034), [#1034](https://github.com/stacksjs/bun-query-builder/issues/1034))
- **client**: quote identifiers on single-row INSERT + createMany (#1033) ([41d569e](https://github.com/stacksjs/bun-query-builder/commit/41d569e)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1033](https://github.com/stacksjs/bun-query-builder/issues/1033), [#1033](https://github.com/stacksjs/bun-query-builder/issues/1033))
- **orm**: honor timestampable/softDeletable trait aliases at runtime (#1031) ([f3250ab](https://github.com/stacksjs/bun-query-builder/commit/f3250ab)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1031](https://github.com/stacksjs/bun-query-builder/issues/1031), [#1031](https://github.com/stacksjs/bun-query-builder/issues/1031))
- **client**: splice JOINs before WHERE/trailing clauses + invalidate built (#1030) ([060f58c](https://github.com/stacksjs/bun-query-builder/commit/060f58c)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1030](https://github.com/stacksjs/bun-query-builder/issues/1030), [#1030](https://github.com/stacksjs/bun-query-builder/issues/1030))
- **client**: union/unionAll merge the other side's params + renumber placeholders (#1029) ([bf77dce](https://github.com/stacksjs/bun-query-builder/commit/bf77dce)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1029](https://github.com/stacksjs/bun-query-builder/issues/1029), [#1029](https://github.com/stacksjs/bun-query-builder/issues/1029))
- **client**: LIKE/ILIKE family pushes its pattern + dialect-aware placeholder (#1028) ([256a074](https://github.com/stacksjs/bun-query-builder/commit/256a074)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1028](https://github.com/stacksjs/bun-query-builder/issues/1028), [#1028](https://github.com/stacksjs/bun-query-builder/issues/1028))
- **client**: whereBetween/whereNotBetween use dialect-aware placeholders (#1027) ([fd52e92](https://github.com/stacksjs/bun-query-builder/commit/fd52e92)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1027](https://github.com/stacksjs/bun-query-builder/issues/1027), [#1027](https://github.com/stacksjs/bun-query-builder/issues/1027))
- **client**: make whereJsonContains dialect-aware + honor jsonContainsMode (#1026) ([ad05ba7](https://github.com/stacksjs/bun-query-builder/commit/ad05ba7)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1026](https://github.com/stacksjs/bun-query-builder/issues/1026), [#1026](https://github.com/stacksjs/bun-query-builder/issues/1026))
- **orm**: create()/save() persists explicitly-set non-fillable columns (#1025) ([955ef72](https://github.com/stacksjs/bun-query-builder/commit/955ef72)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1025](https://github.com/stacksjs/bun-query-builder/issues/1025), [#1025](https://github.com/stacksjs/bun-query-builder/issues/1025))
- **orm**: soft deletes now filter reads + add withTrashed/onlyTrashed/restore (#1024) ([d016b46](https://github.com/stacksjs/bun-query-builder/commit/d016b46)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1024](https://github.com/stacksjs/bun-query-builder/issues/1024), [#1024](https://github.com/stacksjs/bun-query-builder/issues/1024))
- **client**: unwrap SQL fragments in select()/addSelect() instead of [object Object] (#1016) ([b9e2e69](https://github.com/stacksjs/bun-query-builder/commit/b9e2e69)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1016](https://github.com/stacksjs/bun-query-builder/issues/1016), [#1016](https://github.com/stacksjs/bun-query-builder/issues/1016))
- **migrations**: accept object-form belongsTo/hasMany/hasOne in the generator (#1023) ([0b455b2](https://github.com/stacksjs/bun-query-builder/commit/0b455b2)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1023](https://github.com/stacksjs/bun-query-builder/issues/1023), [#1023](https://github.com/stacksjs/bun-query-builder/issues/1023))

## ♻️ Code Refactoring

- type the driver boundary with DriverConnection/DriverQuery (#1044) ([8efb4ba](https://github.com/stacksjs/bun-query-builder/commit/8efb4ba)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1044](https://github.com/stacksjs/bun-query-builder/issues/1044), [#1044](https://github.com/stacksjs/bun-query-builder/issues/1044))
- dedupe relation normalization into src/relation-utils (#1042) ([4051a01](https://github.com/stacksjs/bun-query-builder/commit/4051a01)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1042](https://github.com/stacksjs/bun-query-builder/issues/1042), [#1042](https://github.com/stacksjs/bun-query-builder/issues/1042))
- **db**: remove dead sql.catch handler in getBunSql (#1039) ([4bbb15a](https://github.com/stacksjs/bun-query-builder/commit/4bbb15a)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1039](https://github.com/stacksjs/bun-query-builder/issues/1039), [#1039](https://github.com/stacksjs/bun-query-builder/issues/1039))

## 🧪 Tests

- add live-Postgres execution integration coverage (#1038) ([89e9bc6](https://github.com/stacksjs/bun-query-builder/commit/89e9bc6)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1038](https://github.com/stacksjs/bun-query-builder/issues/1038), [#1038](https://github.com/stacksjs/bun-query-builder/issues/1038))
- **orm**: lock in extractChanges Postgres affected-row handling (#1032) ([4f3ae8b](https://github.com/stacksjs/bun-query-builder/commit/4f3ae8b)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1032](https://github.com/stacksjs/bun-query-builder/issues/1032), [#1032](https://github.com/stacksjs/bun-query-builder/issues/1032))

## 🧹 Chores

- release v0.1.26 ([347b840](https://github.com/stacksjs/bun-query-builder/commit/347b840)) _(by glennmichael123 <gtorregosa@gmail.com>)_

## Contributors

- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.24...v0.1.25)

## 💥 Breaking Changes

- fix!: route ORM model API through configured dialect (#1021) ([ceae1e0](https://github.com/stacksjs/bun-query-builder/commit/ceae1e0)) _(by chrisbreuer <chrisbreuer93@gmail.com>)_ ([#1021](https://github.com/stacksjs/bun-query-builder/issues/1021), [#1021](https://github.com/stacksjs/bun-query-builder/issues/1021))

## 🐛 Bug Fixes

- **db**: fail loudly on non-sqlite connection errors instead of silent in-memory fallback (#1022) ([98c871f](https://github.com/stacksjs/bun-query-builder/commit/98c871f)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1022](https://github.com/stacksjs/bun-query-builder/issues/1022), [#1022](https://github.com/stacksjs/bun-query-builder/issues/1022))
- **orm**: correct async return types after dialect migration ([fdd4701](https://github.com/stacksjs/bun-query-builder/commit/fdd4701)) _(by chrisbreuer <chrisbreuer93@gmail.com>)_

## 🧹 Chores

- release v0.1.25 ([89ffe57](https://github.com/stacksjs/bun-query-builder/commit/89ffe57)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([18a7801](https://github.com/stacksjs/bun-query-builder/commit/18a7801)) _(by glennmichael123 <gtorregosa@gmail.com>)_

## Contributors

- _chrisbreuer <chrisbreuer93@gmail.com>_
- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.23...v0.1.24)

## 🐛 Bug Fixes

- **schema**: emit inline FOREIGN KEY on SQLite CREATE TABLE (#1019) (#1020) ([e90f3bf](https://github.com/stacksjs/bun-query-builder/commit/e90f3bf)) _(by Glenn Michael Torregosa <gtorregosa@gmail.com>)_ ([#1019](https://github.com/stacksjs/bun-query-builder/issues/1019), [#1020](https://github.com/stacksjs/bun-query-builder/issues/1020), [#1019](https://github.com/stacksjs/bun-query-builder/issues/1019), [#1020](https://github.com/stacksjs/bun-query-builder/issues/1020))
- **client**: SELECT builder reorders clauses to canonical SQL at compile time (#1018) ([d4487d4](https://github.com/stacksjs/bun-query-builder/commit/d4487d4)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1018](https://github.com/stacksjs/bun-query-builder/issues/1018), [#1018](https://github.com/stacksjs/bun-query-builder/issues/1018))
- **db**: SQLite unsafe() is now Promise/A+ thenable — await yields rows (#1017) ([96bea02](https://github.com/stacksjs/bun-query-builder/commit/96bea02)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1017](https://github.com/stacksjs/bun-query-builder/issues/1017), [#1017](https://github.com/stacksjs/bun-query-builder/issues/1017))
- **client**: DELETE builder where() switches WHERE→AND on chained calls (#1015) ([c8ff670](https://github.com/stacksjs/bun-query-builder/commit/c8ff670)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1015](https://github.com/stacksjs/bun-query-builder/issues/1015), [#1015](https://github.com/stacksjs/bun-query-builder/issues/1015))
- **scripts**: stop double-generating CHANGELOG on release ([924e072](https://github.com/stacksjs/bun-query-builder/commit/924e072)) _(by Glenn Michael Torregosa <gtorregosa@gmail.com>)_
- **client**: where('col', 'in', vals) emits IN (?, ?, ?) at parity with array form (#1013) ([c359b55](https://github.com/stacksjs/bun-query-builder/commit/c359b55)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1013](https://github.com/stacksjs/bun-query-builder/issues/1013), [#1013](https://github.com/stacksjs/bun-query-builder/issues/1013))
- **client**: accept bare string in select() at parity with array form (#1012) ([77fe29b](https://github.com/stacksjs/bun-query-builder/commit/77fe29b)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1012](https://github.com/stacksjs/bun-query-builder/issues/1012), [#1012](https://github.com/stacksjs/bun-query-builder/issues/1012))
- **migrate**: gate informational stdout chatter on config.verbose ([2bfbbc4](https://github.com/stacksjs/bun-query-builder/commit/2bfbbc4)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- warn on conflicting setConfig dialects, validate paginate args (#1010 #12, #18) ([73afbde](https://github.com/stacksjs/bun-query-builder/commit/73afbde)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1010](https://github.com/stacksjs/bun-query-builder/issues/1010), [#12](https://github.com/stacksjs/bun-query-builder/issues/12), [#18](https://github.com/stacksjs/bun-query-builder/issues/18), [#1010](https://github.com/stacksjs/bun-query-builder/issues/1010), [#12](https://github.com/stacksjs/bun-query-builder/issues/12), [#18](https://github.com/stacksjs/bun-query-builder/issues/18))
- transaction isolation + readOnly dialect dispatch (#1010 #14) ([f285921](https://github.com/stacksjs/bun-query-builder/commit/f285921)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1010](https://github.com/stacksjs/bun-query-builder/issues/1010), [#14](https://github.com/stacksjs/bun-query-builder/issues/14), [#1010](https://github.com/stacksjs/bun-query-builder/issues/1010), [#14](https://github.com/stacksjs/bun-query-builder/issues/14))
- selectFromSub builder throws on unsupported methods instead of silent no-op (#1010 #11) ([a41f924](https://github.com/stacksjs/bun-query-builder/commit/a41f924)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1010](https://github.com/stacksjs/bun-query-builder/issues/1010), [#11](https://github.com/stacksjs/bun-query-builder/issues/11), [#1010](https://github.com/stacksjs/bun-query-builder/issues/1010), [#11](https://github.com/stacksjs/bun-query-builder/issues/11))
- **security**: tighten *Raw type signatures to SqlFragment, warn on bare strings (#1009 Q-3) ([0499b55](https://github.com/stacksjs/bun-query-builder/commit/0499b55)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1009](https://github.com/stacksjs/bun-query-builder/issues/1009), [#1009](https://github.com/stacksjs/bun-query-builder/issues/1009))
- implement MySQL advisoryLock via GET_LOCK; throw on SQLite (#1010 #17) ([c0f40e6](https://github.com/stacksjs/bun-query-builder/commit/c0f40e6)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1010](https://github.com/stacksjs/bun-query-builder/issues/1010), [#17](https://github.com/stacksjs/bun-query-builder/issues/17), [#1010](https://github.com/stacksjs/bun-query-builder/issues/1010), [#17](https://github.com/stacksjs/bun-query-builder/issues/17))
- **security**: validate whereJsonPath/withCTE/joinSub identifiers (#1009 Q-5, Q-20) ([592d5ce](https://github.com/stacksjs/bun-query-builder/commit/592d5ce)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1009](https://github.com/stacksjs/bun-query-builder/issues/1009), [#1009](https://github.com/stacksjs/bun-query-builder/issues/1009))
- pluck(column, key) throws on duplicate key instead of silent data loss (#1010 #30) ([001acb0](https://github.com/stacksjs/bun-query-builder/commit/001acb0)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1010](https://github.com/stacksjs/bun-query-builder/issues/1010), [#30](https://github.com/stacksjs/bun-query-builder/issues/30), [#1010](https://github.com/stacksjs/bun-query-builder/issues/1010), [#30](https://github.com/stacksjs/bun-query-builder/issues/30))
- **release**: publish query builder from package directory ([87b6814](https://github.com/stacksjs/bun-query-builder/commit/87b6814)) _(by Chris <chrisbreuer93@gmail.com>)_

## ⚡ Performance Improvements

- **client**: hoist shared helpers to module scope, fix validateIdentifier reference ([854ecd3](https://github.com/stacksjs/bun-query-builder/commit/854ecd3)) _(by Chris <chrisbreuer93@gmail.com>)_

## ♻️ Code Refactoring

- migrate seeding faker from ts-mocker to @stacksjs/ts-faker ([3328881](https://github.com/stacksjs/bun-query-builder/commit/3328881)) _(by Chris <chrisbreuer93@gmail.com>)_

## 🤖 Continuous Integration

- **buddy-bot**: add daily cleanup cron to workflow ([aabeb06](https://github.com/stacksjs/bun-query-builder/commit/aabeb06)) _(by Glenn Michael Torregosa <gtorregosa@gmail.com>)_

## 🧹 Chores

- release v0.1.24 ([9537cf4](https://github.com/stacksjs/bun-query-builder/commit/9537cf4)) _(by Chris <chrisbreuer93@gmail.com>)_
- **deps**: refresh bun.lock to pick up @stacksjs/logsmith 0.2.3 ([797e4cf](https://github.com/stacksjs/bun-query-builder/commit/797e4cf)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: refresh bun.lock to pick up buddy-bot 0.9.20 ([d2c0f82](https://github.com/stacksjs/bun-query-builder/commit/d2c0f82)) _(by glennmichael123 <gtorregosa@gmail.com>)_

## Contributors

- _Chris <chrisbreuer93@gmail.com>_
- _Glenn Michael Torregosa <gtorregosa@gmail.com>_
- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.22...v0.1.23)

### 🐛 Bug Fixes

- **release**: publish query builder package workspace ([478d1ab](https://github.com/stacksjs/bun-query-builder/commit/478d1ab)) _(by Chris <chrisbreuer93@gmail.com>)_

### 🧹 Chores

- release v0.1.23 ([128a770](https://github.com/stacksjs/bun-query-builder/commit/128a770)) _(by Chris <chrisbreuer93@gmail.com>)_
- **lint**: restore used query builder parameter names ([21cd9cf](https://github.com/stacksjs/bun-query-builder/commit/21cd9cf)) _(by Chris <chrisbreuer93@gmail.com>)_

### Contributors

- _Chris <chrisbreuer93@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.22...HEAD)

### 🐛 Bug Fixes

- **release**: publish query builder package workspace ([478d1ab](https://github.com/stacksjs/bun-query-builder/commit/478d1ab)) _(by Chris <chrisbreuer93@gmail.com>)_

### 🧹 Chores

- **lint**: restore used query builder parameter names ([21cd9cf](https://github.com/stacksjs/bun-query-builder/commit/21cd9cf)) _(by Chris <chrisbreuer93@gmail.com>)_

### Contributors

- _Chris <chrisbreuer93@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.21...v0.1.22)

### 🚀 Features

- **model**: export registerModel for manual registry inserts ([15aa97e](https://github.com/stacksjs/bun-query-builder/commit/15aa97e)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### 🐛 Bug Fixes

- **model**: expose shared model registration ([630547c](https://github.com/stacksjs/bun-query-builder/commit/630547c)) _(by Chris <chrisbreuer93@gmail.com>)_
- **security**: validate column + operator in where() entry points (#1009 Q-6, Q-8) ([ceaaeba](https://github.com/stacksjs/bun-query-builder/commit/ceaaeba)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1009](https://github.com/stacksjs/bun-query-builder/issues/1009), [#1009](https://github.com/stacksjs/bun-query-builder/issues/1009))
- **security**: subquery value escape, operator allow-list, whereColumn + whereDate validation (#1009, #1010) ([2e81638](https://github.com/stacksjs/bun-query-builder/commit/2e81638)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1009](https://github.com/stacksjs/bun-query-builder/issues/1009), [#1010](https://github.com/stacksjs/bun-query-builder/issues/1010), [#1009](https://github.com/stacksjs/bun-query-builder/issues/1009), [#1010](https://github.com/stacksjs/bun-query-builder/issues/1010))
- dialect-aware insertOrIgnore/upsert, count+groupBy subquery, numeric LIMIT/OFFSET, top-level onlyTrashed (#1010) ([c99c040](https://github.com/stacksjs/bun-query-builder/commit/c99c040)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1010](https://github.com/stacksjs/bun-query-builder/issues/1010), [#1010](https://github.com/stacksjs/bun-query-builder/issues/1010))
- **security**: quote SQLite identifiers, validate ORM column args, fix whereNotBetween (#1009, #1010) ([9983c7f](https://github.com/stacksjs/bun-query-builder/commit/9983c7f)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1009](https://github.com/stacksjs/bun-query-builder/issues/1009), [#1010](https://github.com/stacksjs/bun-query-builder/issues/1010), [#1009](https://github.com/stacksjs/bun-query-builder/issues/1009), [#1010](https://github.com/stacksjs/bun-query-builder/issues/1010))
- **config**: stop setConfig writes binding-splitting under Bun's bundler ([0b94936](https://github.com/stacksjs/bun-query-builder/commit/0b94936)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### 🤖 Continuous Integration

- **buddy-bot**: regenerate workflow from current template ([f4ba6f4](https://github.com/stacksjs/bun-query-builder/commit/f4ba6f4)) _(by Glenn Michael Torregosa <gtorregosa@gmail.com>)_

### 🧹 Chores

- release v0.1.22 ([c2e3069](https://github.com/stacksjs/bun-query-builder/commit/c2e3069)) _(by Chris <chrisbreuer93@gmail.com>)_
- **lint**: satisfy query builder pickier checks ([ebbe85c](https://github.com/stacksjs/bun-query-builder/commit/ebbe85c)) _(by Chris <chrisbreuer93@gmail.com>)_
- **deps**: bump @stacksjs/ts-validation to ^0.5.0 ([cd89f24](https://github.com/stacksjs/bun-query-builder/commit/cd89f24)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: bump better-dx to ^0.2.15 ([8faa470](https://github.com/stacksjs/bun-query-builder/commit/8faa470)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### 📄 Miscellaneous

- Create query-builder.md ([dbbc105](https://github.com/stacksjs/bun-query-builder/commit/dbbc105)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### Contributors

- _Chris <chrisbreuer93@gmail.com>_
- _Glenn Michael Torregosa <gtorregosa@gmail.com>_
- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.21...HEAD)

### 🚀 Features

- **model**: export registerModel for manual registry inserts ([15aa97e](https://github.com/stacksjs/bun-query-builder/commit/15aa97e)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### 🐛 Bug Fixes

- **model**: expose shared model registration ([630547c](https://github.com/stacksjs/bun-query-builder/commit/630547c)) _(by Chris <chrisbreuer93@gmail.com>)_
- **security**: validate column + operator in where() entry points (#1009 Q-6, Q-8) ([ceaaeba](https://github.com/stacksjs/bun-query-builder/commit/ceaaeba)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1009](https://github.com/stacksjs/bun-query-builder/issues/1009), [#1009](https://github.com/stacksjs/bun-query-builder/issues/1009))
- **security**: subquery value escape, operator allow-list, whereColumn + whereDate validation (#1009, #1010) ([2e81638](https://github.com/stacksjs/bun-query-builder/commit/2e81638)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1009](https://github.com/stacksjs/bun-query-builder/issues/1009), [#1010](https://github.com/stacksjs/bun-query-builder/issues/1010), [#1009](https://github.com/stacksjs/bun-query-builder/issues/1009), [#1010](https://github.com/stacksjs/bun-query-builder/issues/1010))
- dialect-aware insertOrIgnore/upsert, count+groupBy subquery, numeric LIMIT/OFFSET, top-level onlyTrashed (#1010) ([c99c040](https://github.com/stacksjs/bun-query-builder/commit/c99c040)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1010](https://github.com/stacksjs/bun-query-builder/issues/1010), [#1010](https://github.com/stacksjs/bun-query-builder/issues/1010))
- **security**: quote SQLite identifiers, validate ORM column args, fix whereNotBetween (#1009, #1010) ([9983c7f](https://github.com/stacksjs/bun-query-builder/commit/9983c7f)) _(by glennmichael123 <gtorregosa@gmail.com>)_ ([#1009](https://github.com/stacksjs/bun-query-builder/issues/1009), [#1010](https://github.com/stacksjs/bun-query-builder/issues/1010), [#1009](https://github.com/stacksjs/bun-query-builder/issues/1009), [#1010](https://github.com/stacksjs/bun-query-builder/issues/1010))
- **config**: stop setConfig writes binding-splitting under Bun's bundler ([0b94936](https://github.com/stacksjs/bun-query-builder/commit/0b94936)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### 🤖 Continuous Integration

- **buddy-bot**: regenerate workflow from current template ([f4ba6f4](https://github.com/stacksjs/bun-query-builder/commit/f4ba6f4)) _(by Glenn Michael Torregosa <gtorregosa@gmail.com>)_

### 🧹 Chores

- **lint**: satisfy query builder pickier checks ([ebbe85c](https://github.com/stacksjs/bun-query-builder/commit/ebbe85c)) _(by Chris <chrisbreuer93@gmail.com>)_
- **deps**: bump @stacksjs/ts-validation to ^0.5.0 ([cd89f24](https://github.com/stacksjs/bun-query-builder/commit/cd89f24)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: bump better-dx to ^0.2.15 ([8faa470](https://github.com/stacksjs/bun-query-builder/commit/8faa470)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### 📄 Miscellaneous

- Create query-builder.md ([dbbc105](https://github.com/stacksjs/bun-query-builder/commit/dbbc105)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### Contributors

- _Chris <chrisbreuer93@gmail.com>_
- _Glenn Michael Torregosa <gtorregosa@gmail.com>_
- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.20...v0.1.21)

### 🧹 Chores

- release v0.1.21 ([4951531](https://github.com/stacksjs/bun-query-builder/commit/4951531)) _(by Chris <chrisbreuer93@gmail.com>)_

### 📄 Miscellaneous

- fix query builder generated entry patching ([948c264](https://github.com/stacksjs/bun-query-builder/commit/948c264)) _(by Chris <chrisbreuer93@gmail.com>)_

### Contributors

- _Chris <chrisbreuer93@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.20...HEAD)

### 📄 Miscellaneous

- fix query builder generated entry patching ([948c264](https://github.com/stacksjs/bun-query-builder/commit/948c264)) _(by Chris <chrisbreuer93@gmail.com>)_

### Contributors

- _Chris <chrisbreuer93@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.19...v0.1.20)

### 🧹 Chores

- release v0.1.20 ([38dfbca](https://github.com/stacksjs/bun-query-builder/commit/38dfbca)) _(by Chris <chrisbreuer93@gmail.com>)_

### 📄 Miscellaneous

- fix query builder package publish build ([b52d3c9](https://github.com/stacksjs/bun-query-builder/commit/b52d3c9)) _(by Chris <chrisbreuer93@gmail.com>)_

### Contributors

- _Chris <chrisbreuer93@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.19...HEAD)

### 📄 Miscellaneous

- fix query builder package publish build ([b52d3c9](https://github.com/stacksjs/bun-query-builder/commit/b52d3c9)) _(by Chris <chrisbreuer93@gmail.com>)_

### Contributors

- _Chris <chrisbreuer93@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.18...v0.1.19)

### 🧹 Chores

- release v0.1.19 ([b2f72aa](https://github.com/stacksjs/bun-query-builder/commit/b2f72aa)) _(by Chris <chrisbreuer93@gmail.com>)_

### 📄 Miscellaneous

- fix query builder async entry bundle ([22720fe](https://github.com/stacksjs/bun-query-builder/commit/22720fe)) _(by Chris <chrisbreuer93@gmail.com>)_

### Contributors

- _Chris <chrisbreuer93@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.18...HEAD)

### 📄 Miscellaneous

- fix query builder async entry bundle ([22720fe](https://github.com/stacksjs/bun-query-builder/commit/22720fe)) _(by Chris <chrisbreuer93@gmail.com>)_

### Contributors

- _Chris <chrisbreuer93@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.17...v0.1.18)

### 🚀 Features

- **orm**: pivot table extra columns + mutations on belongsToMany ([d294f60](https://github.com/stacksjs/bun-query-builder/commit/d294f60)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### 🐛 Bug Fixes

- **types**: lift inline return types so dtsx emits valid .d.ts ([86c3c8c](https://github.com/stacksjs/bun-query-builder/commit/86c3c8c)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **orm**: drop duplicate toArray alias + add 'not like' to WhereOperator ([bae192b](https://github.com/stacksjs/bun-query-builder/commit/bae192b)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### 🧹 Chores

- release v0.1.18 ([761778c](https://github.com/stacksjs/bun-query-builder/commit/761778c)) _(by Chris <chrisbreuer93@gmail.com>)_
- release v0.1.17 ([1c8c156](https://github.com/stacksjs/bun-query-builder/commit/1c8c156)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([33ee771](https://github.com/stacksjs/bun-query-builder/commit/33ee771)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- refresh bun.lock to pick up @stacksjs/clapp@0.2.8 ([65805a9](https://github.com/stacksjs/bun-query-builder/commit/65805a9)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- drop unused unconfig override ([2048431](https://github.com/stacksjs/bun-query-builder/commit/2048431)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- refresh bun.lock and apply pickier --fix ([61cf353](https://github.com/stacksjs/bun-query-builder/commit/61cf353)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- refresh bun.lock ([1cef3c0](https://github.com/stacksjs/bun-query-builder/commit/1cef3c0)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- lint:fix ([a5d9e94](https://github.com/stacksjs/bun-query-builder/commit/a5d9e94)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### Contributors

- _Chris <chrisbreuer93@gmail.com>_
- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.16...HEAD)

### 🚀 Features

- **orm**: pivot table extra columns + mutations on belongsToMany ([d294f60](https://github.com/stacksjs/bun-query-builder/commit/d294f60)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### 🐛 Bug Fixes

- **types**: lift inline return types so dtsx emits valid .d.ts ([86c3c8c](https://github.com/stacksjs/bun-query-builder/commit/86c3c8c)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **orm**: drop duplicate toArray alias + add 'not like' to WhereOperator ([bae192b](https://github.com/stacksjs/bun-query-builder/commit/bae192b)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### 🧹 Chores

- release v0.1.17 ([1c8c156](https://github.com/stacksjs/bun-query-builder/commit/1c8c156)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([33ee771](https://github.com/stacksjs/bun-query-builder/commit/33ee771)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- refresh bun.lock to pick up @stacksjs/clapp@0.2.8 ([65805a9](https://github.com/stacksjs/bun-query-builder/commit/65805a9)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- drop unused unconfig override ([2048431](https://github.com/stacksjs/bun-query-builder/commit/2048431)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- refresh bun.lock and apply pickier --fix ([61cf353](https://github.com/stacksjs/bun-query-builder/commit/61cf353)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- refresh bun.lock ([1cef3c0](https://github.com/stacksjs/bun-query-builder/commit/1cef3c0)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- lint:fix ([a5d9e94](https://github.com/stacksjs/bun-query-builder/commit/a5d9e94)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- refresh bun.lock to pick up latest pickier ([af08be7](https://github.com/stacksjs/bun-query-builder/commit/af08be7)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### Contributors

- _Chris <chrisbreuer93@gmail.com>_
- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.16...v0.1.17)

### 🧹 Chores

- release v0.1.17 ([363365e](https://github.com/stacksjs/bun-query-builder/commit/363365e)) _(by Chris <chrisbreuer93@gmail.com>)_
- refresh bun.lock to pick up latest pickier ([af08be7](https://github.com/stacksjs/bun-query-builder/commit/af08be7)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### Contributors

- _Chris <chrisbreuer93@gmail.com>_
- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.16...HEAD)

### 🧹 Chores

- refresh bun.lock to pick up latest pickier ([af08be7](https://github.com/stacksjs/bun-query-builder/commit/af08be7)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### Contributors

- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.15...v0.1.16)

### 🚀 Features

- **orm**: add nested whereGroup callback + raw + or-variants on ModelQueryBuilder ([a1436f8](https://github.com/stacksjs/bun-query-builder/commit/a1436f8)) _(by Chris <chrisbreuer93@gmail.com>)_
- **orm**: add Eloquent-style instance helpers + fix refresh() return ([a0e80fe](https://github.com/stacksjs/bun-query-builder/commit/a0e80fe)) _(by Chris <chrisbreuer93@gmail.com>)_

### 🐛 Bug Fixes

- add setup-bun to publish-commit job ([03ab574](https://github.com/stacksjs/bun-query-builder/commit/03ab574)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- max() and min() return null on empty tables instead of 0 ([1f43678](https://github.com/stacksjs/bun-query-builder/commit/1f43678)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### 🤖 Continuous Integration

- drop redundant setup-bun (pantry installs bun via deps.yaml) ([52d3711](https://github.com/stacksjs/bun-query-builder/commit/52d3711)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### 🧹 Chores

- release v0.1.16 ([50ab13b](https://github.com/stacksjs/bun-query-builder/commit/50ab13b)) _(by Chris <chrisbreuer93@gmail.com>)_
- fresh install to pick up dtsx 0.9.14 and bunfig 0.15.9 ([5057b97](https://github.com/stacksjs/bun-query-builder/commit/5057b97)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([e4fd45d](https://github.com/stacksjs/bun-query-builder/commit/e4fd45d)) _(by Chris <chrisbreuer93@gmail.com>)_

### Contributors

- _Chris <chrisbreuer93@gmail.com>_
- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.15...HEAD)

### 🚀 Features

- **orm**: add nested whereGroup callback + raw + or-variants on ModelQueryBuilder ([a1436f8](https://github.com/stacksjs/bun-query-builder/commit/a1436f8)) _(by Chris <chrisbreuer93@gmail.com>)_
- **orm**: add Eloquent-style instance helpers + fix refresh() return ([a0e80fe](https://github.com/stacksjs/bun-query-builder/commit/a0e80fe)) _(by Chris <chrisbreuer93@gmail.com>)_

### 🐛 Bug Fixes

- add setup-bun to publish-commit job ([03ab574](https://github.com/stacksjs/bun-query-builder/commit/03ab574)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- max() and min() return null on empty tables instead of 0 ([1f43678](https://github.com/stacksjs/bun-query-builder/commit/1f43678)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### 🤖 Continuous Integration

- drop redundant setup-bun (pantry installs bun via deps.yaml) ([52d3711](https://github.com/stacksjs/bun-query-builder/commit/52d3711)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### 🧹 Chores

- fresh install to pick up dtsx 0.9.14 and bunfig 0.15.9 ([5057b97](https://github.com/stacksjs/bun-query-builder/commit/5057b97)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([e4fd45d](https://github.com/stacksjs/bun-query-builder/commit/e4fd45d)) _(by Chris <chrisbreuer93@gmail.com>)_

### Contributors

- _Chris <chrisbreuer93@gmail.com>_
- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.14...v0.1.15)

### 🚀 Features

- **migrations**: auto-emit pivot tables for likeable/taggable/categorizable ([1f167ef](https://github.com/stacksjs/bun-query-builder/commit/1f167ef)) _(by Chris <chrisbreuer93@gmail.com>)_

### 🐛 Bug Fixes

- guard setConfig against bundler-deferred config init ([039642e](https://github.com/stacksjs/bun-query-builder/commit/039642e)) _(by Chris <chrisbreuer93@gmail.com>)_
- **migrations**: null-safe validation access + add uuid column for useUuid trait ([fbe5667](https://github.com/stacksjs/bun-query-builder/commit/fbe5667)) _(by Chris <chrisbreuer93@gmail.com>)_
- correct build output path from dist/index.js to dist/src/index.js ([efcffba](https://github.com/stacksjs/bun-query-builder/commit/efcffba)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- make aggregate null-safe and move test setup to beforeAll ([4c22df0](https://github.com/stacksjs/bun-query-builder/commit/4c22df0)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- surface build failures by checking Bun.build result ([d782fad](https://github.com/stacksjs/bun-query-builder/commit/d782fad)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### 🧪 Tests

- **edge-cases**: align max/min empty-set with null SQL semantics ([d0353d6](https://github.com/stacksjs/bun-query-builder/commit/d0353d6)) _(by Chris <chrisbreuer93@gmail.com>)_

### 🧹 Chores

- release v0.1.15 ([f9eb074](https://github.com/stacksjs/bun-query-builder/commit/f9eb074)) _(by Chris <chrisbreuer93@gmail.com>)_
- add release:patch/minor/major scripts ([eb765d7](https://github.com/stacksjs/bun-query-builder/commit/eb765d7)) _(by Chris <chrisbreuer93@gmail.com>)_
- fresh install to pick up pickier 0.1.21 ([e85738b](https://github.com/stacksjs/bun-query-builder/commit/e85738b)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### Contributors

- _Chris <chrisbreuer93@gmail.com>_
- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.12...v0.1.13)

### 🧹 Chores

- release v0.1.13 ([41a8f9e](https://github.com/stacksjs/bun-query-builder/commit/41a8f9e)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([7e0cc35](https://github.com/stacksjs/bun-query-builder/commit/7e0cc35)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([9acd78d](https://github.com/stacksjs/bun-query-builder/commit/9acd78d)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### Contributors

- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.12...HEAD)

### 🧹 Chores

- wip ([7e0cc35](https://github.com/stacksjs/bun-query-builder/commit/7e0cc35)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([9acd78d](https://github.com/stacksjs/bun-query-builder/commit/9acd78d)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### Contributors

- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.11...v0.1.12)

### 🧹 Chores

- release v0.1.12 ([e4ef248](https://github.com/stacksjs/bun-query-builder/commit/e4ef248)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([1b981ef](https://github.com/stacksjs/bun-query-builder/commit/1b981ef)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([6a3ad3d](https://github.com/stacksjs/bun-query-builder/commit/6a3ad3d)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([b9f2d6f](https://github.com/stacksjs/bun-query-builder/commit/b9f2d6f)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([4a8d1af](https://github.com/stacksjs/bun-query-builder/commit/4a8d1af)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### Contributors

- _Chris <chrisbreuer93@gmail.com>_
- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.11...HEAD)

### 🧹 Chores

- wip ([1b981ef](https://github.com/stacksjs/bun-query-builder/commit/1b981ef)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([6a3ad3d](https://github.com/stacksjs/bun-query-builder/commit/6a3ad3d)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([b9f2d6f](https://github.com/stacksjs/bun-query-builder/commit/b9f2d6f)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([4a8d1af](https://github.com/stacksjs/bun-query-builder/commit/4a8d1af)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### Contributors

- _Chris <chrisbreuer93@gmail.com>_
- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.10...v0.1.11)

### 🧹 Chores

- release v0.1.11 ([d8388ad](https://github.com/stacksjs/bun-query-builder/commit/d8388ad)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: update all non-major dependencies (#918) ([f55ae3e](https://github.com/stacksjs/bun-query-builder/commit/f55ae3e)) _(by [renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>](https://github.com/renovate[bot]))_ ([#918](https://github.com/stacksjs/bun-query-builder/issues/918), [#918](https://github.com/stacksjs/bun-query-builder/issues/918))
- **deps**: update all non-major dependencies (#958) ([5af2c27](https://github.com/stacksjs/bun-query-builder/commit/5af2c27)) _(by Chris <chrisbreuer93@gmail.com>)_ ([#958](https://github.com/stacksjs/bun-query-builder/issues/958), [#958](https://github.com/stacksjs/bun-query-builder/issues/958))
- wip ([74e1bba](https://github.com/stacksjs/bun-query-builder/commit/74e1bba)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([20445cb](https://github.com/stacksjs/bun-query-builder/commit/20445cb)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([2aacea1](https://github.com/stacksjs/bun-query-builder/commit/2aacea1)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([665991f](https://github.com/stacksjs/bun-query-builder/commit/665991f)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([0a3544a](https://github.com/stacksjs/bun-query-builder/commit/0a3544a)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([f6b0613](https://github.com/stacksjs/bun-query-builder/commit/f6b0613)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([9b2342a](https://github.com/stacksjs/bun-query-builder/commit/9b2342a)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([cc5bb25](https://github.com/stacksjs/bun-query-builder/commit/cc5bb25)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([7bb7686](https://github.com/stacksjs/bun-query-builder/commit/7bb7686)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([787dcd7](https://github.com/stacksjs/bun-query-builder/commit/787dcd7)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([7f3cf3e](https://github.com/stacksjs/bun-query-builder/commit/7f3cf3e)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([9d7be11](https://github.com/stacksjs/bun-query-builder/commit/9d7be11)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([23b034f](https://github.com/stacksjs/bun-query-builder/commit/23b034f)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([8d4331f](https://github.com/stacksjs/bun-query-builder/commit/8d4331f)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([901f8cf](https://github.com/stacksjs/bun-query-builder/commit/901f8cf)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([2a75ab6](https://github.com/stacksjs/bun-query-builder/commit/2a75ab6)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([fecdc7d](https://github.com/stacksjs/bun-query-builder/commit/fecdc7d)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([9ade20a](https://github.com/stacksjs/bun-query-builder/commit/9ade20a)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([1dcd90a](https://github.com/stacksjs/bun-query-builder/commit/1dcd90a)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([61947db](https://github.com/stacksjs/bun-query-builder/commit/61947db)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([1f8abd3](https://github.com/stacksjs/bun-query-builder/commit/1f8abd3)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: update all non-major dependencies (#917) ([bfe5259](https://github.com/stacksjs/bun-query-builder/commit/bfe5259)) _(by Chris <chrisbreuer93@gmail.com>)_ ([#917](https://github.com/stacksjs/bun-query-builder/issues/917), [#917](https://github.com/stacksjs/bun-query-builder/issues/917))
- wip ([e8fad65](https://github.com/stacksjs/bun-query-builder/commit/e8fad65)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([d3ee6a0](https://github.com/stacksjs/bun-query-builder/commit/d3ee6a0)) _(by Chris <chrisbreuer93@gmail.com>)_
- **deps**: update all non-major dependencies (#916) ([f8462e7](https://github.com/stacksjs/bun-query-builder/commit/f8462e7)) _(by [renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>](https://github.com/renovate[bot]))_ ([#916](https://github.com/stacksjs/bun-query-builder/issues/916), [#916](https://github.com/stacksjs/bun-query-builder/issues/916))
- **deps**: update dependency actions/cache to v5.0.2 (#769) ([82a090c](https://github.com/stacksjs/bun-query-builder/commit/82a090c)) _(by Chris <chrisbreuer93@gmail.com>)_ ([#769](https://github.com/stacksjs/bun-query-builder/issues/769), [#769](https://github.com/stacksjs/bun-query-builder/issues/769))
- wip ([498a851](https://github.com/stacksjs/bun-query-builder/commit/498a851)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wop ([845496b](https://github.com/stacksjs/bun-query-builder/commit/845496b)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([895df5a](https://github.com/stacksjs/bun-query-builder/commit/895df5a)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([b0aa294](https://github.com/stacksjs/bun-query-builder/commit/b0aa294)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([8530689](https://github.com/stacksjs/bun-query-builder/commit/8530689)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([fd4f662](https://github.com/stacksjs/bun-query-builder/commit/fd4f662)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: update actions/checkout action to v6 (#187) ([1dca603](https://github.com/stacksjs/bun-query-builder/commit/1dca603)) _(by [renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>](https://github.com/renovate[bot]))_ ([#187](https://github.com/stacksjs/bun-query-builder/issues/187), [#187](https://github.com/stacksjs/bun-query-builder/issues/187))
- **deps**: update dependency actions/checkout to v6.0.1 (#186) ([f801477](https://github.com/stacksjs/bun-query-builder/commit/f801477)) _(by Chris <chrisbreuer93@gmail.com>)_ ([#186](https://github.com/stacksjs/bun-query-builder/issues/186), [#186](https://github.com/stacksjs/bun-query-builder/issues/186))
- **deps**: update dependency @prisma/client to 7.2.0 (#277) ([de6a1e0](https://github.com/stacksjs/bun-query-builder/commit/de6a1e0)) _(by Chris <chrisbreuer93@gmail.com>)_ ([#277](https://github.com/stacksjs/bun-query-builder/issues/277), [#277](https://github.com/stacksjs/bun-query-builder/issues/277))
- **deps**: update dependency actions/cache to v5.0.1 (#385) ([34692b1](https://github.com/stacksjs/bun-query-builder/commit/34692b1)) _(by Chris <chrisbreuer93@gmail.com>)_ ([#385](https://github.com/stacksjs/bun-query-builder/issues/385), [#385](https://github.com/stacksjs/bun-query-builder/issues/385))
- wip ([c433f70](https://github.com/stacksjs/bun-query-builder/commit/c433f70)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([688953e](https://github.com/stacksjs/bun-query-builder/commit/688953e)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([3c4b566](https://github.com/stacksjs/bun-query-builder/commit/3c4b566)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([1d263dc](https://github.com/stacksjs/bun-query-builder/commit/1d263dc)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([9f50719](https://github.com/stacksjs/bun-query-builder/commit/9f50719)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([2f162ec](https://github.com/stacksjs/bun-query-builder/commit/2f162ec)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([cb9ea15](https://github.com/stacksjs/bun-query-builder/commit/cb9ea15)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([4cf0408](https://github.com/stacksjs/bun-query-builder/commit/4cf0408)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([0f00551](https://github.com/stacksjs/bun-query-builder/commit/0f00551)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: update dependency prisma to 7.1.0 (#278) ([05975b4](https://github.com/stacksjs/bun-query-builder/commit/05975b4)) _(by Chris <chrisbreuer93@gmail.com>)_ ([#278](https://github.com/stacksjs/bun-query-builder/issues/278), [#278](https://github.com/stacksjs/bun-query-builder/issues/278))
- wip ([ee5a778](https://github.com/stacksjs/bun-query-builder/commit/ee5a778)) _(by Chris <chrisbreuer93@gmail.com>)_
- **deps**: update all non-major dependencies (#180) ([4068f34](https://github.com/stacksjs/bun-query-builder/commit/4068f34)) _(by [renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>](https://github.com/renovate[bot]))_ ([#180](https://github.com/stacksjs/bun-query-builder/issues/180), [#180](https://github.com/stacksjs/bun-query-builder/issues/180))
- wip ([513d17b](https://github.com/stacksjs/bun-query-builder/commit/513d17b)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([5b71261](https://github.com/stacksjs/bun-query-builder/commit/5b71261)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([c7f6883](https://github.com/stacksjs/bun-query-builder/commit/c7f6883)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: update all non-major dependencies (#172) ([4f1bc86](https://github.com/stacksjs/bun-query-builder/commit/4f1bc86)) _(by [renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>](https://github.com/renovate[bot]))_ ([#172](https://github.com/stacksjs/bun-query-builder/issues/172), [#172](https://github.com/stacksjs/bun-query-builder/issues/172))

### Contributors

- _Chris <chrisbreuer93@gmail.com>_
- _[renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>](https://github.com/renovate[bot])_
- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.10...HEAD)

### 🧹 Chores

- **deps**: update all non-major dependencies (#918) ([f55ae3e](https://github.com/stacksjs/bun-query-builder/commit/f55ae3e)) _(by [renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>](https://github.com/renovate[bot]))_ ([#918](https://github.com/stacksjs/bun-query-builder/issues/918), [#918](https://github.com/stacksjs/bun-query-builder/issues/918))
- **deps**: update all non-major dependencies (#958) ([5af2c27](https://github.com/stacksjs/bun-query-builder/commit/5af2c27)) _(by Chris <chrisbreuer93@gmail.com>)_ ([#958](https://github.com/stacksjs/bun-query-builder/issues/958), [#958](https://github.com/stacksjs/bun-query-builder/issues/958))
- wip ([74e1bba](https://github.com/stacksjs/bun-query-builder/commit/74e1bba)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([20445cb](https://github.com/stacksjs/bun-query-builder/commit/20445cb)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([2aacea1](https://github.com/stacksjs/bun-query-builder/commit/2aacea1)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([665991f](https://github.com/stacksjs/bun-query-builder/commit/665991f)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([0a3544a](https://github.com/stacksjs/bun-query-builder/commit/0a3544a)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([f6b0613](https://github.com/stacksjs/bun-query-builder/commit/f6b0613)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([9b2342a](https://github.com/stacksjs/bun-query-builder/commit/9b2342a)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([cc5bb25](https://github.com/stacksjs/bun-query-builder/commit/cc5bb25)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([7bb7686](https://github.com/stacksjs/bun-query-builder/commit/7bb7686)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([787dcd7](https://github.com/stacksjs/bun-query-builder/commit/787dcd7)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([7f3cf3e](https://github.com/stacksjs/bun-query-builder/commit/7f3cf3e)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([9d7be11](https://github.com/stacksjs/bun-query-builder/commit/9d7be11)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([23b034f](https://github.com/stacksjs/bun-query-builder/commit/23b034f)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([8d4331f](https://github.com/stacksjs/bun-query-builder/commit/8d4331f)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([901f8cf](https://github.com/stacksjs/bun-query-builder/commit/901f8cf)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([2a75ab6](https://github.com/stacksjs/bun-query-builder/commit/2a75ab6)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([fecdc7d](https://github.com/stacksjs/bun-query-builder/commit/fecdc7d)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([9ade20a](https://github.com/stacksjs/bun-query-builder/commit/9ade20a)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([1dcd90a](https://github.com/stacksjs/bun-query-builder/commit/1dcd90a)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([61947db](https://github.com/stacksjs/bun-query-builder/commit/61947db)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([1f8abd3](https://github.com/stacksjs/bun-query-builder/commit/1f8abd3)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: update all non-major dependencies (#917) ([bfe5259](https://github.com/stacksjs/bun-query-builder/commit/bfe5259)) _(by Chris <chrisbreuer93@gmail.com>)_ ([#917](https://github.com/stacksjs/bun-query-builder/issues/917), [#917](https://github.com/stacksjs/bun-query-builder/issues/917))
- wip ([e8fad65](https://github.com/stacksjs/bun-query-builder/commit/e8fad65)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([d3ee6a0](https://github.com/stacksjs/bun-query-builder/commit/d3ee6a0)) _(by Chris <chrisbreuer93@gmail.com>)_
- **deps**: update all non-major dependencies (#916) ([f8462e7](https://github.com/stacksjs/bun-query-builder/commit/f8462e7)) _(by [renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>](https://github.com/renovate[bot]))_ ([#916](https://github.com/stacksjs/bun-query-builder/issues/916), [#916](https://github.com/stacksjs/bun-query-builder/issues/916))
- **deps**: update dependency actions/cache to v5.0.2 (#769) ([82a090c](https://github.com/stacksjs/bun-query-builder/commit/82a090c)) _(by Chris <chrisbreuer93@gmail.com>)_ ([#769](https://github.com/stacksjs/bun-query-builder/issues/769), [#769](https://github.com/stacksjs/bun-query-builder/issues/769))
- wip ([498a851](https://github.com/stacksjs/bun-query-builder/commit/498a851)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wop ([845496b](https://github.com/stacksjs/bun-query-builder/commit/845496b)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([895df5a](https://github.com/stacksjs/bun-query-builder/commit/895df5a)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([b0aa294](https://github.com/stacksjs/bun-query-builder/commit/b0aa294)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([8530689](https://github.com/stacksjs/bun-query-builder/commit/8530689)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([fd4f662](https://github.com/stacksjs/bun-query-builder/commit/fd4f662)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: update actions/checkout action to v6 (#187) ([1dca603](https://github.com/stacksjs/bun-query-builder/commit/1dca603)) _(by [renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>](https://github.com/renovate[bot]))_ ([#187](https://github.com/stacksjs/bun-query-builder/issues/187), [#187](https://github.com/stacksjs/bun-query-builder/issues/187))
- **deps**: update dependency actions/checkout to v6.0.1 (#186) ([f801477](https://github.com/stacksjs/bun-query-builder/commit/f801477)) _(by Chris <chrisbreuer93@gmail.com>)_ ([#186](https://github.com/stacksjs/bun-query-builder/issues/186), [#186](https://github.com/stacksjs/bun-query-builder/issues/186))
- **deps**: update dependency @prisma/client to 7.2.0 (#277) ([de6a1e0](https://github.com/stacksjs/bun-query-builder/commit/de6a1e0)) _(by Chris <chrisbreuer93@gmail.com>)_ ([#277](https://github.com/stacksjs/bun-query-builder/issues/277), [#277](https://github.com/stacksjs/bun-query-builder/issues/277))
- **deps**: update dependency actions/cache to v5.0.1 (#385) ([34692b1](https://github.com/stacksjs/bun-query-builder/commit/34692b1)) _(by Chris <chrisbreuer93@gmail.com>)_ ([#385](https://github.com/stacksjs/bun-query-builder/issues/385), [#385](https://github.com/stacksjs/bun-query-builder/issues/385))
- wip ([c433f70](https://github.com/stacksjs/bun-query-builder/commit/c433f70)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([688953e](https://github.com/stacksjs/bun-query-builder/commit/688953e)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([3c4b566](https://github.com/stacksjs/bun-query-builder/commit/3c4b566)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([1d263dc](https://github.com/stacksjs/bun-query-builder/commit/1d263dc)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([9f50719](https://github.com/stacksjs/bun-query-builder/commit/9f50719)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([2f162ec](https://github.com/stacksjs/bun-query-builder/commit/2f162ec)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([cb9ea15](https://github.com/stacksjs/bun-query-builder/commit/cb9ea15)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([4cf0408](https://github.com/stacksjs/bun-query-builder/commit/4cf0408)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([0f00551](https://github.com/stacksjs/bun-query-builder/commit/0f00551)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: update dependency prisma to 7.1.0 (#278) ([05975b4](https://github.com/stacksjs/bun-query-builder/commit/05975b4)) _(by Chris <chrisbreuer93@gmail.com>)_ ([#278](https://github.com/stacksjs/bun-query-builder/issues/278), [#278](https://github.com/stacksjs/bun-query-builder/issues/278))
- wip ([ee5a778](https://github.com/stacksjs/bun-query-builder/commit/ee5a778)) _(by Chris <chrisbreuer93@gmail.com>)_
- **deps**: update all non-major dependencies (#180) ([4068f34](https://github.com/stacksjs/bun-query-builder/commit/4068f34)) _(by [renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>](https://github.com/renovate[bot]))_ ([#180](https://github.com/stacksjs/bun-query-builder/issues/180), [#180](https://github.com/stacksjs/bun-query-builder/issues/180))
- wip ([513d17b](https://github.com/stacksjs/bun-query-builder/commit/513d17b)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([5b71261](https://github.com/stacksjs/bun-query-builder/commit/5b71261)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([c7f6883](https://github.com/stacksjs/bun-query-builder/commit/c7f6883)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: update all non-major dependencies (#172) ([4f1bc86](https://github.com/stacksjs/bun-query-builder/commit/4f1bc86)) _(by [renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>](https://github.com/renovate[bot]))_ ([#172](https://github.com/stacksjs/bun-query-builder/issues/172), [#172](https://github.com/stacksjs/bun-query-builder/issues/172))

### Contributors

- _Chris <chrisbreuer93@gmail.com>_
- _[renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>](https://github.com/renovate[bot])_
- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.9...v0.1.10)

### 🧹 Chores

- release v0.1.10 ([36715f8](https://github.com/stacksjs/bun-query-builder/commit/36715f8)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([769bf41](https://github.com/stacksjs/bun-query-builder/commit/769bf41)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([ddf3220](https://github.com/stacksjs/bun-query-builder/commit/ddf3220)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### Contributors

- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.9...HEAD)

### 🧹 Chores

- wip ([769bf41](https://github.com/stacksjs/bun-query-builder/commit/769bf41)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([ddf3220](https://github.com/stacksjs/bun-query-builder/commit/ddf3220)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### Contributors

- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.8...v0.1.9)

### 🧹 Chores

- release v0.1.9 ([df1b676](https://github.com/stacksjs/bun-query-builder/commit/df1b676)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([c8e6687](https://github.com/stacksjs/bun-query-builder/commit/c8e6687)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([b883eb2](https://github.com/stacksjs/bun-query-builder/commit/b883eb2)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### Contributors

- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.8...HEAD)

### 🧹 Chores

- wip ([c8e6687](https://github.com/stacksjs/bun-query-builder/commit/c8e6687)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([b883eb2](https://github.com/stacksjs/bun-query-builder/commit/b883eb2)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### Contributors

- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.7...v0.1.8)

### 🧹 Chores

- release v0.1.8 ([cf4543f](https://github.com/stacksjs/bun-query-builder/commit/cf4543f)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([3d17fc0](https://github.com/stacksjs/bun-query-builder/commit/3d17fc0)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([073ca30](https://github.com/stacksjs/bun-query-builder/commit/073ca30)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([fd03a3d](https://github.com/stacksjs/bun-query-builder/commit/fd03a3d)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### Contributors

- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.7...HEAD)

### 🧹 Chores

- wip ([3d17fc0](https://github.com/stacksjs/bun-query-builder/commit/3d17fc0)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([073ca30](https://github.com/stacksjs/bun-query-builder/commit/073ca30)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([fd03a3d](https://github.com/stacksjs/bun-query-builder/commit/fd03a3d)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### Contributors

- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.6...v0.1.7)

### 🧹 Chores

- release v0.1.7 ([5781509](https://github.com/stacksjs/bun-query-builder/commit/5781509)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([0abbde5](https://github.com/stacksjs/bun-query-builder/commit/0abbde5)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### Contributors

- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.6...HEAD)

### 🧹 Chores

- wip ([0abbde5](https://github.com/stacksjs/bun-query-builder/commit/0abbde5)) _(by glennmichael123 <gtorregosa@gmail.com>)_

### Contributors

- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.5...v0.1.6)

### 🧹 Chores

- release v0.1.6 ([fbce5e8](https://github.com/stacksjs/bun-query-builder/commit/fbce5e8)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: update all non-major dependencies (#164) ([c3ad9cd](https://github.com/stacksjs/bun-query-builder/commit/c3ad9cd)) _(by [renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>](https://github.com/renovate[bot]))_ ([#164](https://github.com/stacksjs/bun-query-builder/issues/164), [#164](https://github.com/stacksjs/bun-query-builder/issues/164))
- wip ([40b5ad1](https://github.com/stacksjs/bun-query-builder/commit/40b5ad1)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([1c23b98](https://github.com/stacksjs/bun-query-builder/commit/1c23b98)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: update all non-major dependencies (#162) ([4631a1f](https://github.com/stacksjs/bun-query-builder/commit/4631a1f)) _(by Chris <chrisbreuer93@gmail.com>)_ ([#162](https://github.com/stacksjs/bun-query-builder/issues/162), [#162](https://github.com/stacksjs/bun-query-builder/issues/162))
- wip ([3fcdd8d](https://github.com/stacksjs/bun-query-builder/commit/3fcdd8d)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: update all non-major dependencies (#160) ([01a050e](https://github.com/stacksjs/bun-query-builder/commit/01a050e)) _(by [renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>](https://github.com/renovate[bot]))_ ([#160](https://github.com/stacksjs/bun-query-builder/issues/160), [#160](https://github.com/stacksjs/bun-query-builder/issues/160))
- wip ([2041f44](https://github.com/stacksjs/bun-query-builder/commit/2041f44)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: update dependency mitata to 1.0.34 (#74) ([84d507f](https://github.com/stacksjs/bun-query-builder/commit/84d507f)) _(by Chris <chrisbreuer93@gmail.com>)_ ([#74](https://github.com/stacksjs/bun-query-builder/issues/74), [#74](https://github.com/stacksjs/bun-query-builder/issues/74))

### Contributors

- _Chris <chrisbreuer93@gmail.com>_
- _[renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>](https://github.com/renovate[bot])_
- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.5...HEAD)

### 🧹 Chores

- **deps**: update all non-major dependencies (#164) ([c3ad9cd](https://github.com/stacksjs/bun-query-builder/commit/c3ad9cd)) _(by [renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>](https://github.com/renovate[bot]))_ ([#164](https://github.com/stacksjs/bun-query-builder/issues/164), [#164](https://github.com/stacksjs/bun-query-builder/issues/164))
- wip ([40b5ad1](https://github.com/stacksjs/bun-query-builder/commit/40b5ad1)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([1c23b98](https://github.com/stacksjs/bun-query-builder/commit/1c23b98)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: update all non-major dependencies (#162) ([4631a1f](https://github.com/stacksjs/bun-query-builder/commit/4631a1f)) _(by Chris <chrisbreuer93@gmail.com>)_ ([#162](https://github.com/stacksjs/bun-query-builder/issues/162), [#162](https://github.com/stacksjs/bun-query-builder/issues/162))
- wip ([3fcdd8d](https://github.com/stacksjs/bun-query-builder/commit/3fcdd8d)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: update all non-major dependencies (#160) ([01a050e](https://github.com/stacksjs/bun-query-builder/commit/01a050e)) _(by [renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>](https://github.com/renovate[bot]))_ ([#160](https://github.com/stacksjs/bun-query-builder/issues/160), [#160](https://github.com/stacksjs/bun-query-builder/issues/160))
- wip ([2041f44](https://github.com/stacksjs/bun-query-builder/commit/2041f44)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: update dependency mitata to 1.0.34 (#74) ([84d507f](https://github.com/stacksjs/bun-query-builder/commit/84d507f)) _(by Chris <chrisbreuer93@gmail.com>)_ ([#74](https://github.com/stacksjs/bun-query-builder/issues/74), [#74](https://github.com/stacksjs/bun-query-builder/issues/74))

### Contributors

- _Chris <chrisbreuer93@gmail.com>_
- _[renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>](https://github.com/renovate[bot])_
- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.5...HEAD)

### 🧹 Chores

- **deps**: update all non-major dependencies (#164) ([c3ad9cd](https://github.com/stacksjs/bun-query-builder/commit/c3ad9cd)) _(by [renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>](https://github.com/renovate[bot]))_ ([#164](https://github.com/stacksjs/bun-query-builder/issues/164), [#164](https://github.com/stacksjs/bun-query-builder/issues/164))
- wip ([40b5ad1](https://github.com/stacksjs/bun-query-builder/commit/40b5ad1)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([1c23b98](https://github.com/stacksjs/bun-query-builder/commit/1c23b98)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: update all non-major dependencies (#162) ([4631a1f](https://github.com/stacksjs/bun-query-builder/commit/4631a1f)) _(by Chris <chrisbreuer93@gmail.com>)_ ([#162](https://github.com/stacksjs/bun-query-builder/issues/162), [#162](https://github.com/stacksjs/bun-query-builder/issues/162))
- wip ([3fcdd8d](https://github.com/stacksjs/bun-query-builder/commit/3fcdd8d)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: update all non-major dependencies (#160) ([01a050e](https://github.com/stacksjs/bun-query-builder/commit/01a050e)) _(by [renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>](https://github.com/renovate[bot]))_ ([#160](https://github.com/stacksjs/bun-query-builder/issues/160), [#160](https://github.com/stacksjs/bun-query-builder/issues/160))
- wip ([2041f44](https://github.com/stacksjs/bun-query-builder/commit/2041f44)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: update dependency mitata to 1.0.34 (#74) ([84d507f](https://github.com/stacksjs/bun-query-builder/commit/84d507f)) _(by Chris <chrisbreuer93@gmail.com>)_ ([#74](https://github.com/stacksjs/bun-query-builder/issues/74), [#74](https://github.com/stacksjs/bun-query-builder/issues/74))

### Contributors

- _Chris <chrisbreuer93@gmail.com>_
- _[renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>](https://github.com/renovate[bot])_
- _glennmichael123 <gtorregosa@gmail.com>_

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.4...v0.1.5)

### 🧹 Chores

- release v0.1.5 ([31155a7](https://github.com/stacksjs/bun-query-builder/commit/31155a7))
- wip ([c15459c](https://github.com/stacksjs/bun-query-builder/commit/c15459c))

### Contributors

- Chris <chrisbreuer93@gmail.com>

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.4...HEAD)

### 🧹 Chores

- wip ([c15459c](https://github.com/stacksjs/bun-query-builder/commit/c15459c))

### Contributors

- Chris <chrisbreuer93@gmail.com>

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.3...v0.1.4)

### 🧹 Chores

- release v0.1.4 ([1efe5b9](https://github.com/stacksjs/bun-query-builder/commit/1efe5b9))
- wip ([2733193](https://github.com/stacksjs/bun-query-builder/commit/2733193))

### Contributors

- Chris <chrisbreuer93@gmail.com>

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.3...HEAD)

### 🧹 Chores

- wip ([2733193](https://github.com/stacksjs/bun-query-builder/commit/2733193))

### Contributors

- Chris <chrisbreuer93@gmail.com>

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.2...v0.1.3)

### 🐛 Bug Fixes

- paths ([74980e3](https://github.com/stacksjs/bun-query-builder/commit/74980e3))

### 🧹 Chores

- release v0.1.3 ([cef600e](https://github.com/stacksjs/bun-query-builder/commit/cef600e))
- wip ([91149a4](https://github.com/stacksjs/bun-query-builder/commit/91149a4))
- wip ([df0d966](https://github.com/stacksjs/bun-query-builder/commit/df0d966))
- wip ([6ec74c2](https://github.com/stacksjs/bun-query-builder/commit/6ec74c2))
- wip ([f128f1d](https://github.com/stacksjs/bun-query-builder/commit/f128f1d))
- wip ([569cffe](https://github.com/stacksjs/bun-query-builder/commit/569cffe))
- wip ([3078344](https://github.com/stacksjs/bun-query-builder/commit/3078344))
- wip ([bdecd45](https://github.com/stacksjs/bun-query-builder/commit/bdecd45))
- wip ([ab8b0e1](https://github.com/stacksjs/bun-query-builder/commit/ab8b0e1))
- wip ([8bab58c](https://github.com/stacksjs/bun-query-builder/commit/8bab58c))
- wip ([fd8d920](https://github.com/stacksjs/bun-query-builder/commit/fd8d920))
- wip ([eeaca24](https://github.com/stacksjs/bun-query-builder/commit/eeaca24))
- wip ([20a6aed](https://github.com/stacksjs/bun-query-builder/commit/20a6aed))
- wip ([f078ee0](https://github.com/stacksjs/bun-query-builder/commit/f078ee0))
- wip ([d07e0e9](https://github.com/stacksjs/bun-query-builder/commit/d07e0e9))
- wip ([265f330](https://github.com/stacksjs/bun-query-builder/commit/265f330))
- wip ([cce9c86](https://github.com/stacksjs/bun-query-builder/commit/cce9c86))
- wip ([d1c410e](https://github.com/stacksjs/bun-query-builder/commit/d1c410e))
- wip ([ad652ae](https://github.com/stacksjs/bun-query-builder/commit/ad652ae))
- wip ([da9a43c](https://github.com/stacksjs/bun-query-builder/commit/da9a43c))
- wip ([927cb0b](https://github.com/stacksjs/bun-query-builder/commit/927cb0b))
- wip ([203c906](https://github.com/stacksjs/bun-query-builder/commit/203c906))
- wip ([fd32a36](https://github.com/stacksjs/bun-query-builder/commit/fd32a36))
- wip ([83642f2](https://github.com/stacksjs/bun-query-builder/commit/83642f2))
- wip ([8387dbf](https://github.com/stacksjs/bun-query-builder/commit/8387dbf))
- wip ([f704ffd](https://github.com/stacksjs/bun-query-builder/commit/f704ffd))
- wip ([58529ac](https://github.com/stacksjs/bun-query-builder/commit/58529ac))
- wip ([8dfaaaa](https://github.com/stacksjs/bun-query-builder/commit/8dfaaaa))
- wip ([e04007e](https://github.com/stacksjs/bun-query-builder/commit/e04007e))
- wip ([d28bfb4](https://github.com/stacksjs/bun-query-builder/commit/d28bfb4))
- wip ([c44b728](https://github.com/stacksjs/bun-query-builder/commit/c44b728))
- wip ([7a4517e](https://github.com/stacksjs/bun-query-builder/commit/7a4517e))
- wip ([6bc1c4b](https://github.com/stacksjs/bun-query-builder/commit/6bc1c4b))
- wip ([5d1e727](https://github.com/stacksjs/bun-query-builder/commit/5d1e727))
- wip ([e6ebe5b](https://github.com/stacksjs/bun-query-builder/commit/e6ebe5b))
- wip ([ed96461](https://github.com/stacksjs/bun-query-builder/commit/ed96461))
- wip ([924a719](https://github.com/stacksjs/bun-query-builder/commit/924a719))
- wip ([51dca16](https://github.com/stacksjs/bun-query-builder/commit/51dca16))
- wip ([57ab5e6](https://github.com/stacksjs/bun-query-builder/commit/57ab5e6))
- wip ([712a443](https://github.com/stacksjs/bun-query-builder/commit/712a443))
- wip ([b4502b5](https://github.com/stacksjs/bun-query-builder/commit/b4502b5))
- wip ([ad59873](https://github.com/stacksjs/bun-query-builder/commit/ad59873))
- wip ([c66851e](https://github.com/stacksjs/bun-query-builder/commit/c66851e))
- wip ([34ba686](https://github.com/stacksjs/bun-query-builder/commit/34ba686))
- wip ([b383b03](https://github.com/stacksjs/bun-query-builder/commit/b383b03))
- wip ([550572b](https://github.com/stacksjs/bun-query-builder/commit/550572b))
- wip ([c31ab29](https://github.com/stacksjs/bun-query-builder/commit/c31ab29))
- wip ([3a232ab](https://github.com/stacksjs/bun-query-builder/commit/3a232ab))
- wip ([9209db0](https://github.com/stacksjs/bun-query-builder/commit/9209db0))
- wip ([55f06d9](https://github.com/stacksjs/bun-query-builder/commit/55f06d9))
- wip ([4638fd2](https://github.com/stacksjs/bun-query-builder/commit/4638fd2))
- wip ([7e48803](https://github.com/stacksjs/bun-query-builder/commit/7e48803))
- wip ([5124350](https://github.com/stacksjs/bun-query-builder/commit/5124350))
- wip ([082137d](https://github.com/stacksjs/bun-query-builder/commit/082137d))
- wip ([dc04242](https://github.com/stacksjs/bun-query-builder/commit/dc04242))
- wip ([2bf005d](https://github.com/stacksjs/bun-query-builder/commit/2bf005d))
- wip ([aca3099](https://github.com/stacksjs/bun-query-builder/commit/aca3099))
- wip ([46e3031](https://github.com/stacksjs/bun-query-builder/commit/46e3031))
- wip ([390801e](https://github.com/stacksjs/bun-query-builder/commit/390801e))
- wip ([c1c24fa](https://github.com/stacksjs/bun-query-builder/commit/c1c24fa))
- wip ([3e82779](https://github.com/stacksjs/bun-query-builder/commit/3e82779))
- wip ([5004bb4](https://github.com/stacksjs/bun-query-builder/commit/5004bb4))
- wip ([45b6374](https://github.com/stacksjs/bun-query-builder/commit/45b6374))
- wip ([cb7c361](https://github.com/stacksjs/bun-query-builder/commit/cb7c361))
- wip ([f86c816](https://github.com/stacksjs/bun-query-builder/commit/f86c816))
- wip ([365d506](https://github.com/stacksjs/bun-query-builder/commit/365d506))
- wip ([f66781f](https://github.com/stacksjs/bun-query-builder/commit/f66781f))
- wip ([7dbd89d](https://github.com/stacksjs/bun-query-builder/commit/7dbd89d))
- wip ([2ff8830](https://github.com/stacksjs/bun-query-builder/commit/2ff8830))
- wip ([4e23db3](https://github.com/stacksjs/bun-query-builder/commit/4e23db3))
- wip ([da12145](https://github.com/stacksjs/bun-query-builder/commit/da12145))
- wip ([632b98d](https://github.com/stacksjs/bun-query-builder/commit/632b98d))
- wip ([2217959](https://github.com/stacksjs/bun-query-builder/commit/2217959))
- wip ([5730af2](https://github.com/stacksjs/bun-query-builder/commit/5730af2))
- wip ([393afaf](https://github.com/stacksjs/bun-query-builder/commit/393afaf))
- wip ([6d22beb](https://github.com/stacksjs/bun-query-builder/commit/6d22beb))
- wip ([ecab098](https://github.com/stacksjs/bun-query-builder/commit/ecab098))
- wip ([db832aa](https://github.com/stacksjs/bun-query-builder/commit/db832aa))
- wip ([816b065](https://github.com/stacksjs/bun-query-builder/commit/816b065))
- wip ([e17a3d7](https://github.com/stacksjs/bun-query-builder/commit/e17a3d7))
- wip ([cf37b53](https://github.com/stacksjs/bun-query-builder/commit/cf37b53))
- wip ([2c283d8](https://github.com/stacksjs/bun-query-builder/commit/2c283d8))
- wip ([2af2ad7](https://github.com/stacksjs/bun-query-builder/commit/2af2ad7))
- wip ([6d38297](https://github.com/stacksjs/bun-query-builder/commit/6d38297))
- wip ([e668352](https://github.com/stacksjs/bun-query-builder/commit/e668352))
- wip ([9c3d880](https://github.com/stacksjs/bun-query-builder/commit/9c3d880))
- wip ([665b33f](https://github.com/stacksjs/bun-query-builder/commit/665b33f))
- wip ([2c56b8e](https://github.com/stacksjs/bun-query-builder/commit/2c56b8e))
- wip ([0908f67](https://github.com/stacksjs/bun-query-builder/commit/0908f67))
- wip ([222e272](https://github.com/stacksjs/bun-query-builder/commit/222e272))
- wip ([8fdd08a](https://github.com/stacksjs/bun-query-builder/commit/8fdd08a))
- wip ([df04479](https://github.com/stacksjs/bun-query-builder/commit/df04479))
- wip ([5f9f75a](https://github.com/stacksjs/bun-query-builder/commit/5f9f75a))
- wip ([cc8e1a8](https://github.com/stacksjs/bun-query-builder/commit/cc8e1a8))
- wip ([764e040](https://github.com/stacksjs/bun-query-builder/commit/764e040))
- wip ([741236d](https://github.com/stacksjs/bun-query-builder/commit/741236d))
- wip ([e9c62bd](https://github.com/stacksjs/bun-query-builder/commit/e9c62bd))
- wip ([ab75a10](https://github.com/stacksjs/bun-query-builder/commit/ab75a10))
- wip ([d33e32d](https://github.com/stacksjs/bun-query-builder/commit/d33e32d))
- wip ([4ce45fa](https://github.com/stacksjs/bun-query-builder/commit/4ce45fa))
- wip ([cb41835](https://github.com/stacksjs/bun-query-builder/commit/cb41835))
- wip ([228205c](https://github.com/stacksjs/bun-query-builder/commit/228205c))
- wip ([95df7de](https://github.com/stacksjs/bun-query-builder/commit/95df7de))
- wip ([3879c5b](https://github.com/stacksjs/bun-query-builder/commit/3879c5b))
- wip ([1c38d76](https://github.com/stacksjs/bun-query-builder/commit/1c38d76))
- wip ([f66d7ba](https://github.com/stacksjs/bun-query-builder/commit/f66d7ba))
- **deps**: update dependency @stacksjs/bumpx to ^0.1.69 (#27) ([8f0f751](https://github.com/stacksjs/bun-query-builder/commit/8f0f751)) ([#27](https://github.com/stacksjs/bun-query-builder/issues/27), [#27](https://github.com/stacksjs/bun-query-builder/issues/27))
- wip ([81dad92](https://github.com/stacksjs/bun-query-builder/commit/81dad92))
- wip ([63127d6](https://github.com/stacksjs/bun-query-builder/commit/63127d6))
- wip ([5ae5bb3](https://github.com/stacksjs/bun-query-builder/commit/5ae5bb3))
- wip ([76f777f](https://github.com/stacksjs/bun-query-builder/commit/76f777f))
- wip ([b108fa9](https://github.com/stacksjs/bun-query-builder/commit/b108fa9))
- wip ([8056fd5](https://github.com/stacksjs/bun-query-builder/commit/8056fd5))
- wip ([1deb364](https://github.com/stacksjs/bun-query-builder/commit/1deb364))
- wip ([dd4c4f4](https://github.com/stacksjs/bun-query-builder/commit/dd4c4f4))
- wip ([a956392](https://github.com/stacksjs/bun-query-builder/commit/a956392))
- wip ([2fc293d](https://github.com/stacksjs/bun-query-builder/commit/2fc293d))
- wip ([e84cc92](https://github.com/stacksjs/bun-query-builder/commit/e84cc92))
- wip ([5f09f24](https://github.com/stacksjs/bun-query-builder/commit/5f09f24))
- wip ([22ab39f](https://github.com/stacksjs/bun-query-builder/commit/22ab39f))
- wip ([0ca0242](https://github.com/stacksjs/bun-query-builder/commit/0ca0242))
- wip ([91c2d07](https://github.com/stacksjs/bun-query-builder/commit/91c2d07))
- **deps**: update all non-major dependencies (#23) ([0f92ae4](https://github.com/stacksjs/bun-query-builder/commit/0f92ae4)) ([#23](https://github.com/stacksjs/bun-query-builder/issues/23), [#23](https://github.com/stacksjs/bun-query-builder/issues/23))
- **deps**: update all non-major dependencies (#21) ([cc45e89](https://github.com/stacksjs/bun-query-builder/commit/cc45e89)) ([#21](https://github.com/stacksjs/bun-query-builder/issues/21), [#21](https://github.com/stacksjs/bun-query-builder/issues/21))
- **deps**: update dependency bun-plugin-dtsx to 0.21.12 (#22) ([e246400](https://github.com/stacksjs/bun-query-builder/commit/e246400)) ([#22](https://github.com/stacksjs/bun-query-builder/issues/22), [#22](https://github.com/stacksjs/bun-query-builder/issues/22))
- **deps**: update dependency buddy-bot to 0.9.4 (#24) ([c7975dc](https://github.com/stacksjs/bun-query-builder/commit/c7975dc)) ([#24](https://github.com/stacksjs/bun-query-builder/issues/24), [#24](https://github.com/stacksjs/bun-query-builder/issues/24))

### Contributors

- Chris <chrisbreuer93@gmail.com>
- glennmichael123 <gtorregosa@gmail.com>
- renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.2...HEAD)

### 🐛 Bug Fixes

- paths ([74980e3](https://github.com/stacksjs/bun-query-builder/commit/74980e3))

### 🧹 Chores

- wip ([91149a4](https://github.com/stacksjs/bun-query-builder/commit/91149a4))
- wip ([df0d966](https://github.com/stacksjs/bun-query-builder/commit/df0d966))
- wip ([6ec74c2](https://github.com/stacksjs/bun-query-builder/commit/6ec74c2))
- wip ([f128f1d](https://github.com/stacksjs/bun-query-builder/commit/f128f1d))
- wip ([569cffe](https://github.com/stacksjs/bun-query-builder/commit/569cffe))
- wip ([3078344](https://github.com/stacksjs/bun-query-builder/commit/3078344))
- wip ([bdecd45](https://github.com/stacksjs/bun-query-builder/commit/bdecd45))
- wip ([ab8b0e1](https://github.com/stacksjs/bun-query-builder/commit/ab8b0e1))
- wip ([8bab58c](https://github.com/stacksjs/bun-query-builder/commit/8bab58c))
- wip ([fd8d920](https://github.com/stacksjs/bun-query-builder/commit/fd8d920))
- wip ([eeaca24](https://github.com/stacksjs/bun-query-builder/commit/eeaca24))
- wip ([20a6aed](https://github.com/stacksjs/bun-query-builder/commit/20a6aed))
- wip ([f078ee0](https://github.com/stacksjs/bun-query-builder/commit/f078ee0))
- wip ([d07e0e9](https://github.com/stacksjs/bun-query-builder/commit/d07e0e9))
- wip ([265f330](https://github.com/stacksjs/bun-query-builder/commit/265f330))
- wip ([cce9c86](https://github.com/stacksjs/bun-query-builder/commit/cce9c86))
- wip ([d1c410e](https://github.com/stacksjs/bun-query-builder/commit/d1c410e))
- wip ([ad652ae](https://github.com/stacksjs/bun-query-builder/commit/ad652ae))
- wip ([da9a43c](https://github.com/stacksjs/bun-query-builder/commit/da9a43c))
- wip ([927cb0b](https://github.com/stacksjs/bun-query-builder/commit/927cb0b))
- wip ([203c906](https://github.com/stacksjs/bun-query-builder/commit/203c906))
- wip ([fd32a36](https://github.com/stacksjs/bun-query-builder/commit/fd32a36))
- wip ([83642f2](https://github.com/stacksjs/bun-query-builder/commit/83642f2))
- wip ([8387dbf](https://github.com/stacksjs/bun-query-builder/commit/8387dbf))
- wip ([f704ffd](https://github.com/stacksjs/bun-query-builder/commit/f704ffd))
- wip ([58529ac](https://github.com/stacksjs/bun-query-builder/commit/58529ac))
- wip ([8dfaaaa](https://github.com/stacksjs/bun-query-builder/commit/8dfaaaa))
- wip ([e04007e](https://github.com/stacksjs/bun-query-builder/commit/e04007e))
- wip ([d28bfb4](https://github.com/stacksjs/bun-query-builder/commit/d28bfb4))
- wip ([c44b728](https://github.com/stacksjs/bun-query-builder/commit/c44b728))
- wip ([7a4517e](https://github.com/stacksjs/bun-query-builder/commit/7a4517e))
- wip ([6bc1c4b](https://github.com/stacksjs/bun-query-builder/commit/6bc1c4b))
- wip ([5d1e727](https://github.com/stacksjs/bun-query-builder/commit/5d1e727))
- wip ([e6ebe5b](https://github.com/stacksjs/bun-query-builder/commit/e6ebe5b))
- wip ([ed96461](https://github.com/stacksjs/bun-query-builder/commit/ed96461))
- wip ([924a719](https://github.com/stacksjs/bun-query-builder/commit/924a719))
- wip ([51dca16](https://github.com/stacksjs/bun-query-builder/commit/51dca16))
- wip ([57ab5e6](https://github.com/stacksjs/bun-query-builder/commit/57ab5e6))
- wip ([712a443](https://github.com/stacksjs/bun-query-builder/commit/712a443))
- wip ([b4502b5](https://github.com/stacksjs/bun-query-builder/commit/b4502b5))
- wip ([ad59873](https://github.com/stacksjs/bun-query-builder/commit/ad59873))
- wip ([c66851e](https://github.com/stacksjs/bun-query-builder/commit/c66851e))
- wip ([34ba686](https://github.com/stacksjs/bun-query-builder/commit/34ba686))
- wip ([b383b03](https://github.com/stacksjs/bun-query-builder/commit/b383b03))
- wip ([550572b](https://github.com/stacksjs/bun-query-builder/commit/550572b))
- wip ([c31ab29](https://github.com/stacksjs/bun-query-builder/commit/c31ab29))
- wip ([3a232ab](https://github.com/stacksjs/bun-query-builder/commit/3a232ab))
- wip ([9209db0](https://github.com/stacksjs/bun-query-builder/commit/9209db0))
- wip ([55f06d9](https://github.com/stacksjs/bun-query-builder/commit/55f06d9))
- wip ([4638fd2](https://github.com/stacksjs/bun-query-builder/commit/4638fd2))
- wip ([7e48803](https://github.com/stacksjs/bun-query-builder/commit/7e48803))
- wip ([5124350](https://github.com/stacksjs/bun-query-builder/commit/5124350))
- wip ([082137d](https://github.com/stacksjs/bun-query-builder/commit/082137d))
- wip ([dc04242](https://github.com/stacksjs/bun-query-builder/commit/dc04242))
- wip ([2bf005d](https://github.com/stacksjs/bun-query-builder/commit/2bf005d))
- wip ([aca3099](https://github.com/stacksjs/bun-query-builder/commit/aca3099))
- wip ([46e3031](https://github.com/stacksjs/bun-query-builder/commit/46e3031))
- wip ([390801e](https://github.com/stacksjs/bun-query-builder/commit/390801e))
- wip ([c1c24fa](https://github.com/stacksjs/bun-query-builder/commit/c1c24fa))
- wip ([3e82779](https://github.com/stacksjs/bun-query-builder/commit/3e82779))
- wip ([5004bb4](https://github.com/stacksjs/bun-query-builder/commit/5004bb4))
- wip ([45b6374](https://github.com/stacksjs/bun-query-builder/commit/45b6374))
- wip ([cb7c361](https://github.com/stacksjs/bun-query-builder/commit/cb7c361))
- wip ([f86c816](https://github.com/stacksjs/bun-query-builder/commit/f86c816))
- wip ([365d506](https://github.com/stacksjs/bun-query-builder/commit/365d506))
- wip ([f66781f](https://github.com/stacksjs/bun-query-builder/commit/f66781f))
- wip ([7dbd89d](https://github.com/stacksjs/bun-query-builder/commit/7dbd89d))
- wip ([2ff8830](https://github.com/stacksjs/bun-query-builder/commit/2ff8830))
- wip ([4e23db3](https://github.com/stacksjs/bun-query-builder/commit/4e23db3))
- wip ([da12145](https://github.com/stacksjs/bun-query-builder/commit/da12145))
- wip ([632b98d](https://github.com/stacksjs/bun-query-builder/commit/632b98d))
- wip ([2217959](https://github.com/stacksjs/bun-query-builder/commit/2217959))
- wip ([5730af2](https://github.com/stacksjs/bun-query-builder/commit/5730af2))
- wip ([393afaf](https://github.com/stacksjs/bun-query-builder/commit/393afaf))
- wip ([6d22beb](https://github.com/stacksjs/bun-query-builder/commit/6d22beb))
- wip ([ecab098](https://github.com/stacksjs/bun-query-builder/commit/ecab098))
- wip ([db832aa](https://github.com/stacksjs/bun-query-builder/commit/db832aa))
- wip ([816b065](https://github.com/stacksjs/bun-query-builder/commit/816b065))
- wip ([e17a3d7](https://github.com/stacksjs/bun-query-builder/commit/e17a3d7))
- wip ([cf37b53](https://github.com/stacksjs/bun-query-builder/commit/cf37b53))
- wip ([2c283d8](https://github.com/stacksjs/bun-query-builder/commit/2c283d8))
- wip ([2af2ad7](https://github.com/stacksjs/bun-query-builder/commit/2af2ad7))
- wip ([6d38297](https://github.com/stacksjs/bun-query-builder/commit/6d38297))
- wip ([e668352](https://github.com/stacksjs/bun-query-builder/commit/e668352))
- wip ([9c3d880](https://github.com/stacksjs/bun-query-builder/commit/9c3d880))
- wip ([665b33f](https://github.com/stacksjs/bun-query-builder/commit/665b33f))
- wip ([2c56b8e](https://github.com/stacksjs/bun-query-builder/commit/2c56b8e))
- wip ([0908f67](https://github.com/stacksjs/bun-query-builder/commit/0908f67))
- wip ([222e272](https://github.com/stacksjs/bun-query-builder/commit/222e272))
- wip ([8fdd08a](https://github.com/stacksjs/bun-query-builder/commit/8fdd08a))
- wip ([df04479](https://github.com/stacksjs/bun-query-builder/commit/df04479))
- wip ([5f9f75a](https://github.com/stacksjs/bun-query-builder/commit/5f9f75a))
- wip ([cc8e1a8](https://github.com/stacksjs/bun-query-builder/commit/cc8e1a8))
- wip ([764e040](https://github.com/stacksjs/bun-query-builder/commit/764e040))
- wip ([741236d](https://github.com/stacksjs/bun-query-builder/commit/741236d))
- wip ([e9c62bd](https://github.com/stacksjs/bun-query-builder/commit/e9c62bd))
- wip ([ab75a10](https://github.com/stacksjs/bun-query-builder/commit/ab75a10))
- wip ([d33e32d](https://github.com/stacksjs/bun-query-builder/commit/d33e32d))
- wip ([4ce45fa](https://github.com/stacksjs/bun-query-builder/commit/4ce45fa))
- wip ([cb41835](https://github.com/stacksjs/bun-query-builder/commit/cb41835))
- wip ([228205c](https://github.com/stacksjs/bun-query-builder/commit/228205c))
- wip ([95df7de](https://github.com/stacksjs/bun-query-builder/commit/95df7de))
- wip ([3879c5b](https://github.com/stacksjs/bun-query-builder/commit/3879c5b))
- wip ([1c38d76](https://github.com/stacksjs/bun-query-builder/commit/1c38d76))
- wip ([f66d7ba](https://github.com/stacksjs/bun-query-builder/commit/f66d7ba))
- **deps**: update dependency @stacksjs/bumpx to ^0.1.69 (#27) ([8f0f751](https://github.com/stacksjs/bun-query-builder/commit/8f0f751)) ([#27](https://github.com/stacksjs/bun-query-builder/issues/27), [#27](https://github.com/stacksjs/bun-query-builder/issues/27))
- wip ([81dad92](https://github.com/stacksjs/bun-query-builder/commit/81dad92))
- wip ([63127d6](https://github.com/stacksjs/bun-query-builder/commit/63127d6))
- wip ([5ae5bb3](https://github.com/stacksjs/bun-query-builder/commit/5ae5bb3))
- wip ([76f777f](https://github.com/stacksjs/bun-query-builder/commit/76f777f))
- wip ([b108fa9](https://github.com/stacksjs/bun-query-builder/commit/b108fa9))
- wip ([8056fd5](https://github.com/stacksjs/bun-query-builder/commit/8056fd5))
- wip ([1deb364](https://github.com/stacksjs/bun-query-builder/commit/1deb364))
- wip ([dd4c4f4](https://github.com/stacksjs/bun-query-builder/commit/dd4c4f4))
- wip ([a956392](https://github.com/stacksjs/bun-query-builder/commit/a956392))
- wip ([2fc293d](https://github.com/stacksjs/bun-query-builder/commit/2fc293d))
- wip ([e84cc92](https://github.com/stacksjs/bun-query-builder/commit/e84cc92))
- wip ([5f09f24](https://github.com/stacksjs/bun-query-builder/commit/5f09f24))
- wip ([22ab39f](https://github.com/stacksjs/bun-query-builder/commit/22ab39f))
- wip ([0ca0242](https://github.com/stacksjs/bun-query-builder/commit/0ca0242))
- wip ([91c2d07](https://github.com/stacksjs/bun-query-builder/commit/91c2d07))
- **deps**: update all non-major dependencies (#23) ([0f92ae4](https://github.com/stacksjs/bun-query-builder/commit/0f92ae4)) ([#23](https://github.com/stacksjs/bun-query-builder/issues/23), [#23](https://github.com/stacksjs/bun-query-builder/issues/23))
- **deps**: update all non-major dependencies (#21) ([cc45e89](https://github.com/stacksjs/bun-query-builder/commit/cc45e89)) ([#21](https://github.com/stacksjs/bun-query-builder/issues/21), [#21](https://github.com/stacksjs/bun-query-builder/issues/21))
- **deps**: update dependency bun-plugin-dtsx to 0.21.12 (#22) ([e246400](https://github.com/stacksjs/bun-query-builder/commit/e246400)) ([#22](https://github.com/stacksjs/bun-query-builder/issues/22), [#22](https://github.com/stacksjs/bun-query-builder/issues/22))
- **deps**: update dependency buddy-bot to 0.9.4 (#24) ([c7975dc](https://github.com/stacksjs/bun-query-builder/commit/c7975dc)) ([#24](https://github.com/stacksjs/bun-query-builder/issues/24), [#24](https://github.com/stacksjs/bun-query-builder/issues/24))

### Contributors

- Chris <chrisbreuer93@gmail.com>
- glennmichael123 <gtorregosa@gmail.com>
- renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>

### Contributors

- Adelino Ngomacha <adelinob335@gmail.com>
- Chris <chrisbreuer93@gmail.com>
- Glenn Michael Torregosa <gtorregosa@gmail.com>
- glennmichael123 <gtorregosa@gmail.com>
- renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>

[Compare changes](https://github.com/stacksjs/bun-query-builder/compare/v0.1.0...HEAD)

### Contributors

- glennmichael123 <gtorregosa@gmail.com>

### Contributors

- Adelino Ngomacha <adelinob335@gmail.com>
- Chris <chrisbreuer93@gmail.com>
- glennmichael123 <gtorregosa@gmail.com>
