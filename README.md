# Mixdog

[![npm](https://img.shields.io/npm/v/mixdog)](https://www.npmjs.com/package/mixdog)
![Node.js ^22.19.0 || >=24.0.0](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-brightgreen)
![license](https://img.shields.io/badge/license-Apache--2.0-blue)

Mixdog is an AI coding agent for the terminal and the desktop. One agent
runtime powers a terminal UI, a desktop workspace, and a paired browser on
your phone, and it signs in with the model subscriptions and API keys you
already have.

It is built to spend less context on each task: focused tools, a native code
graph, provider-aware caching, and structured compaction keep prompts small.
On Terminal-Bench 2.1, running the same model on both sides, Mixdog scores on
par with Codex CLI and Claude Code at 19–39% lower priced cost
([benchmarks](#benchmarks)).

> **Status:** Mixdog is pre-1.0 and changes quickly. Patch releases ship
> often, and behavior can change between them; the [changelog](CHANGELOG.md)
> lists what each release changed.

## Install

### Desktop app

| Platform | Download |
| --- | --- |
| Windows x64 | [mixdog-desktop-win-x64.exe](https://github.com/tribgames/mixdog/releases/latest/download/mixdog-desktop-win-x64.exe) |
| macOS (Apple silicon) | [mixdog-desktop-mac-arm64.dmg](https://github.com/tribgames/mixdog/releases/latest/download/mixdog-desktop-mac-arm64.dmg) |
| Linux x64 | [mixdog-desktop-linux-x86_64.AppImage](https://github.com/tribgames/mixdog/releases/latest/download/mixdog-desktop-linux-x86_64.AppImage) |
| Linux ARM64 | [mixdog-desktop-linux-arm64.AppImage](https://github.com/tribgames/mixdog/releases/latest/download/mixdog-desktop-linux-arm64.AppImage) |

The desktop builds are not code-signed yet. Windows SmartScreen warns before
the first run, and macOS blocks the first launch until you allow Mixdog under
**System Settings → Privacy & Security**. The app checks this repository's
releases for updates, downloads a new version in the background, and installs
it only when you choose to restart.

### Command line

Requires Node.js 22.19 or later on the 22.x line, or Node.js 24 or later. The
CLI runs on Windows (x64, ARM64), macOS (Apple silicon, Intel), and Linux
(x64, ARM64).

```bash
npm install -g mixdog
mixdog
```

The first run walks you through signing in to a provider, choosing a model,
and setting up a workflow.

### What gets downloaded

`npm install` runs a postinstall step that fetches the native tools for your
platform (code graph, patch, and process spawn) from this repository's GitHub
Releases, and rejects any file whose SHA-256 differs from the digest pinned in
the package. The package also depends on a Mixdog build of
[Ink](https://github.com/vadimdemedes/ink), fetched as a tarball from the same
releases.

Optional features download what they need the first time you use them:

| Feature | Downloads | From |
| --- | --- | --- |
| Memory | PostgreSQL with pgvector | This repository's releases |
| Voice dictation | whisper.cpp server and a Whisper model | This repository's releases, Hugging Face |
| Local Provider | llama.cpp (CUDA build) and GGUF models | ggml-org/llama.cpp releases, Hugging Face |
| Code Tidy | Formatter and linter engines | Each engine's own releases |
| Document rendering | Noto fonts | google/fonts |

Everything in this table except the fonts is checked against a SHA-256 digest
before use. Rendering documents and recalculating workbooks also needs
LibreOffice (or Microsoft Office on Windows); the desktop app's Office setup
can install LibreOffice for you.

## Usage

### Terminal

```bash
mixdog                                                  # start in the current project
mixdog --provider anthropic-oauth --model claude-opus-5 # pick a provider and model
mixdog --workflow <name>                                # start with a workflow active
mixdog --readonly                                       # read-only tools
mixdog --onboarding                                     # run first-time setup again
```

In a session, slash commands cover the rest: `/model`, `/providers`,
`/resume`, `/compact`, `/usage`, `/mcp`, `/skills`, `/doctor`, and more.
`mixdog --help` lists every option and command.

### Headless

`mixdog exec` runs one non-interactive session and exits, for scripts and CI:

```bash
mixdog exec --provider anthropic-oauth --model claude-opus-5 "fix the failing test"
mixdog exec --provider openai-oauth --model gpt-5.6-sol --json "review the current diff"
```

It needs an explicit provider and model, uses a throwaway configuration, and
does not load your memory, saved sessions, skills, MCP servers, or plugins.
Web search stays off unless you pass `--web-search`. Headless exec is not a
sandbox: the shell commands it runs still have network access.

### Desktop

The desktop app runs the same agent runtime and builds a workspace around it:

- Tabs and split panes for parallel sessions, each on its own model
- A Monaco editor with language servers, diffs, and a review of each turn's edits
- Git staging, commits, and branches; GitHub issues, pull requests, Actions, and releases
- Terminals, a file explorer, and project search
- Token usage by provider and model, and quota windows for supported subscriptions
- Visual editors for workflows, agents, schedules, and webhooks

Live sessions carry over between the terminal, the desktop app, and a paired
browser, so you can follow and continue a session from your phone.

## Features

**Coding.** Text and AST search, a native code graph (symbols, references,
calls, and imports) built on tree-sitter and ast-grep, file edits, and
background shell jobs. Code Tidy formats and lints through project or managed
engines and previews every fix before applying it. MCP servers, skills, hooks,
and plugins extend the tool set.

**Long-running work.** Compaction hands the task off and keeps the latest
request when a conversation grows; optional idle-time compaction trims what is
resent after long breaks. Goals track an explicit objective with completion
conditions and a time limit. Optional long-term memory keeps searchable
history apart from the preferences you approve.

**Agents and workflows.** Workflows and agents are Markdown definition packs
(`WORKFLOW.md`, `AGENT.md`). Each session's orchestration mode sets how much
the lead agent delegates, from Solo (no delegation, the default) to Swarm.
Assign models by role so an expensive model only does the work that needs it.

**Beyond code.**

- **Browser Use** drives the desktop app's built-in Chromium for signed-in
  pages, forms, tabs, and downloads, and can import a Chrome profile on
  Windows.
- **Computer Use** operates desktop apps on Windows, macOS, and Linux through
  accessibility data, screenshots, and guarded keyboard and pointer input,
  with an on-screen Stop control.
- **Documents**: create and edit Word, Excel, PowerPoint, and PDF files with
  the built-in portable writer, or through Microsoft Office on Windows.
- **Studio** generates and edits images and short video clips through your
  signed-in providers and keeps them in a local gallery.
- **Voice** dictation runs on a local transcription runtime.

Browser Use and Computer Use are opt-in, and interactive sessions ask before
their first live call by default.

## Providers

- **Account sign-in (OAuth):** OpenAI (ChatGPT/Codex), Anthropic (Claude), xAI (Grok)
- **API keys:** OpenAI, Anthropic, Google Gemini, xAI, DeepSeek, OpenRouter, OpenCode Go
- **Local Provider:** download and run GGUF models inside Mixdog; currently
  Windows x64 with an NVIDIA GPU

Cursor and Antigravity (Gemini) account sign-in stay hidden until you turn
them on under **Settings → Developer**, which warns that using these providers
through OAuth risks account restrictions.

The model picker merges each provider's live catalog with context limits,
pricing, and capability data.

## Benchmarks

Terminal-Bench 2.1: all 89 tasks, scored by the official Harbor verifier.
Each comparison runs the same model on both sides and changes only the
harness. The Mixdog side is a single-model, single-session run with no
sub-agents or helper models.

| Same model | Score | Priced cost | Median final context | Time per trial |
| --- | --- | --- | --- | --- |
| GPT-5.6 Sol xhigh: Mixdog vs Codex CLI (`k=5`) | 385/445 vs 383/445 | $0.476 vs $0.782 per trial (−39%) | 18.5K vs 34.3K tokens | 415s vs 437s |
| Claude Opus 5: Mixdog vs Claude Code (`k=1`) | 79/89 vs 77/89 | $104.29 vs $129.21 per run (−19%) | 27.6K vs 38.2K tokens | 610s vs 708s |

Priced cost values both sides at the same current API list rates; it is not a
subscription charge or an invoice. The numbers measure the source revision
pinned with each run, not every later release. Raw verifier output, usage
snapshots, and the scripts that recompute each figure are in
[`benchmarks/terminal-bench-2.1/`](benchmarks/terminal-bench-2.1/).

## Data and network

- Data lives in `~/.mixdog/data`. Set `MIXDOG_HOME` to move the whole
  `~/.mixdog` directory, or `MIXDOG_DATA_DIR` to move only the data.
- Mixdog sends no analytics, and the desktop app keeps crash dumps on your
  machine.
- Mixdog connects to the model providers you use, the npm registry (update
  checks), this repository's GitHub Releases (native tools, desktop updates,
  and optional runtimes), LiteLLM and models.dev (model prices and limits),
  and the sources listed under [What gets downloaded](#what-gets-downloaded).
- Phone pairing goes through the Mixdog relay, and session traffic through it
  is end-to-end encrypted. Point `MIXDOG_RELAY_URL` at another relay, or set
  it to `0` to turn remote access off.

## Documentation

- [Context efficiency](docs/context-efficiency.md): how Mixdog keeps prompts small
- [Code Tidy](docs/code-tidy.md): engines and rule coverage
- [Git and GitHub](docs/git-github-integration.md): supported operations and permissions
- [Language servers](docs/language-servers.md): editor language support
- [Office runtime](src/runtime/office/README.md): document engines and requirements
- [Testing](docs/testing.md): test lanes and conventions

## Development

```bash
npm install
npm start                        # run the CLI from source
npm test -- src/runtime/memory   # fast test lane, narrowed to a path
npm test -- --changed            # only the tests that changed files reach
npm run test:slow                # *.slow.test.mjs
```

On Windows, narrow `npm test` to a path or `--changed`: an unscoped run
exceeds the command-line length limit. For the desktop app, install the root
dependencies first, then:

```bash
cd apps/desktop
npm install
npm run dev
```

```text
src/           CLI, TUI, agent runtime, workflows, agents, and rules
apps/desktop/  desktop app (Electron)
apps/relay/    remote web app and relay server
native/        Rust tools: code graph, patch, process spawn, Computer Use, browser import
scripts/       build, test, and release scripts
benchmarks/    benchmark harness, results, and raw artifacts
docs/          guides and design notes
```

## License

Apache-2.0; see [LICENSE](LICENSE). Third-party components keep their own
licenses; see [NOTICE.md](NOTICE.md).
