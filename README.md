# Staff Action Ledger

A Discord moderation record bot whose only job is preserving administrative actions taken against staff members.

It uses the prefix `.admin` by default and supports official warnings, strikes, suspensions, demotions, and firings. Every new disciplinary case requires a written reason and exactly one attached image or video.

## What is included

- Automatic numbered cases, starting at case 100 by default
- `.admin case 133` full case lookup with attached proof
- `.admin cases @user` chronological staff history
- HR and admin whitelist levels
- Owner IDs stored outside Discord so the bot cannot be permanently locked by its own whitelist
- Append-only SQLite audit ledger
- SHA 256 hash chain verification for audit entries
- Soft removal only, cases can be voided but never physically deleted through the bot
- Separate append-only removed actions ledger
- Local evidence copies on persistent storage
- Private Discord evidence archive mirror
- Evidence SHA 256 fingerprints
- Amendments instead of silent edits
- CSV history exports
- Protected log deletion detection, with best-effort identification through Discord audit logs
- Optional second audit mirror channel, ideally in another private server
- Railway health endpoint at `/health`

## Important limitation

No Discord bot can make information literally undeletable to someone who controls the hosting account, filesystem, database, or Discord server. This project makes records difficult to alter quietly:

1. Original cases cannot be edited or physically deleted by normal bot commands.
2. Removed cases remain in both the case table and a separate removed actions table.
3. Audit records are append-only at the SQLite trigger level.
4. Every audit entry includes the previous entry's hash, so missing or changed entries fail `.admin audit verify`.
5. Evidence is copied to persistent disk and mirrored to a private evidence channel.
6. An optional archive channel can live in a different Discord server.

For the strongest setup, only the business owner should control Railway, GitHub, and the archive server.

## Commands

### Help

```text
.admin help
.admin commands
```

### Create disciplinary cases

Attach exactly one image or video to the same message.

```text
.admin warning @user <reason>
.admin strike @user <reason>
.admin suspension @user <duration> | <reason>
.admin demotion @user <old rank> | <new rank> | <reason>
.admin fired @user <reason>
```

Examples:

```text
.admin warning @Ezra repeatedly ignored the staff conduct policy
.admin suspension @Ezra 7 days | left a scheduled shift without approval
.admin demotion @Ezra senior moderator | moderator | abused administrative permissions
.admin fired @Ezra leaked private staff records
```

### Read records

```text
.admin case 133
.admin cases @user
.admin cases @user all
.admin stats @user
.admin export @user
.admin export @user all
```

`all` includes actions that were later removed or voided.

### Amend or remove

```text
.admin amend 133 <correction or clarification>
.admin remove 133 <reason for voiding the action>
```

An amendment never overwrites the original text. Removing a case marks it as voided and adds a record to the removed actions ledger.

### Configure the bot

```text
.admin setup #hr-commands #audit-log #removed-actions #case-evidence
```

The four channels should be private channels visible only to the appropriate owner, HR, and management roles.

### Manage access

```text
.admin whitelist add @user hr
.admin whitelist add @user admin
.admin whitelist remove @user
.admin whitelist list
```

HR can create, read, amend, and export cases. Admin can also configure channels, manage access, remove cases, and inspect the audit ledger.

### Audit commands

```text
.admin audit recent 10
.admin audit verify
.admin removed 10
.admin status
```

## Discord setup

### 1. Create the application

1. Open the Discord Developer Portal.
2. Select **New Application**.
3. Give the application a name.
4. Open **Bot**, then select **Add Bot** if Discord has not already created one.
5. Reset or copy the bot token. Treat it like a password and never post it or commit it to GitHub.

### 2. Enable the required privileged intent

This bot uses prefix commands, so it must receive message text.

On the application's **Bot** page, enable:

- **Message Content Intent**

The bot does not require Server Members Intent or Presence Intent for its included features.

### 3. Invite the bot

Open **OAuth2**, then **URL Generator**.

Select the scope:

- `bot`

Recommended bot permissions:

- View Channels
- Send Messages
- Embed Links
- Attach Files
- Read Message History
- Manage Messages, used to clean the original evidence command after safely storing it
- View Audit Log, used for best-effort identification when protected log messages are deleted

Open the generated URL, choose your server, and authorize the bot.

### 4. Get your owner user ID

