# Models answer in place

A model call returns its value where it is written. There is nothing to wait
for, so there is nothing to forget to wait for:

```ts
const user = User
  .where('email', 'like', '%@example.com')
  .orderByDesc('created_at')
  .first()

user.get('email') // the row is already here
```

The awaited form is the same program. `await` on a value is that value, so code
written before this, and code written by habit, keeps working:

```ts
const user = await User
  .where('email', 'like', '%@example.com')
  .orderByDesc('created_at')
  .first()
```

That holds for reads and writes alike, on SQLite, MySQL and Postgres:

```ts
const total = User.count()
const admins = User.where('role', 'admin').get()
const created = User.create({ email: 'ada@example.com' })
created.update({ name: 'Ada' })
if (User.where('email', email).exists())
  throw new Error('That address is taken')
```

A failure is thrown where the call stands, so a plain `try`/`catch` sees it:

```ts
try {
  User.findOrFail(id)
}
catch (error) {
  // not found
}
```

## How

SQLite has always run a query where it is called: `bun:sqlite` is synchronous.
Bun's MySQL and Postgres drivers answer with promises, so for those the model
layer keeps its connection on a worker thread and the caller waits for each
statement. It is the same driver, opened with the same URL and pool options as
the shared connection.

The cost is the one `bun:sqlite` already has: nothing else runs on the calling
thread while a query is in flight. A server process therefore handles one
query at a time, as PHP and Ruby servers do. If that is the wrong trade for an
application, ask for promises instead:

```ts
setConfig({ models: { execution: 'async' } })
```

MySQL and Postgres model calls then return promises, other work proceeds while
a query is in flight, and every model call has to be awaited. SQLite is
synchronous either way.

### A query that cannot finish

Because the calling thread waits, a query that can never finish would stop the
process. The way to write one is a model call inside a `db.transaction()` that
needs a row the transaction has locked: the transaction's connection is on the
calling thread, the model's is on the worker, and the transaction cannot commit
while its thread is waiting for the model. So a MySQL or Postgres model query
has a limit, 30 seconds by default, after which the call throws a
`StatementTimeoutError` (`code: 'ERR_QB_MODEL_STATEMENT_TIMEOUT'`):

```ts
setConfig({ models: { timeoutMs: 5000 } }) // 0 waits for as long as it takes
```

Postgres cancels the abandoned statement. MySQL's protocol has no cancel, so
an abandoned MySQL statement may still be applied once it is able to run.
Inside a transaction, write through the transaction (`tx.updateTable(...)`),
not through a model.

## When a call does return a promise

A method returns a promise only when something it touched could not answer in
place:

- **An async hook.** A model whose `beforeCreate`, `afterUpdate` and so on are
  `async` functions has to wait for them, so its writes return promises. Reads
  never run a hook and are always values. Hooks that return nothing leave the
  write in place.
- **A mutator that answers with a promise.** A `set` entry that hashes a
  password off the thread is waited for when an instance is saved or updated,
  so that write returns a promise. A mutator that answers in place leaves it in
  place.
- **An async callback you pass in**, such as `chunk(100, async rows => ...)`.
- **`models.execution: 'async'`**, above.
- **A connection you supplied** with `setSqlInstance()`. It lives on the
  calling thread and answers with promises.
- **A libSQL server.** Its transport is `fetch`.

The types follow the first two cases: a write is typed as its value on a model
without async hooks or mutators, and as a promise of it on a model with one.

## What changed for existing code

`await Model.find(1)` and `try { await ... } catch` are unaffected. Two shapes
are not:

```ts
// A value has no .then() or .catch(). Use await, or try/catch.
User.find(1).then(user => ...)
User.findOrFail(1).catch(() => null)

// A failure is thrown, not rejected.
await expect(User.findOrFail(0)).rejects.toThrow() // before
expect(() => User.findOrFail(0)).toThrow() // now
```

The query builder (`db.selectFrom(...)`) is unchanged: it still returns
promises.
