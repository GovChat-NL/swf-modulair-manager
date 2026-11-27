'use strict';
// The commands. They change files in the deploy repository. Only "secrets", "local" and
// "verify" speak to a cluster.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { execFileSync, spawnSync } = require('node:child_process');
const YAML = require('yaml');
const semver = require('semver');
const core = require('./core');

const { Fail, fail, need, exists, readText, readYaml } = core;
const TOOL_DIR = path.join(__dirname, '..');
const say = (text = '') => console.log(text);

// ---- sources: a Git address with a version, or a folder on the disk -----------------

const isLocal = (ref) => /^(\.|\/|~)/.test(ref);
const VERSION = /^v\d+\.\d+\.\d+$/;

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    fail(`git ${args[0]} failed.\n${String(error.stderr ?? error.message).trim()}`);
  }
}

function latestVersion(url) {
  const tags = git(['ls-remote', '--tags', '--refs', url]).split('\n')
    .map((line) => line.split('refs/tags/')[1]).filter((tag) => tag && VERSION.test(tag));
  need(tags.length, `${url} has no version tags (example: v1.0.0).`);
  return tags.sort((a, b) => semver.rcompare(a, b))[0];
}

// Gives { dir, url, version, commit } and a function to remove the temporary folder.
function fetchSource(root, repo, env, ref, version) {
  if (isLocal(ref)) {
    need(env.local, `A folder on the disk is only permitted in a local environment ("local: true" in govchat.yaml). ${env.name} is not local.`);
    const dir = path.resolve(root, ref.replace(/^~/, os.homedir()));
    need(exists(dir), `The folder ${dir} does not exist.`);
    return { dir, url: ref, version: null, commit: 'local', done: () => {} };
  }
  need(repo.allowedSources.some((prefix) => ref.startsWith(prefix)),
    `${ref} is not in "allowedSources" of govchat.yaml. Add the address there first, with a pull request.`);
  const tag = version ? (version.startsWith('v') ? version : `v${version}`) : latestVersion(ref);
  need(VERSION.test(tag), `"${version}" is not a full version. Example: v1.2.3.`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'govchat-'));
  const done = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    git(['clone', '--quiet', '--depth', '1', '--branch', tag, ref, dir]);
    return { dir, url: ref, version: tag, commit: git(['-C', dir, 'rev-parse', 'HEAD']), done };
  } catch (error) {
    done();
    throw error;
  }
}

// The copy of kern.yaml or app.yaml, with a "source" block that records the origin.
function record(text, source, command) {
  const doc = YAML.parseDocument(text);
  doc.set('source', doc.createNode({ url: source.url, ...(source.version && { version: source.version }), commit: source.commit }));
  doc.commentBefore = ` Copy from ${source.url}${source.version ? ` ${source.version}` : ''}. Do not edit.\n To change the version: ${command}`;
  return doc.toString({ lineWidth: 0 });
}

function checkTag(manifest, source, file) {
  if (source.version) need(`v${manifest.version}` === source.version, `${source.url}: the tag is ${source.version}, but ${file} contains version ${manifest.version}.`);
}

// ---- build and check ----------------------------------------------------------------

function exampleValues(result) {
  if (result.env.local) return [];
  return Object.keys(result.kern.config).filter((key) => /example|00000000-0000/.test(String(core.lookup(result.kernSettings, key) ?? '')));
}

function buildEnv(root, repo, envName, { quiet } = {}) {
  const result = core.build(root, repo, envName);
  core.write(root, result);
  if (!quiet) {
    say(`${envName}: kern ${result.kern.version}${result.apps.map((app) => `, ${app.name} ${app.version}`).join('')}.`);
    for (const key of exampleValues(result)) say(`  NOTE: ${key} is an example value. Change it before you deploy.`);
  }
  return result;
}

const envNames = (repo, envName) => (envName ? [core.envOf(repo, envName).name] : Object.keys(repo.environments));
const hasKern = (root, envName) => exists(path.join(root, envName, 'kern', 'kern.yaml'));

function build(root, { env }) {
  const repo = core.loadRepo(root);
  for (const name of envNames(repo, env)) {
    if (!env && !hasKern(root, name)) { say(`${name}: no kern, skipped.`); continue; }
    buildEnv(root, repo, name);
  }
  say('The generated files are written. Nothing is pushed. Next: git diff, commit on a branch, open a pull request.');
}

