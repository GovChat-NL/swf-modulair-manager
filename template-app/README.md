# __NAME__

An app for GovChat. This app adds tools to the chat.

## Use case

- **For whom:** (who uses the app?)
- **What:** (what can the assistant do with the app?)
- **Why an app:** (why is the language model alone not sufficient?)

Test question: "(a question that makes the assistant use the tool)"

## Short check

| Question | Answer |
|---|---|
| Does the app process personal data? | |
| Does data go to an external service or to a different language model? | |
| Does the app keep data? | |
| Which Secrets are necessary? | |
| What does the language model see of the app? | |
| Who owns the server? | |

## The files

| File | Function |
|---|---|
| `app.yaml` | Tells GovChat what the app is. |
| `server.js` | The MCP server. It has one example tool. |
| `Dockerfile` | Makes the container image. |

## Try the app on your computer

You need Docker, a local test cluster (kind, k3d or Rancher Desktop) and a GovChat deploy
repository with a local environment.

1. Build the image:
   ```sh
   docker build -t __NAME__:0.1.0 .
   ```
2. Give the image to the test cluster. For kind:
   ```sh
   kind load docker-image __NAME__:0.1.0
   ```
3. In the deploy repository, add the app from this folder and start the environment:
   ```sh
   ./govchat app add ../__NAME__ --env lokaal
   ./govchat local up
   ./govchat verify --env lokaal
   ```

After a change of `server.js`, increase the version in `app.yaml` and in the image tag.
Then do the steps again.

## Release a version

1. Push the image to a registry. Put the full address with the digest in `app.yaml`:
   `image: registry.example.nl/__NAME__:0.1.0@sha256:...`
2. Make sure that `version` in `app.yaml` is correct.
3. Commit, and make a tag with the same version: `git tag v0.1.0 && git push --tags`.
4. An organisation adds the app with:
   `./govchat app add https://<address of this repository> --env acceptatie`
