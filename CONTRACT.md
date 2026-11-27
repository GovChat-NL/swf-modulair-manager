# The app contract, version 2 (draft)

This document tells you what an app must contain, so that an organisation can add it to
GovChat. The `govchat` command does the checks.

**Status:** draft of 27 November 2026. Not approved yet.

## The repository of an app

| Part | Required | Function |
|---|---|---|
| `app.yaml` in the top folder | Yes | Tells GovChat what the app is. It is the same for each organisation. |
| `README.md` | Yes | Contains the use case and the short check (see below). |
| A Helm chart | No | Only for an app that needs more than one container, a scheduled job or storage. |

A version is a tag `vX.Y.Z`. The tag is the same as `version` in `app.yaml`. A tag does
not change after it is made.

To start a new app, run `./govchat app new <name>`.

## `app.yaml`

The smallest app:

```yaml
name: time
version: 2.0.0
contract: v2
title: "Datum en tijd"
kern: ">=0.2.0 <1.0.0"
image: docker.io/theo01/mcp-time:0.4.0@sha256:68f2...
args: ["--transport", "stream", "--address", "http://0.0.0.0:8080/mcp"]
```

All fields:

| Field | Required | Function |
|---|---|---|
| `name` | Yes | Lower-case letters, digits and hyphens. It is also the name of the Service and of the tool in the chat. |
| `version` | Yes | A full version, the same as the tag without the `v`. |
| `contract` | Yes | `v2`. |
| `title` | Yes | The name that a user sees. Only letters, digits, spaces, hyphens and apostrophes. |
| `kern` | Yes | The versions of the kern that the app operates with. |
| `description` | No | One sentence for an administrator. |
| `image` | No | The container image of the MCP server, with a fixed version. Use a digest for a release. |
| `command`, `args` | No | The command and the arguments of the container. |
| `port` | No | The port of the server. Default: `8080`. |
| `path` | No | The path of the MCP endpoint. Default: `/mcp`. |
| `mcp` | No | `false` if the app does not give tools to the chat. Default: `true` if there is an image or a chart. |
| `pinned` | No | `true`: each assistant has the tools, and the user sees no menu. Default: `true`. |
| `env` | No | Fixed environment variables. |
| `config` | No | Settings that an organisation gives. See below. |
| `secrets` | No | A list of keys of the Secret with the name of the app. Names only, no values. |
| `egress` | No | `none`: the app cannot connect to other systems. `internet`: the app can connect to the internet on port 443. Default: `none`. |
| `resources` | No | The CPU and memory of the container. |
| `requires` | No | Other apps that are necessary: `{ time: ">=2.0.0 <3.0.0" }`. |
| `assistants` | No | Added assistants, in the `modelSpecs` structure of LibreChat. |
| `chart` | No | A folder in the repository with a Helm chart. Do not use `image` and `chart` together. |

### Settings

```yaml
config:
  API_URL: { required: true, description: "The address of the API." }
  LANGUAGE: { default: "nl", description: "The language of the answers." }
```

The organisation writes the values in `<environment>/apps/<name>/settings.yaml`, below
`config:`. The names are upper-case. For an app with an image, each setting becomes an
environment variable of the container. For an app with a chart, the chart gets the file
as Helm values (`.Values.config.API_URL`).

### Secrets

```yaml
secrets: [API_KEY]
```

The administrator creates the Secret with `API_KEY=... ./govchat secrets --env <environment>`.
The Secret has the name of the app. For an app with an image, each key becomes an
environment variable of the container.

## What the command makes for an app with an image

- A Deployment with one container. The container does not run as root, has a read-only file system, and can write only in `/tmp`.
- A Service with the name of the app.
- A NetworkPolicy. Only the LibreChat pod can connect to the app. The app cannot connect to other systems, unless `egress` is `internet`.
- Each part has the label `govchat.app: <name>`.

## Rules for an app with a chart

The command does not check these rules. The reviewer of the app must check them.

1. The Service has the name of the app. An MCP server uses streamable HTTP. Do not use stdio.
2. Each part has the label `govchat.app: <name>`.
3. There is a NetworkPolicy that permits only LibreChat. A connection to the outside is there only if the use case needs it.
4. The image has a fixed version. The container does not run as root. Do not use `latest`.
5. The app runs in the same namespace as the kern and does not touch the data of other apps.
6. Secrets are in the chart by name only.

The command copies the chart into the deploy repository. Thus the reviewer of the pull
request sees the full chart.

## What an app can add to the chat

Only tools (one MCP server) and assistants. The settings of the kern belong to the kern.
An app cannot change them.

## The README of an app

The README contains:

- **The use case:** for whom, what, and why an app is necessary.
- **A test question** that makes the assistant use the tool, with invented test data.
- **The short check:**

  | Question |
  |---|
  | Does the app process personal data? |
  | Does data go to an external service or to a different language model? |
  | Does the app keep data? |
  | Which Secrets are necessary? |
  | What does the language model see of the app? |
  | Who owns the server? |

## Changes without damage

An app tells which version of the contract it obeys (`contract: v2`). New parts are
optional. A new required part is a new main version of the contract.

## Open points

- `title` and `description` are shown to administrators only in `app list` and in the chat. There is no screen.
- Scheduled jobs and storage are not in `app.yaml`. Use a chart.
- "Off after installation" and "on for some assistants only" are not made. `pinned: false` shows the tool in the menu of the user, but this is not tested.
- A token between LibreChat and the app is not made. The NetworkPolicy is the protection.
