# arklay-bot

A Discord bug-report intake bot for [Arklay](https://github.com/IntelOrca/arklay-rs).

It watches `#report-a-bug`, asks the reporter for the missing details, checks the existing GitHub issues for duplicates, shows a draft, and files the issue only after the reporter confirms.

The bot is deliberately a small state machine with LLM steps, not an autonomous agent. The model conducts the conversation, extracts fields, and judges duplicates. Ordinary code decides when to file, which labels to use, and which GitHub calls to make.

## How it works

1. A new post arrives in the bug channel. In a forum channel, each post is a thread. In a normal text channel, the bot starts a thread from the message.
2. The bot classifies the report and asks one or two short questions at a time. Crash and graphics reports get hardware and log questions. Gameplay/logic reports get room, repro, and save-file questions instead. Enhancements get desired-behavior and motivation questions. It always establishes which game the report is for.
3. When it has enough, it compares the report against the existing issues and shows the closest matches.
4. If the reporter picks an existing issue, the bot links the report there instead of opening a duplicate. If not, it shows a draft.
5. The reporter files, edits, or cancels. Nothing is posted to GitHub before that.
6. The issue URL is posted back in the thread, and the forum tag changes to `filed`.

Users with the configured trusted role (default `umbrella`) can skip the process with a quick report:

```text
\quick No sound plays when navigating between pages in a file.
```

That files the issue directly from the message, skips the Q&A, thread, duplicate check, approval gate, and normal per-user daily limit, and reacts with 👍. In dry-run mode it replies with the `issue.md` instead. Everyone else who types `\quick` still goes through the normal flow. Normal reports get a 👀 reaction on their first message.

The report fields are tailored to Arklay: game and release, Arklay version/commit, OS, GPU, renderer, mods, steps, expected/actual behavior, frequency, logs, screenshots, save files, diagnostics, and other attachments. It asks about mods only when a mod could plausibly be involved. It never asks for `.akpak` files or game assets.

Enhancement requests are accepted. They are labeled `enhancement` instead of `bug` and use a proposed-behavior/why body rather than repro steps and logs.

## Requirements

- Node.js 22 or newer (Node 26 is fine)
- `opencode` installed and logged in, for the default free OpenCode backend
- A Discord application and bot token
- A GitHub App installed on the target repository

## Discord setup

1. Open <https://discord.com/developers/applications> and create an application called `Arklay`.
2. Go to **Bot**, reset/copy the token, and put it in `.env` as `DISCORD_TOKEN=...`. Do not paste the token into chat.
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**.
4. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Manage Threads, Read Message History, Attach Files, Embed Links, Add Reactions
   - Open the generated URL and invite the bot to your server.
5. Create a **forum** channel called `report-a-bug`. Optionally add tags named `needs-info`, `filed`, and `duplicate`; the bot applies them by name. A normal text channel also works, but the bot will create a thread for each message.
6. Start the bot and post a test report.

The bot finds the channel by name. If you have more than one guild or channel with that name, set `guild_id` and `channel_id` in `config.toml`.

## GitHub setup

The bot can file as a GitHub App or as a user PAT. The App is recommended: issues are authored by `arklay-bot[bot]`, tokens are short-lived, and the installation can be limited to one repository.

### GitHub App

1. GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Set a homepage URL, disable the webhook, and choose **Only on this account**.
3. Repository permissions: **Issues: Read and write**, **Metadata: Read-only**.
4. Create the app, note the **App ID**, and generate a private key.
5. Install the app on `IntelOrca/arklay-rs` only.
6. Save the private key outside the repository (the `data/` directory is git-ignored), then set:

```toml
[github]
auth = "app"
app_id = "123456"
private_key_path = "data/arklay-app.pem"
installation_id = ""   # discovered automatically
```

The bot refreshes installation tokens automatically and never stores them on disk.

### Screenshot and save-file uploads

GitHub App tokens cannot use GitHub's `user-attachments` endpoint, so attachments need a user token. The recommended setup is a small public repository used only for attachments:

1. Create a public repository such as `arklay-engine/arklay-bug-attachments`.
2. Create a fine-grained PAT scoped to **that repository only**, with **Contents: Read and write**.
3. Put it in `.env` as `GITHUB_ATTACHMENT_TOKEN=...`.
4. Set:

```toml
[github]
attachment_repo = "arklay-engine/arklay-bug-attachments"
attachment_branch = "main"
```

The bot uploads into `reports/<report-id>/...` and embeds the raw URL in the issue. This supports images, save files, and other binaries.

If you leave `attachment_repo` empty, the bot falls back to GitHub's `user-attachments` endpoint. That works for images but rejects save files. Without any attachment token, files are listed by name and the Discord thread link, and Discord CDN links expire.

### PAT fallback

If you do not want a GitHub App, create a fine-grained PAT with **Issues: Read and write** and **Metadata: Read-only**, put it in `.env` as `GITHUB_TOKEN=...`, and set `github.auth = "token"`. Issues will be authored by the token owner.

For the first real reports, keep `github.dry_run = true` until the drafts look right. Then optionally create a private `#bug-triage` channel, set `discord.triage_channel_id`, and enable `behavior.approval_required` while you calibrate.

The bot only creates issues, comments, and reactions. It never closes, merges, or edits repository settings.

## Configuration

```sh
cp config.example.toml config.toml
cp .env.example .env
# or, to enter the tokens without echoing them:
npm run setup
```

`config.toml` is git-ignored; secrets belong in `.env`.

Important settings:

| Setting | Meaning |
| --- | --- |
| `discord.channel_name` | Channel to watch, default `report-a-bug` |
| `discord.quick_role_name` | Role allowed to use `\quick`, default `umbrella` |
| `discord.quick_role_id` | Optional role ID, takes precedence over the name |
| `github.repo` | Target repository, default `IntelOrca/arklay-rs` |
| `github.auth` | `app` or `token` |
| `github.dry_run` | If true, never writes to GitHub |
| `github.labels` | Always-applied labels; they must already exist |
| `github.bug_label` | Label for bugs, default `bug` |
| `github.enhancement_label` | Label for enhancements, default `enhancement` |
| `github.attachment_token_env` | Env var for the screenshot/save upload token |
| `github.attachment_repo` | Optional public repo for permanent attachments |
| `github.attachment_branch` | Branch in the attachment repo, default `main` |
| `behavior.approval_required` | Require a maintainer click before filing |
| `behavior.max_user_turns` | After this many user messages, file with what it has |
| `behavior.diagnostics_hint` | Optional command to ask for once diagnostics exist |
| `llm.backend` | `opencode-cli` or `openai` |
| `llm.model` | Model for the conversation |
| `llm.dedupe_model` | Model for the duplicate check |

### LLM backends

**`opencode-cli`** (default) uses your local OpenCode login and a free OpenCode Go model:

```toml
[llm]
backend = "opencode-cli"
model = "opencode-go/beam-free"
dedupe_model = "opencode-go/beam-free"
```

The bot generates `data/opencode-config/opencode.json` with two no-tool agents. It runs `opencode run --standalone` in a scratch directory, so the model cannot read the repository or run commands. If `opencode` is not on the service's `PATH`, set `llm.opencode_command` to its absolute path.

**`openai`** uses any OpenAI-compatible `/chat/completions` endpoint:

```toml
[llm]
backend = "openai"
model = "beam-free"
base_url = "https://opencode.ai/inference/go/openai/v1"
api_key_env = "OPENCODE_API_KEY"
```

Put the key in `.env`. To switch providers later, change `base_url`, `model`, and `api_key_env`; no code changes are needed. The endpoint must support chat completions (not the Responses API).

## Run

```sh
npm install
npm run dev
```

For a production-ish local run:

```sh
npm run build
npm start
```

The SQLite database and generated agent config live in `data/`. Back up that directory if you care about in-progress reports.

## Testing

```sh
npm run typecheck
npm test
npm run smoke:llm
npm run smoke:llm -- --dedupe 'No sound plays when changing page in a file'
```

The smoke commands exercise the configured LLM without touching Discord or GitHub. `--dedupe` also fetches the public issue list and runs the duplicate check.

For a full local test, leave `github.dry_run = true`, post a report, answer the questions, and click **Show what would be filed**. The bot posts the exact markdown it would create as `issue.md`.

## Safety notes

- The LLM has no tools. It returns validated JSON; the code performs a fixed allowlist of actions.
- User text is treated as untrusted. The model is told to ignore instructions inside it, and every action is still checked by code.
- The GitHub App should have only Issues and Metadata permissions. The optional attachment token should be fine-grained and scoped to the same repository.
- Discord permissions should be minimal; do not give the bot Administrator.
- The bot never asks for game files, `.akpak` packs, or other copyrighted assets.
- Reporter attribution is off by default. The issue says it came from Discord and was drafted with an AI assistant.
- The bot reads messages in the report threads. Pin the privacy notice or keep the channel rules clear.
- Dry-run is the default. Do not turn it off until you have seen a few drafts.

## Limitations

- Screenshots and save files are uploaded to GitHub only when `GITHUB_ATTACHMENT_TOKEN` is set. Without it, the issue lists the filenames and links to the Discord thread, whose CDN links expire.
- Duplicate detection looks at GitHub issues, not other in-progress Discord reports.
- Issue-closed notifications back into Discord are not implemented.
- There is no slash command; the channel post is the entry point.

## Layout

```text
src/
  index.ts             startup and shutdown
  config.ts            config.toml loading and validation
  db.ts                SQLite report store
  discord/bot.ts       Discord client, events, channel discovery
  discord/flow.ts      intake state machine and actions
  discord/ui.ts        embeds, buttons, modal
  llm/provider.ts      OpenCode CLI and OpenAI-compatible backends
  llm/prompts.ts       system prompts and prompt builders
  llm/schemas.ts       Zod schemas for model output
  github/client.ts     GitHub REST client
  github/app-auth.ts    GitHub App JWT and installation tokens
  github/attachments.ts screenshot/save-file uploads
  github/issue.ts      issue body and duplicate comment rendering
```

## License

MIT. See [LICENSE](LICENSE).
