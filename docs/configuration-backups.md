# Configuration files and automatic backups

Open **Control → System → Configuration and backups**.

- **Save configuration on server** writes a complete configuration JSON file to the backup directory.
- **Export configuration file** downloads the same format to your browser.
- **Validate and import** checks a selected file and stages it for the next server restart.
- **Restore a server backup** accepts a path inside the configured backup directory. Legacy `.db` files retain the current configuration and credentials.
- **Cancel pending import** cancels an import before restart.

On a new installation, select **Import a configuration file** during onboarding. Create a temporary administrator to authorise the import.
After restart, sign in with an administrator account from the imported file. Imported sessions are revoked.

## Included data

Each versioned file contains the complete SQLite database, effective application configuration, saved credential store and `TANTALAR_SECRET_*`/`TANTALAR_WEBHOOK_*` environment values.
Named NNTP and webhook credential references are captured under portable Tantalar secret aliases. The live configuration remains unchanged during export.
The database includes libraries, plugin documents, accounts, API-key hashes, preferences, themes, onboarding, jobs and audit history.
Files contain unencrypted credentials. Server files have owner-only permissions. Browser exports use `Cache-Control: no-store`.

Media files, plugin binaries, external services and environment variables outside these Tantalar credential prefixes are excluded.
Recreate other external dependencies. Media paths and plugin paths must exist on the destination host.
The host database location remains unchanged. Profile, host-file, CLI and environment overrides take precedence over imported settings.

## Automatic backups

SQLite installations enable a **Configuration backup** job at **02:00 UTC daily**. The default directory is `backups` beside the database.
The default retention is seven automatic files.

Configure enablement, directory, retention and schedule on the configuration page.
Schedules accept `daily HH:MM` in UTC, or intervals such as `every 24h`, `every 60m` and `every 90s`.
The existing **Jobs** page also supports schedule changes, manual execution, run history and retries.
Overrides survive restart. Retention runs only after a new automatic file is complete. Zero retains all automatic files.
Manual files, safety files and unrelated files are never removed by retention.

## Restore safety and limits

Imports require administrator session authentication and CSRF protection. Anonymous onboarding cannot replace an installation.
Validation checks the format version, configuration structure, unsafe keys, database checksum, exact database schema, SQLite integrity and active administrator presence.
Import into the same Tantalar version. This version supports SQLite only: database snapshots are limited to 180 MiB and configuration files to 256 MiB.

Import creates a complete safety file beside the database, then atomically writes `configuration.pending.json`.
Startup applies this file before opening application database connections. A pending file remains available for recovery if startup fails during application.
Startup also preserves the last live database as `configuration.pre-restore.db`, with separate credential and runtime-configuration copies.
These capture writes made between staging and restart. The previous startup safety copies are replaced when another import is staged.
Keep adequate free space for the backup, pending file, restored database and safety copies.

## Validation

Server checks cover export/import access controls, restart recovery, credentials, retained host database location, corruption, unsafe keys, pending cancellation and retention.
Browser checks cover downloads, uploads, schedule persistence, restart notices, cancellation, keyboard activation and narrow layouts in dark, light and Graphite themes.
The final verification passed 474 server tests, 175 web tests, both type checks, the frontend build and the browser flow. Five existing server tests remain skipped.