function check(root, { env }) {
  const repo = core.loadRepo(root);
  let bad = false;
  for (const name of envNames(repo, env)) {
    if (!env && !hasKern(root, name)) { say(`${name}: no kern, skipped.`); continue; }
    const result = core.build(root, repo, name);
    const changed = core.different(root, result);
    if (changed.length) {
      bad = true;
      console.error(`${name}: the generated files are not current: ${changed.join(', ')}`);
    } else {
      say(`${name}: OK. kern ${result.kern.version}${result.apps.map((app) => `, ${app.name} ${app.version}`).join('')}.`);
    }
    for (const key of exampleValues(result)) say(`  NOTE: ${key} is an example value.`);
  }
  need(!bad, 'Run ./govchat build and commit the result.');
}

// ---- kern ---------------------------------------------------------------------------

function kernSet(root, { env: envName, source: sourceUrl, noBuild }, ref) {
  const repo = core.loadRepo(root);
  const env = core.envOf(repo, envName);
  const local = ref && isLocal(ref);
  const url = local ? ref : (sourceUrl ?? repo.kern);
  need(url, 'govchat.yaml: "kern" (the address of the kern repository) is missing.');
  const source = fetchSource(root, repo, env, url, local || ref === 'latest' ? undefined : ref);
  try {
    const file = path.join(source.dir, 'kern.yaml');
    need(exists(file), `${url}: kern.yaml is missing.`);
    const kern = core.checkKern(readYaml(file), `${url} (kern.yaml)`);
    checkTag(kern, source, 'kern.yaml');
    const values = path.join(source.dir, kern.values);
    need(exists(values), `${url}: ${kern.values} is missing.`);
    const dir = path.join(root, env.name, 'kern');
    fs.mkdirSync(dir, { recursive: true });
    const command = `./govchat kern set <version> --env ${env.name}`;
    fs.writeFileSync(path.join(dir, 'kern.yaml'), record(readText(file), source, command));
    fs.writeFileSync(path.join(dir, 'kern-values.yaml'),
      `# Copy from ${source.url}${source.version ? ` ${source.version}` : ''}. Do not edit.\n# To change the version: ${command}\n${readText(values)}`);
    const services = path.join(dir, 'local-services.yaml');
    fs.rmSync(services, { force: true });
    if (env.local && kern.localServices) fs.copyFileSync(path.join(source.dir, kern.localServices), services);
    if (!exists(path.join(dir, 'settings.yaml'))) {
      fs.writeFileSync(path.join(dir, 'settings.yaml'), `# The settings of the kern for ${env.name} only. You write this file.\n# Settings for all environments go in shared/kern.yaml.\n{}\n`);
    }
  } finally {
    source.done();
  }
  if (noBuild) return;
  buildEnv(root, repo, env.name);
  say(`The kern of ${env.name} is set. Next: git diff, commit on a branch, open a pull request.`);
}

// ---- apps ---------------------------------------------------------------------------

const catalog = () => readYaml(path.join(TOOL_DIR, 'apps.yaml'));

function appList(root) {
  const repo = core.loadRepo(root);
  const installed = {};
  for (const env of Object.keys(repo.environments)) {
    const dir = path.join(root, env, 'apps');
    for (const name of exists(dir) ? fs.readdirSync(dir) : []) {
      const file = path.join(dir, name, 'app.yaml');
      if (exists(file)) (installed[name] = installed[name] ?? []).push(`${env} ${readYaml(file).version}`);
    }
  }
  const known = catalog();
  say('Known apps:');
  for (const [name, app] of Object.entries(known)) say(`  ${name.padEnd(16)} ${app.description}\n  ${''.padEnd(16)} ${app.url}`);
  say('\nInstalled:');
  const names = Object.keys(installed).sort();
  if (!names.length) say('  none');
  for (const name of names) say(`  ${name.padEnd(16)} ${installed[name].join(', ')}`);
  say('\nAdd an app:  ./govchat app add <name or address> --env <environment>');
}

