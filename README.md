> # ⚠️ NOTE: temporary name
> This repository has the name `swf-modulair-manager` because this is a pilot for a modular
> GovChat. Súdwest-Fryslân started the pilot with the approval of GovChat-NL. If the pilot
> is a success and all parties agree, the name can become `GovChat-NL-manager`.

# swf-modulair-manager: the `govchat` command

The `govchat` command writes the files of a GovChat deploy repository. With one command
you add an app, remove an app, or change a version. The command writes files only. It
does not commit and it does not push.

A change goes to the cluster through a pull request. A second person approves the pull
request. The merge is the deployment: Rancher Fleet reads the repository and deploys it.

This is one of four repositories that belong together:

| Repository | Function |
|---|---|
| [`swf-modulair-kern`](https://github.com/GovChat-NL/swf-modulair-kern) | The basic chat. |
| [`swf-modulair-app-time`](https://github.com/GovChat-NL/swf-modulair-app-time) | The trial app, and the example of an app. |
| **`swf-modulair-manager`** | The `govchat` command, and the rules for an app (this repository). |
| [`swf-modulair-deploy-template`](https://github.com/GovChat-NL/swf-modulair-deploy-template) | The start point for the deploy repository of an organisation. |

## Why there is a command

LibreChat reads one configuration file. An app that adds a tool must be in that file in
four places. Helm cannot merge this file. Thus a tool must write it. The `govchat` command
does this, and it does the checks before the change goes to the cluster.

All other files are small and you can read them. You can also write them manually. Then
run `./govchat build` to write the generated files again.

## How to run the command

You need [Node.js](https://nodejs.org) 20 or newer, and `git`. The commands for a cluster
(`secrets`, `verify`, `local`) also need `kubectl`. The command `local` also needs `helm`.

A deploy repository contains the file `govchat`. This file starts the command in a fixed
version. There is no installation step:

```sh
./govchat app list
```

To use a newer version of the command, change the version in the file `govchat` with a
pull request.

## The commands

| Command | Function |
|---|---|
| `./govchat init` | Asks for the values of your organisation and writes the files. |
| `./govchat app list` | Shows the known apps and the installed apps. |
| `./govchat app add <name or address> --env <environment>` | Adds an app, or changes its version. Option: `--version v1.2.3`. |
| `./govchat app remove <name> --env <environment>` | Removes an app. |
| `./govchat app new <name>` | Makes a new app from the example. |
| `./govchat kern set <version> --env <environment>` | Sets the version of the kern. Use `latest` for the newest version. |
| `./govchat build` | Writes the generated files again. |
| `./govchat check` | Fails if the generated files are not current. Use it in the pull request check. |
| `./govchat promote` | Copies the versions from `acceptatie` to `productie`. Options: `--from`, `--to`. |
| `./govchat branding` | Writes `shared/branding.yaml` from the files in `branding/`. |
| `./govchat secrets --env <environment>` | Creates the Secrets in the cluster. Existing Secrets do not change. |
| `./govchat verify --env <environment>` | Checks that the kern and the apps operate in the cluster. |
| `./govchat local up` | Deploys the local environment to a test cluster on your computer. |
| `./govchat local down` | Deletes the local environment from the test cluster. |

General options: `--repo <folder>` (default: the current folder) and `--context <name>`
(the kubectl context; default: the current context).

## The files in a deploy repository

```
govchat                        starts the command in a fixed version
govchat.yaml                   the environments and the permitted sources
shared/kern.yaml               settings of the kern for all environments
shared/branding.yaml           the logo and the icons (generated from branding/)
acceptatie/
  kern/
    kern.yaml                  copy from the kern repository: what the kern is
    kern-values.yaml           copy from the kern repository: the settings of the kern
    settings.yaml              settings for this environment (web address, ingress)
    generated.yaml             GENERATED: the LibreChat configuration with the apps
    fleet.yaml                 GENERATED: tells Fleet which chart and which files to use
  apps/
    time/
      app.yaml                 copy from the app repository: what the app is
      settings.yaml            settings of the app for this environment (if the app has settings)
      manifests.yaml           GENERATED: Deployment, Service and NetworkPolicy
      fleet.yaml               GENERATED
productie/
  ... the same
```

- A folder in `apps/` means that the app is installed. No folder means no app.
- Each copy contains the address, the version and the commit of its source.
- The command writes the files with `GENERATED` in the first line. Do not edit these files.
- Fleet reads these files directly. There is no other step between the repository and the cluster.

## Procedures

### Add an app

1. Add the app:
   ```sh
   ./govchat app add time --env acceptatie
   ```
2. If the command shows settings, write them in `acceptatie/apps/<name>/settings.yaml`. Then run `./govchat build`.
3. If the command shows Secrets, create them: `KEY=... ./govchat secrets --env acceptatie`.
4. Commit on a branch and open a pull request. A second person merges.
5. After Fleet completes the deployment, run `./govchat verify --env acceptatie`.

### Move a version to production

1. Run `./govchat promote`.
2. Write the settings for `productie`, if the command shows some.
3. Commit on a branch and open a second pull request. This merge is the release.

### Remove an app

1. Run `./govchat app remove time --env acceptatie`.
2. Commit on a branch and open a pull request.

Fleet deletes all parts of the app. The assistant does not have the tool anymore.

### Make a new app

1. Run `./govchat app new my-app`. The command makes a folder with an example server.
2. Obey the instructions in the `README.md` of the new folder.

An app can be one file, `app.yaml`. A more complex app can bring its own Helm chart.
The rules are in [CONTRACT.md](CONTRACT.md).

## The checks

The command stops with an error message in these conditions:

- An address is not in `allowedSources` of `govchat.yaml`.
- A version is not a full version (`v1.2.3`), or the tag is different from the version in the file.
- A folder on the disk is used as a source in an environment that is not local.
- An app obeys a different contract, or does not operate with the kern of the environment.
- A necessary app is missing, has the incorrect version, or apps need each other in a circle.
- Two apps give an assistant with the same name.
- A required setting is empty, or a setting is not known to the app.
- The title of an app contains characters with which LibreChat does not start.
- An image has no fixed version.
- The settings of the organisation try to replace `librechat.configYamlContent`. This part belongs to the kern.

## Rancher Fleet

Make one `GitRepo` for each environment. Each `GitRepo` points to the folder of that
environment:

```yaml
apiVersion: fleet.cattle.io/v1alpha1
kind: GitRepo
metadata:
  name: govchat-acceptatie
  namespace: fleet-local          # the Fleet workspace of the cluster
spec:
  repo: https://gitea.example.nl/<organisation>/govchat-deploy.git
  branch: main
  paths: [acceptatie]
```

Fleet deploys the apps first and then the chat, because the chat connects to the tools
when it starts. When the configuration changes, the chat starts again automatically.

## Tests

Run the automatic tests with `npm test`. They use Git repositories in a temporary folder.
They do not need a network or a cluster.

These tests were done manually on 27 November 2026, on a local cluster (kind, arm64) with
kern 0.2.0 (LibreChat chart 3.2.1, LibreChat v0.8.9), the replacement model and the
MongoDB from the kern:

| Test | Result |
|---|---|
| `local up` with the kern and `time`, then `verify` | OK. LibreChat gets 5 tools from `time`. |
| `app new`, build the image, `app add`, `local up`, `verify` | OK. LibreChat gets the tool of the example server. |
| `app remove time`, `local up`, `verify` | OK. No parts of `time` stay in the cluster. |
| Fleet 0.13.18 with Gitea 1.22: two environments from one repository on one cluster | OK. Fleet deploys the app before the chat. |
| Remove an app in `acceptatie` with a commit | OK. Fleet deletes the app. The chat starts again. `productie` does not change. |
| An app with its own chart and a setting, then `promote` | OK in the two environments. |
| The same repository after an upgrade to Fleet 0.17.0, with a new commit | OK. |

## Not tested and not available

- **A conversation with a tool call.** The replacement model cannot call tools. A test with a real model is necessary.
- **The access checks of `verify` from the outside** (login refused without the account of the organisation). They need a real web address.
- **Rancher.** The tests used Fleet without the Rancher screen.
- **A private Git repository in Fleet.** The test repository was public in the test cluster.
- **The check in a pull request on Gitea.** The workflow file is there. It needs Gitea Actions with a runner.
- **A screen.** There is only the command line. A screen can call the same commands later.
- **LiteLLM.** If there is more than one model, the chat must use LiteLLM. This is not made.
- **"Off after installation".** An installed app is on for all users.
- **Scheduled jobs and storage in `app.yaml`.** An app that needs them must bring a chart.

## Version 0.1.0

Version 0.1.0 was the app manager (`manager.js`, with `stacks/`, `deploy/` and
`stack.lock`). Version 0.2.0 replaces it. The two are not compatible.

## Origin

Written on 27 November 2026. The rules to add an MCP server to LibreChat come from
`admin/server.js` of the branch `swf/modulairKern` of `GovChat-NL/GovChat-NL`, commit
`7e2474d`. The licence is not chosen yet. The proposal is EUPL-1.2. The maintainers of
GovChat-NL make the decision.