1. In Discord, open **User Settings**, then **Advanced**.
2. Enable **Developer Mode**.
3. Right-click your account and select **Copy User ID**.
4. Put that number in `OWNER_USER_IDS`.

You can list multiple owners with commas:

```env
OWNER_USER_IDS=123456789012345678,987654321098765432
```

## Run locally

### Requirements

- Node.js 22.16.0 or newer
- npm

### Installation

```bash
git clone YOUR_REPOSITORY_URL
cd staff-action-ledger
cp .env.example .env
npm ci
npm start
```

On Windows PowerShell, copy the environment file with:

```powershell
Copy-Item .env.example .env
```

Edit `.env` before starting:

```env
DISCORD_TOKEN=your_real_bot_token
OWNER_USER_IDS=your_discord_user_id
PREFIX=.admin
BOT_TIMEZONE=America/New_York
INITIAL_CASE_NUMBER=100
DATABASE_PATH=./data/staff-ledger.sqlite
EVIDENCE_DIRECTORY=./data/evidence
MAX_EVIDENCE_MB=25
PORT=3000
```

When the console says the bot is logged in, use this command in Discord:

```text
.admin setup #hr-commands #audit-log #removed-actions #case-evidence
```

Then add other HR members:

```text
.admin whitelist add @person hr
.admin whitelist add @manager admin
```

## Keep it online 24/7 with Railway

This project includes a `Dockerfile`, `railway.toml`, and `/health` endpoint.

The bot uses Node.js built-in SQLite, so the Docker build does not need to download or compile a native SQLite package.

### 1. Upload the project to GitHub

Create a private GitHub repository and push this folder. Do not upload `.env`. It is already ignored by `.gitignore`.

### 2. Create the Railway service

1. Create a Railway project.
2. Choose **Deploy from GitHub repo**.
3. Select the private repository.
4. Railway should detect the included Dockerfile and deploy it.

### 3. Add Railway variables

Open the service's **Variables** page and add:

```env
DISCORD_TOKEN=your_real_bot_token
OWNER_USER_IDS=your_discord_user_id
PREFIX=.admin
BOT_TIMEZONE=America/New_York
INITIAL_CASE_NUMBER=100
DATABASE_PATH=/app/data/staff-ledger.sqlite
EVIDENCE_DIRECTORY=/app/data/evidence
MAX_EVIDENCE_MB=25
```

Do not manually set `PORT` on Railway unless you have a specific reason. Railway supplies it to the application.

Optional off-server audit mirror:

```env
ARCHIVE_CHANNEL_ID=the_private_archive_channel_id
```

The bot must be invited to the server containing that channel and must be able to view and send messages there.

### 4. Add persistent storage

SQLite and evidence files must not live only inside Railway's temporary deployment filesystem.

1. Add a Railway volume to the bot service.
2. Mount it at:

```text
/app/data
```

3. Confirm the variables use `/app/data` as shown above.

Without the volume, redeploying can erase the local database and evidence files.

### 5. Health check

The included Railway configuration uses:

```text
/health
```

A healthy response looks similar to:

```json
{
  "ok": true,
  "service": "staff-action-ledger",
  "uptimeSeconds": 1234
}
```

### 6. Verify operation

Check the Railway deployment logs for:

```text
Logged in as YourBotName. Prefix: .admin
```

Then run:

```text
.admin status
.admin audit verify
```

## Backups

A Railway volume protects data across deployments, but it is not a complete backup strategy. Periodically download or copy:

```text
/app/data/staff-ledger.sqlite
/app/data/evidence/
```

For a larger staff organization or multiple bot replicas, move the database to PostgreSQL and move evidence to object storage such as S3 or Cloudflare R2. SQLite is intentionally used here because it is simple and reliable for one bot process.

## Security checklist

- Keep the GitHub repository private.
- Never commit `.env` or the Discord token.
- Give Railway and GitHub access only to trusted owners.
- Use private Discord channels for commands, audit logs, removals, and evidence.
- Do not grant ordinary HR roles permission to delete messages in the archive channels.
- Put `ARCHIVE_CHANNEL_ID` in a separate private server for stronger separation.
- Run `.admin audit verify` regularly.
- Back up the Railway volume.
- Reset the Discord token immediately if it is ever exposed.