function settingsTemplate(app, envName) {
  const lines = [`# The settings of the app ${app.name} for ${envName}. You write this file.`, 'config:'];
  for (const [key, rule] of Object.entries(app.config)) {
    const note = [rule?.required ? 'REQUIRED.' : '', rule?.description ?? ''].filter(Boolean).join(' ');
    lines.push(`  ${key}: ${JSON.stringify(String(rule?.default ?? ''))}${note ? `   # ${note}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

function appAdd(root, { env: envName, version }, ref) {
  need(ref, 'Give the name, the address or the folder of the app. Example: ./govchat app add time --env acceptatie');
  const repo = core.loadRepo(root);
  const env = core.envOf(repo, envName);
  need(hasKern(root, env.name), `${env.name}: there is no kern. Run: ./govchat kern set latest --env ${env.name}`);
  let url = ref;
  if (!isLocal(ref) && !/^[a-z+]+:\/\//.test(ref)) {
    const known = catalog()[ref];
    need(known, `The app "${ref}" is not in the list of known apps. Run ./govchat app list, or give the full address.`);
    url = known.url;
  }
  const source = fetchSource(root, repo, env, url, version);
  let app;
  try {
    const file = path.join(source.dir, 'app.yaml');
    need(exists(file), `${url}: app.yaml is missing.`);
    app = core.checkApp(readYaml(file), `${url} (app.yaml)`);
    checkTag(app, source, 'app.yaml');
    const dir = path.join(root, env.name, 'apps', app.name);
    const update = exists(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'app.yaml'), record(readText(file), source, `./govchat app add ${ref} --version <version> --env ${env.name}`));
    fs.rmSync(path.join(dir, 'chart'), { recursive: true, force: true });
    if (app.chart) {
      need(exists(path.join(source.dir, app.chart, 'Chart.yaml')), `${url}: the chart folder "${app.chart}" has no Chart.yaml.`);
      fs.cpSync(path.join(source.dir, app.chart), path.join(dir, 'chart'), { recursive: true });
    }
    if (Object.keys(app.config).length && !exists(path.join(dir, 'settings.yaml'))) {
      fs.writeFileSync(path.join(dir, 'settings.yaml'), settingsTemplate(app, env.name));
    }
    say(`${update ? 'Updated' : 'Added'}: ${app.name} ${app.version} in ${env.name}.`);
  } finally {
    source.done();
  }
  try {
    buildEnv(root, repo, env.name);
  } catch (error) {
    if (!(error instanceof Fail)) throw error;
    say(`\nNOT READY: ${error.message}\nCorrect this. Then run: ./govchat build --env ${env.name}`);
  }
  if (app.secrets.length) {
    say(`\nThis app needs the Secret "${app.name}" in the cluster, with: ${app.secrets.join(', ')}.`);
    say(`Create it:  ${app.secrets.map((key) => `${key}=...`).join(' ')} ./govchat secrets --env ${env.name}`);
  }
  say('\nNext: git diff, commit on a branch, open a pull request.');
}

function appRemove(root, { env: envName }, name) {
  const repo = core.loadRepo(root);
  const env = core.envOf(repo, envName);
  const dir = path.join(root, env.name, 'apps', name ?? '');
  need(name && exists(path.join(dir, 'app.yaml')), `The app "${name ?? ''}" is not installed in ${env.name}.`);
  const secrets = readYaml(path.join(dir, 'app.yaml')).secrets ?? [];
  fs.rmSync(dir, { recursive: true, force: true });
  say(`Removed: ${name} from ${env.name}.`);
  buildEnv(root, repo, env.name);
  if (secrets.length) say(`After the deployment, delete the Secret:  kubectl -n ${env.namespace} delete secret ${name}`);
  say('Next: git diff, commit on a branch, open a pull request.');
}

function appNew(root, { dir: target }, name) {
  need(name && core.NAME.test(name), 'Give a name with lower-case letters, digits and hyphens. Example: ./govchat app new my-app');
  const dir = path.resolve(root, target ?? name);
  need(!exists(dir), `The folder ${dir} is already there.`);
  const from = path.join(TOOL_DIR, 'template-app');
  fs.mkdirSync(dir, { recursive: true });
  for (const file of fs.readdirSync(from)) {
    fs.writeFileSync(path.join(dir, file.replace(/^dot-/, '.')), readText(path.join(from, file)).replaceAll('__NAME__', name));
  }
  say(`The new app is in ${dir}.\nRead ${path.join(dir, 'README.md')} for the next steps.`);
}

// ---- promote ------------------------------------------------------------------------

function promote(root, { from = 'acceptatie', to = 'productie' }) {
  const repo = core.loadRepo(root);
  const source = core.loadEnv(root, repo, core.envOf(repo, from));
  const target = core.envOf(repo, to);
  need(!source.apps.some((app) => app.source?.commit === 'local') && source.kern.source?.commit !== 'local',
    `${from} contains a part from a folder on the disk. Only versions can go to ${to}.`);
  const before = hasKern(root, to) ? core.loadEnv(root, repo, target) : { kern: null, apps: [] };
  const copy = (...parts) => {
    const file = path.join(root, from, ...parts);
    fs.mkdirSync(path.dirname(path.join(root, to, ...parts)), { recursive: true });
    fs.cpSync(file, path.join(root, to, ...parts), { recursive: true });
  };
  const retarget = (file) => fs.writeFileSync(file, readText(file).replaceAll(`--env ${from}`, `--env ${to}`));
  copy('kern', 'kern.yaml');
  copy('kern', 'kern-values.yaml');
  for (const name of ['kern.yaml', 'kern-values.yaml']) retarget(path.join(root, to, 'kern', name));
  const settings = path.join(root, to, 'kern', 'settings.yaml');
  if (!exists(settings)) fs.writeFileSync(settings, `# The settings of the kern for ${to} only. You write this file.\n{}\n`);
  for (const app of source.apps) {
    fs.rmSync(path.join(root, to, 'apps', app.name, 'chart'), { recursive: true, force: true });
    copy('apps', app.name, 'app.yaml');
    retarget(path.join(root, to, 'apps', app.name, 'app.yaml'));
    if (app.chart) copy('apps', app.name, 'chart');
    const own = path.join(root, to, 'apps', app.name, 'settings.yaml');
    if (Object.keys(app.config).length && !exists(own)) fs.writeFileSync(own, settingsTemplate(app, to));
  }
  for (const app of before.apps) {
    if (!source.apps.some((other) => other.name === app.name)) fs.rmSync(path.join(root, to, 'apps', app.name), { recursive: true, force: true });
  }
  const line = (name, old, now) => say(`  ${name.padEnd(16)} ${old ?? '-'} -> ${now ?? 'removed'}`);
  say(`${from} -> ${to}:`);
  line('kern', before.kern?.version, source.kern.version);
  for (const name of [...new Set([...before.apps, ...source.apps].map((app) => app.name))].sort()) {
    line(name, before.apps.find((app) => app.name === name)?.version, source.apps.find((app) => app.name === name)?.version);
  }
  try {
    buildEnv(root, repo, to, { quiet: true });
  } catch (error) {
    if (!(error instanceof Fail)) throw error;
    say(`\nNOT READY: ${error.message}\nCorrect this. Then run: ./govchat build --env ${to}`);
  }
  say('Next: git diff, commit on a branch, open a pull request.');
}

// ---- branding -----------------------------------------------------------------------

function branding(root) {
  const files = ['logo.svg', 'favicon-16x16.png', 'favicon-32x32.png', 'apple-touch-icon-180x180.png'];
  const data = files.map((file) => {
    const at = path.join(root, 'branding', file);
    need(exists(at) && fs.statSync(at).size, `branding/${file} is missing or empty.`);
    return fs.readFileSync(at);
  });
  const total = data.reduce((sum, part) => sum + part.length, 0);
  // Helm keeps the values in one Secret of 1 MiB maximum. Thus the images must be small.
  need(total <= 250000, `The files in branding/ are ${total} bytes together. The limit is 250000.`);
  const lines = [
    '# GENERATED by the govchat command from the files in branding/. Do not edit.',
    '# To change the logo: replace a file in branding/ and run: ./govchat branding',
    '',
    'volumes:',
    '  - name: branding',
    '    configMap:',
    '      name: librechat-librechat-branding',
    '',
    'volumeMounts:',
    ...files.map((file) => `  - { name: branding, mountPath: /app/client/dist/assets/${file}, subPath: ${file}, readOnly: true }`),
    '',
    '# Changes when a file changes. Then the pod starts again with the new files.',
    'podAnnotations:',
    `  govchat/branding: "${crypto.createHash('sha256').update(Buffer.concat(data)).digest('hex').slice(0, 16)}"`,
    '',
    'additionalConfigMaps:',
    '  branding:',
    '    binaryData:',
    ...files.map((file, index) => `      ${file}: ${data[index].toString('base64')}`),
  ];
  fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
  fs.writeFileSync(path.join(root, 'shared', 'branding.yaml'), `${lines.join('\n')}\n`);
  say(`shared/branding.yaml is written (${total} bytes of images). Next: ./govchat build`);
}

// ---- init ---------------------------------------------------------------------------

function setIn(file, keys, value) {
  const doc = exists(file) ? YAML.parseDocument(readText(file)) : new YAML.Document({});
  if (!YAML.isMap(doc.contents)) doc.contents = doc.createNode({});
  doc.setIn(keys, value);
  fs.writeFileSync(file, doc.toString({ lineWidth: 0 }));
}

async function init(root) {
  const repo = core.loadRepo(root);
  const lines = readline.createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const ask = async (question, current) => {
    process.stdout.write(`${question}${current ? ` [${current}]` : ''}: `);
    const { value, done } = await lines.next();
    if (done || !process.stdin.isTTY) process.stdout.write('\n');
    return (value ?? '').trim() || current || '';
  };
  for (const name of Object.keys(repo.environments)) {
    if (!hasKern(root, name)) kernSet(root, { env: name, noBuild: true }, 'latest');
  }
  const remote = Object.keys(repo.environments).filter((name) => !repo.environments[name].local);
  say('\nGive the values of your organisation. Press Enter to keep the value between [ ].\n');
  for (const name of remote) {
    const file = path.join(root, name, 'kern', 'settings.yaml');
    const current = core.lookup(exists(file) ? readYaml(file) : {}, 'librechat.configEnv.DOMAIN_CLIENT');
    const address = (await ask(`Web address of ${name} (example: https://govchat.example.nl)`, current)).replace(/\/+$/, '');
    if (!address) continue;
    need(/^https?:\/\/[^/]+$/.test(address), `"${address}" is not a web address. Example: https://govchat.example.nl`);
    const host = new URL(address).host;
    setIn(file, ['librechat', 'configEnv', 'DOMAIN_CLIENT'], address);
    setIn(file, ['librechat', 'configEnv', 'DOMAIN_SERVER'], address);
    const settings = readYaml(file);
    if (settings.ingress?.hosts?.length) setIn(file, ['ingress', 'hosts', 0, 'host'], host);
    if (settings.ingress?.tls?.length) setIn(file, ['ingress', 'tls', 0, 'hosts'], [host]);
  }
  const kernEnv = remote.find((name) => hasKern(root, name));
  if (kernEnv) {
    const kern = readYaml(path.join(root, kernEnv, 'kern', 'kern.yaml'));
    const shared = path.join(root, 'shared', 'kern.yaml');
    for (const [key, rule] of Object.entries(kern.config ?? {})) {
      if (/\.DOMAIN_(CLIENT|SERVER)$/.test(key)) continue;
      const current = core.lookup(exists(shared) ? readYaml(shared) : {}, key);
      const value = await ask(`${rule?.description ?? key}`, current);
      if (value) setIn(shared, key.split('.'), value);
    }
  }
  say();
  for (const name of Object.keys(repo.environments)) {
    try {
      buildEnv(root, repo, name);
    } catch (error) {
      if (!(error instanceof Fail)) throw error;
      say(`${name}: NOT READY: ${error.message}`);
    }
  }
  say('\nReady. Next:\n  1. git diff, commit, push.\n  2. Create the Secrets for each environment: ./govchat secrets --env <environment>\n  3. Point Rancher to the folders of the environments (see README.md).');
}

// ---- cluster: kubectl and helm ------------------------------------------------------

function run(command, args, { input, allowFail, show } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', show ? 'inherit' : 'pipe', show ? 'inherit' : 'pipe'] });
  if (result.error) fail(`${command} did not start: ${result.error.message}. Is ${command} installed?`);
  if (result.status !== 0 && !allowFail) fail(`${command} ${args.slice(0, 4).join(' ')} ... failed.\n${(result.stderr ?? '').trim()}`);
  return { ok: result.status === 0, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

function cluster(options) {
  const context = options.context ?? run('kubectl', ['config', 'current-context'], { allowFail: true }).out;
  need(context, 'kubectl has no current context. Set one, or give --context <name>.');
  return {
    context,
    kubectl: (args, opts) => run('kubectl', ['--context', context, ...args], opts),
    helm: (args, opts) => run('helm', ['--kube-context', context, ...args], opts),
  };
}

function needLocalCluster(k8s, options) {
  need(options.force || /^(kind-|k3d-|rancher-desktop$|docker-desktop$|minikube$|colima)/.test(k8s.context),
    `The context "${k8s.context}" does not look like a local test cluster. This command is only for a test cluster on your own computer. If you are sure, add --force.`);
}

function createSecrets(k8s, loaded, { quiet } = {}) {
  const { env, kern, apps } = loaded;
  const ns = env.namespace;
  if (!k8s.kubectl(['get', 'namespace', ns], { allowFail: true }).ok) k8s.kubectl(['create', 'namespace', ns]);
  const wanted = [
    ...kern.secrets.map((secret) => ({ name: secret.name, label: 'kern', generate: secret.generate ?? {}, provide: secret.provide ?? [] })),
    ...apps.filter((app) => app.secrets.length).map((app) => ({ name: app.name, label: app.name, generate: {}, provide: app.secrets, app: true })),
  ];
  const todo = wanted.filter((secret) => {
    const there = k8s.kubectl(['-n', ns, 'get', 'secret', secret.name], { allowFail: true }).ok;
    if (there && !quiet) say(`Secret ${secret.name}: is already in ${ns}. No change.`);
    return !there;
  });
  // The kern Secrets get a placeholder in a local environment. There is no real login or model.
  const value = (secret, key) => process.env[key] ?? (env.local && !secret.app ? 'not-set' : undefined);
  const missing = todo.flatMap((secret) => secret.provide.filter((key) => value(secret, key) === undefined));
  need(!missing.length, `Give these values as environment variables: ${missing.join(', ')}.\nExample: ${missing.map((key) => `${key}=...`).join(' ')} ./govchat secrets --env ${env.name}`);
  for (const secret of todo) {
    const stringData = {};
    for (const [key, bytes] of Object.entries(secret.generate)) stringData[key] = crypto.randomBytes(Number(bytes)).toString('hex');
    for (const key of secret.provide) stringData[key] = value(secret, key);
    // The values go to kubectl through standard input: not on the command line, not in a file.
    k8s.kubectl(['-n', ns, 'create', '-f', '-'], {
      input: JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name: secret.name, labels: { [core.LABEL_APP]: secret.label } }, stringData }),
    });
    say(`Secret ${secret.name}: created in ${ns}.`);
  }
}

function secrets(root, options) {
  const repo = core.loadRepo(root);
  const loaded = core.loadEnv(root, repo, core.envOf(repo, options.env));
  const k8s = cluster(options);
  say(`Cluster context: ${k8s.context}. Namespace: ${loaded.env.namespace}.`);
  if (loaded.env.local) needLocalCluster(k8s, options);
  createSecrets(k8s, loaded);
}

const localEnv = (repo, options) => options.env ?? Object.keys(repo.environments).find((name) => repo.environments[name].local);

function localUp(root, options) {
  const repo = core.loadRepo(root);
  const envName = localEnv(repo, options);
  need(envName && repo.environments[envName]?.local, 'There is no local environment. Mark one with "local: true" in govchat.yaml.');
  const k8s = cluster(options);
  needLocalCluster(k8s, options);
  const loaded = buildEnv(root, repo, envName);
  const { env, kern, apps } = loaded;
  const ns = env.namespace;
  const dir = (...parts) => path.join(root, env.name, ...parts);
  say(`Cluster context: ${k8s.context}. Namespace: ${ns}.`);
  createSecrets(k8s, loaded, { quiet: true });

  const rollout = (name) => k8s.kubectl(['-n', ns, 'rollout', 'status', `deployment/${name}`, '--timeout=600s']);
  if (exists(dir('kern', 'local-services.yaml'))) {
    say('Local services (replacement for the model and the database) ...');
    k8s.kubectl(['-n', ns, 'apply', '-f', dir('kern', 'local-services.yaml')]);
    for (const doc of YAML.parseAllDocuments(readText(dir('kern', 'local-services.yaml')))) {
      if (doc.get('kind') === 'Deployment') rollout(doc.getIn(['metadata', 'name']));
    }
  }
  const done = new Set();
  const place = (app) => {
    if (done.has(app.name)) return;
    done.add(app.name);
    for (const name of Object.keys(app.requires)) place(apps.find((other) => other.name === name));
    if (app.image) {
      say(`App ${app.name} ...`);
      k8s.kubectl(['-n', ns, 'apply', '-f', dir('apps', app.name, 'manifests.yaml')]);
      rollout(app.name);
    } else if (app.chart) {
      say(`App ${app.name} (chart) ...`);
      const settings = dir('apps', app.name, 'settings.yaml');
      k8s.helm(['upgrade', '--install', app.name, dir('apps', app.name, 'chart'), '-n', ns, ...(exists(settings) ? ['-f', settings] : []), '--wait', '--timeout', '10m']);
    }
  };
  apps.forEach(place);

  say('Kern (the first time, the download of LibreChat can take some minutes) ...');
  const fleet = readYaml(dir('kern', 'fleet.yaml'));
  k8s.helm(['upgrade', '--install', kern.releaseName, kern.chart, '--version', String(kern.chartVersion), '-n', ns,
    ...fleet.helm.valuesFiles.flatMap((file) => ['-f', dir('kern', file)]), '--wait', '--timeout', '20m']);

  for (const name of leftovers(k8s, ns, apps)) {
    say(`Remove ${name} (not installed anymore) ...`);
    if (k8s.helm(['-n', ns, 'list', '-q']).out.split('\n').includes(name)) k8s.helm(['-n', ns, 'uninstall', name, '--wait']);
    k8s.kubectl(['-n', ns, 'delete', LEFTOVER_KINDS, '-l', `${core.LABEL_APP}=${name}`, '--ignore-not-found']);
  }
  say(`\nReady. Open the chat:\n  kubectl --context ${k8s.context} -n ${ns} port-forward service/${kern.releaseName}-librechat 3080:3080\nThen go to http://localhost:3080. Check the environment with: ./govchat verify --env ${env.name}`);
}

function localDown(root, options) {
  const repo = core.loadRepo(root);
  const envName = localEnv(repo, options);
  need(envName && repo.environments[envName]?.local, 'There is no local environment. Mark one with "local: true" in govchat.yaml.');
  const k8s = cluster(options);
  needLocalCluster(k8s, options);
  const ns = repo.environments[envName].namespace;
  k8s.kubectl(['delete', 'namespace', ns, '--ignore-not-found']);
  say(`The namespace ${ns} is deleted from ${k8s.context}.`);
}

// ---- verify -------------------------------------------------------------------------

const LEFTOVER_KINDS = 'deployment,statefulset,cronjob,service,networkpolicy,configmap,secret,persistentvolumeclaim';

// The names of apps that have parts in the cluster but are not installed.
function leftovers(k8s, ns, apps) {
  const items = JSON.parse(k8s.kubectl(['-n', ns, 'get', LEFTOVER_KINDS, '-l', core.LABEL_APP, '-o', 'json']).out).items;
  const known = new Set(['kern', ...apps.map((app) => app.name)]);
  return [...new Set(items.map((item) => item.metadata.labels[core.LABEL_APP]))].filter((name) => !known.has(name)).sort();
}

// Runs in the LibreChat pod. Asks each MCP server for its tools, the same way LibreChat does.
const PROBE = `
const apps = JSON.parse(process.argv[1]);
(async () => {
  const out = {};
  for (const app of apps) {
    try {
      const post = async (body, session) => {
        const response = await fetch(app.url, { method: 'POST', signal: AbortSignal.timeout(10000),
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session && { 'mcp-session-id': session }) },
          body: JSON.stringify(body) });
        return { session: response.headers.get('mcp-session-id'), text: await response.text() };
      };
      const first = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'govchat-verify', version: '1' } } });
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, first.session);
      const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, first.session);
      const answer = list.text.split('\\n').map((line) => line.replace(/^data: */, '')).filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)).find((message) => message.id === 2);
      out[app.name] = { tools: answer.result.tools.map((tool) => tool.name) };
    } catch (error) {
      out[app.name] = { error: String((error.cause && error.cause.code) || error.message) };
    }
  }
  let health = 0;
  try { health = (await fetch('http://localhost:3080/health', { signal: AbortSignal.timeout(10000) })).status; } catch (error) {}
  console.log(JSON.stringify({ health, apps: out }));
})();`;

async function verify(root, options) {
  const repo = core.loadRepo(root);
  const loaded = core.loadEnv(root, repo, core.envOf(repo, options.env));
  const { env, kern, apps } = loaded;
  const k8s = cluster(options);
  const ns = env.namespace;
  say(`Cluster context: ${k8s.context}. Namespace: ${ns}.`);
  let failed = 0;
  const report = (ok, text) => { say(`${ok ? 'OK   ' : 'FAIL '} ${text}`); if (!ok) failed += 1; };
  const ready = (name) => {
    const result = k8s.kubectl(['-n', ns, 'get', 'deployment', name, '-o', 'json'], { allowFail: true });
    if (!result.ok) return false;
    const status = JSON.parse(result.out).status ?? {};
    return (status.readyReplicas ?? 0) >= 1 && (status.updatedReplicas ?? 0) === (status.replicas ?? 0);
  };
  const chat = `${kern.releaseName}-librechat`;
  const chatReady = ready(chat);
  report(chatReady, `the kern operates (deployment ${chat})`);
  for (const app of apps.filter((item) => item.image)) report(ready(app.name), `the app ${app.name} operates`);

  const mcp = apps.filter((app) => app.mcp);
  if (chatReady) {
    const config = k8s.kubectl(['-n', ns, 'exec', `deployment/${chat}`, '--', 'cat', '/app/librechat.yaml'], { allowFail: true });
    const servers = config.ok ? Object.keys(YAML.parse(config.out)?.mcpServers ?? {}).sort() : null;
    const expected = mcp.map((app) => app.name).sort();
    report(servers && servers.join() === expected.join(), `the configuration in the pod contains the tools of the installed apps: ${expected.join(', ') || 'none'}${servers && servers.join() !== expected.join() ? ` (found: ${servers.join(', ') || 'none'})` : ''}`);
    const probe = k8s.kubectl(['-n', ns, 'exec', `deployment/${chat}`, '--', 'node', '-e', PROBE, JSON.stringify(mcp.map((app) => ({ name: app.name, url: core.mcpUrl(app) })))], { allowFail: true });
    const result = probe.ok ? JSON.parse(probe.out.split('\n').pop()) : { health: 0, apps: {} };
    report(result.health === 200, 'LibreChat answers on /health');
    for (const app of mcp) {
      const answer = result.apps[app.name] ?? { error: probe.err || 'no answer' };
      report(answer.tools?.length > 0, answer.tools?.length ? `LibreChat gets ${answer.tools.length} tool${answer.tools.length === 1 ? "" : "s"} from ${app.name}: ${answer.tools.join(', ')}` : `LibreChat gets no tools from ${app.name}: ${answer.error ?? 'empty list'}`);
    }
  }
  const left = leftovers(k8s, ns, apps);
  report(!left.length, left.length ? `parts of apps that are not installed: ${left.join(', ')}` : 'no parts of apps that are not installed');

  // From the outside: no access without the account of the organisation.
  const address = core.lookup(loaded.kernSettings, 'librechat.configEnv.DOMAIN_SERVER');
  if (!env.local && address && !/example/.test(address) && !options['skip-url']) {
    const expect = async (status, method, at, text) => {
      let got = 0;
      try {
        got = (await fetch(address + at, { method, signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 govchat-verify' },
          ...(method === 'POST' && { body: JSON.stringify({ email: 'nobody@example.test', password: 'invalid', name: 'x', confirm_password: 'invalid' }) }) })).status;
      } catch (error) { /* got stays 0 */ }
      report(got === status, `${address}: ${text} (expected ${status}, got ${got})`);
    };
    await expect(200, 'GET', '/health', 'the application is reachable');
    await expect(403, 'POST', '/api/auth/login', 'local login is refused');
    await expect(403, 'POST', '/api/auth/register', 'account creation is refused');
    await expect(403, 'POST', '/api/auth/requestPasswordReset', 'password reset is refused');
    await expect(401, 'GET', '/api/user', 'no user data without login');
    await expect(401, 'GET', '/api/convos', 'no conversations without login');
  }
  need(!failed, `${failed} check${failed === 1 ? '' : 's'} failed.`);
  say('All checks are OK.');
}

module.exports = { build, check, kernSet, appList, appAdd, appRemove, appNew, promote, branding, init, secrets, localUp, localDown, verify };
