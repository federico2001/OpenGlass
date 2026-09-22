# Data migrations

Versioned data changes, applied in filename order by `migrate()` on api startup
(after validators and indexes). Create one with:

    pnpm --filter @openglass/db build && pnpm --filter @openglass/db migration:create add_foo

Each file is an ES module exporting `up(db, client)` and `down(db, client)`.
Migrations must be idempotent and must never touch `messages` or `records`
(append-only). Never ask a human to edit the database; write a migration.
