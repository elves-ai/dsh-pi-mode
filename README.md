# dsh-pi-mode

[中文](README.zh.md) | English

A community Pi-inspired coding mode for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a short prompt, essential tools first, and progressive discovery for everything else.

## Requirements

Minimum versions: **DSH v0.2.0-rc.1** and **Node.js 24.9**. The DSH requirement is a lower bound, with no upper limit or fixed-version restriction.

The bundle includes its own progressive executor. It does not require the unpublished `@deepseek-ai/dsh-tool-executor-progressive` package or any changes to the Harness source tree.

## Install

```sh
dsh plugin --profile web add github:elves-ai/dsh-pi-mode
```

Open a **new task** and select **Pi mode (plugin)**. If DSH reports that a restart is required, restart it first. Existing tasks retain their preset revision. Installing the bundle does not change your default mode or Standard mode.

To install a local checkout, use its absolute path:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-pi-mode
```

Remove it with:

```sh
dsh plugin --profile web remove @elves-ai/dsh-pi-mode
```

The repository includes ready-to-run JavaScript in [dist](dist). Git and local installs need no compiler, `prepare` hook, or installation build-script approval. This repository is the distribution source; no npm publication is required.

## Behavior

The first model request declares nine tools:

- `read`, `read_image`, `edit`, `write`
- `bash` on POSIX, or `pwsh` on Windows
- `skill`, `working_directory`, `ask_user_question`, `tool_search`

`ask_user_question` is immediately callable, and the prompt directs clarifications, choices, and confirmations through it. In Web, this uses the existing question UI rather than a plain-text question.

Other registered tools, including file search, web access, and file delivery, are discovered with `tool_search({ query })`. Search returns names and short descriptions, not parameter schemas. Matching schemas enter the **next model request**. Calls to undiscovered tools, or to tools just found in the same response, are rejected. Repeating a query discovers further matches.

Project instructions remain enabled. Skill descriptions are capped at 160 Unicode code points; skill bodies load on demand. Optional runtime context is omitted, while the current working directory remains available. Automatic compaction and `/compact` are retained. Shell commands run in the foreground; this preset does not add background-job tools.

Discovery remains subject to the current scope, tool conditions, restrictions, guards, sandbox, and approval policy. It grants no additional permissions. Discovered names are reconstructed from successful logged search results after resume or fork; one task's discovery does not activate tools in another task.

## Configuration

The [bundle patch](cordis.patch.yml) owns preset `pi-mode`, Loader row `preset-pi-mode`, and its `progressive-tools` child. The separate preset ID permits installation alongside a built-in Pi preset without replacing it.

| Executor option | Bundle value | Meaning |
| --- | --- | --- |
| `eagerTools` | Eight explicit names, plus implicit `tool_search` | Initially declared tools |
| `maxSearchResults` | `5` | Maximum matches activated per search |
| `descriptionMaxLength` | `160` | Maximum description code points, including a truncation ellipsis |
| `maxParallelToolCalls` | `10` | Concurrency-safe call limit unless the Host supplies a batch override |

The shell name depends on the operating system. Unknown eager tool names fail when declarations are first assembled. The executor can be mounted separately through the package's root export, but only one executor may occupy a scope.

## Context costs and limitations

Initial requests omit deferred tool schemas. Discovery adds a request before the first use of a deferred tool, and growing declarations may reduce provider prompt-cache reuse. The short persona stays fixed; loaded skills append to history. Project instructions and the skill catalog still contribute to context size.

Search is deterministic keyword matching, not semantic retrieval. Activation records names, so a replacement with the same name remains discovered but still passes current admission checks. Unlogged searches do not create restorable activations. A model can still ignore instructions; the package tests the tool and question flow, not a guarantee that every model always chooses the right action.

The Host supplies Cordis, tool execution, scope, session projections, Schemastery, and Zod as optional peers. They are required at runtime; “optional” prevents package managers from installing conflicting copies. This bundle does not patch those libraries. Keep the Host and its schema libraries updated, and review [upstream security advisories](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).

## Develop and test

Start with an already built DSH source checkout that meets the minimum requirement. Use that checkout's own installation and build instructions first.

```sh
npm ci --ignore-scripts --omit=peer
npm run dev:link -- /absolute/path/to/deepseek-harness
npm run check
```

`dev:link` links the checkout's Host packages into this project's development dependencies. It records the local path in ignored `.dsh-dev.json`; it does not edit any DSH profile. Zod is linked from the Host's session-projection package so both runtime schemas and TypeScript use the same version. Re-run linking after a clean dependency installation.

`check` compiles the executor, checks source and test types, runs the tests, and verifies the packed file list. Run `npm run test:install` to install both a packed tarball and a linked checkout into temporary DSH homes, run the question → discovery → file-search flow through the built CLI, and remove the plugin. The tests exercise the real Harness registry, pipeline, loop, and Loader; scripted model responses and human answers replace nondeterministic input only. Rebuild and commit `dist` whenever source changes, so Git installs remain script-free.

The independent projection key is `elves-ai/dsh-pi-mode/activation`. Activation metadata retains `progressiveToolActivation`, allowing the same successful search-result format without sharing the built-in executor's projection registration.

## License and credits

[MIT](LICENSE). See [NOTICE](NOTICE) for the DeepSeek Harness attribution, original icon license, and Pi design inspiration. This is an elves-ai community plugin, not an official DeepSeek or Pi release.
