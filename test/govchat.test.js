'use strict';
// Tests of the commands that write files. They use Git repositories in a temporary
// folder (file:// addresses). No network and no cluster are necessary.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const YAML = require('yaml');

const CLI = path.join(__dirname, '..', 'govchat.js');
const KERN_VALUES = `librechat:
  configYamlContent: |
    version: 1.3.19
    interface:
      mcpServers: { use: false, create: false }
    endpoints:
      azureOpenAI:
        groups:
          - apiKey: "\${AZURE_MODEL_KEY}"
    modelSpecs:
      list:
        - name: govchat-standaard
          label: "GovChat standaard"
`;
const kern = (version = '0.2.0') => ({
  'kern.yaml': { name: 'kern', version, contract: 'v2', chart: 'oci://example/librechat', chartVersion: '3.2.1', releaseName: 'librechat', values: 'values.yaml', localServices: 'local/services.yaml',
    secrets: [{ name: 'librechat-credentials-env', generate: { JWT_SECRET: 32 }, provide: ['AZURE_MODEL_KEY'] }],
    config: { 'librechat.configEnv.DOMAIN_CLIENT': { required: true, description: 'Web address' } } },
  'values.yaml': KERN_VALUES,
  'local/services.yaml': 'apiVersion: v1\nkind: ConfigMap\nmetadata: { name: stub }\n',
});
const app = (name, extra = {}, version = '1.0.0') => ({
  'app.yaml': { name, version, contract: 'v2', title: `Tool ${name}`, kern: '>=0.2.0 <1.0.0', image: `registry.example/${name}:${version}`, ...extra },
});

const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.test', ...args], { stdio: 'pipe' });

// Makes a workspace: source repositories with tags, and a deploy repository.
function setup(sources) {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'govchat-test-')));
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(top, file)), { recursive: true });
    fs.writeFileSync(path.join(top, file), typeof content === 'string' ? content : YAML.stringify(content));
  };
  const publish = (name, files, tag) => {
    const dir = path.join(top, 'src', name);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); git(dir, 'init', '-q', '-b', 'main'); }
    for (const [file, content] of Object.entries(files)) write(`src/${name}/${file}`, content);
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--allow-empty', '-m', tag); git(dir, 'tag', tag);
  };
  for (const [name, files] of Object.entries(sources)) publish(name, files, `v${files['kern.yaml']?.version ?? files['app.yaml'].version}`);
  const url = (name) => `file://${top}/src/${name}`;
  write('repo/govchat.yaml', { kern: url('kern'), allowedSources: [`file://${top}/src/`],
    environments: { acceptatie: { namespace: 'govchat-acc' }, productie: { namespace: 'govchat' }, lokaal: { namespace: 'govchat', local: true } } });
  write('repo/shared/kern.yaml', { librechat: { configEnv: { DOMAIN_CLIENT: 'https://chat.example.nl' } } });
  const repo = path.join(top, 'repo');
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args, '--repo', repo], { encoding: 'utf8' });
  const ok = (...args) => { const result = run(...args); assert.strictEqual(result.status, 0, result.stderr + result.stdout); return result; };
  const fails = (pattern, ...args) => { const result = run(...args); assert.strictEqual(result.status, 1, result.stdout); assert.match(result.stderr, pattern); };
  const read = (file) => YAML.parse(fs.readFileSync(path.join(repo, file), 'utf8'));
  const docs = (file) => YAML.parseAllDocuments(fs.readFileSync(path.join(repo, file), 'utf8')).map((doc) => doc.toJS());
  const has = (file) => fs.existsSync(path.join(repo, file));
  const config = (env) => YAML.parse(read(`${env}/kern/generated.yaml`).librechat.configYamlContent);
  return { top, repo, url, publish, write, run, ok, fails, read, docs, has, config };
}

test('the kern and one app: the files that Fleet reads', () => {
  const t = setup({ kern: kern(), time: app('time') });
  t.ok('kern', 'set', 'latest', '--env', 'acceptatie');
  t.ok('app', 'add', t.url('time'), '--env', 'acceptatie');

  const config = t.config('acceptatie');
  assert.strictEqual(config.interface.mcpServers.use, true);
  assert.deepStrictEqual(config.mcpServers.time, { type: 'streamable-http', url: 'http://time:8080/mcp', title: 'Tool time', chatMenu: false });
  assert.deepStrictEqual(config.mcpSettings.allowedAddresses, ['time:8080']);
  assert.deepStrictEqual(config.modelSpecs.list[0].mcpServers, ['time']);
  assert.strictEqual(config.endpoints.azureOpenAI.groups[0].apiKey, '${AZURE_MODEL_KEY}');

  const fleet = t.read('acceptatie/kern/fleet.yaml');
  assert.deepStrictEqual(fleet.labels, { 'govchat.env': 'acceptatie', 'govchat.app': 'kern' });
  assert.deepStrictEqual(fleet.helm.valuesFiles, ['kern-values.yaml', 'generated.yaml', '../../shared/kern.yaml', 'settings.yaml']);
  assert.strictEqual(fleet.helm.disablePreProcess, true);
  assert.deepStrictEqual(fleet.dependsOn, [{ selector: { matchLabels: { 'govchat.env': 'acceptatie', 'govchat.app': 'time' } } }]);
  assert.strictEqual(fleet.defaultNamespace, 'govchat-acc');

  const [deployment, service, policy] = t.docs('acceptatie/apps/time/manifests.yaml');
  const container = deployment.spec.template.spec.containers[0];
  assert.strictEqual(container.image, 'registry.example/time:1.0.0');
  assert.strictEqual(container.securityContext.readOnlyRootFilesystem, true);
  assert.strictEqual(deployment.spec.template.spec.securityContext.runAsNonRoot, true);
  assert.deepStrictEqual(deployment.metadata.labels, { 'govchat.app': 'time' });
  assert.strictEqual(service.metadata.name, 'time');
  assert.deepStrictEqual(policy.spec.ingress[0].from[0].podSelector.matchLabels, { 'app.kubernetes.io/name': 'librechat-librechat' });
  assert.strictEqual(policy.spec.egress, undefined);
  assert.deepStrictEqual(policy.spec.policyTypes, ['Ingress', 'Egress']);

  const source = t.read('acceptatie/apps/time/app.yaml').source;
  assert.strictEqual(source.version, 'v1.0.0');
  assert.match(source.commit, /^[0-9a-f]{40}$/);
  assert.strictEqual(fs.readFileSync(path.join(t.repo, 'acceptatie/apps/time/.fleetignore'), 'utf8'), 'app.yaml\nsettings.yaml\n');
  assert.ok(!t.has('acceptatie/kern/local-services.yaml'));
  t.ok('check');
});

test('a removed app leaves nothing', () => {
  const t = setup({ kern: kern(), time: app('time') });
  t.ok('kern', 'set', 'v0.2.0', '--env', 'acceptatie');
  t.ok('app', 'add', t.url('time'), '--env', 'acceptatie');
  t.ok('app', 'remove', 'time', '--env', 'acceptatie');
  assert.ok(!t.has('acceptatie/apps/time'));
  const config = t.config('acceptatie');
  assert.strictEqual(config.mcpServers, undefined);
  assert.strictEqual(config.interface.mcpServers.use, false);
  assert.strictEqual(t.read('acceptatie/kern/fleet.yaml').dependsOn, undefined);
  t.ok('check', '--env', 'acceptatie');
  t.fails(/not installed/, 'app', 'remove', 'time', '--env', 'acceptatie');
});

test('check fails when the generated files are not current', () => {
  const t = setup({ kern: kern(), time: app('time', { config: { ZONE: { default: 'Europe/Amsterdam' } } }) });
  t.ok('kern', 'set', 'latest', '--env', 'acceptatie');
  t.ok('app', 'add', t.url('time'), '--env', 'acceptatie');
  const env = () => t.docs('acceptatie/apps/time/manifests.yaml')[0].spec.template.spec.containers[0].env;
  assert.deepStrictEqual(env(), [{ name: 'ZONE', value: 'Europe/Amsterdam' }]);
  assert.match(fs.readFileSync(path.join(t.repo, 'acceptatie/apps/time/settings.yaml'), 'utf8'), /ZONE: "Europe\/Amsterdam"/);
  t.write('repo/acceptatie/apps/time/settings.yaml', { config: { ZONE: 'UTC' } });
  t.fails(/build/, 'check');
  t.ok('build');
  assert.deepStrictEqual(env(), [{ name: 'ZONE', value: 'UTC' }]);
  t.ok('check');
  t.write('repo/acceptatie/apps/time/settings.yaml', { config: { ZOEN: 'UTC' } });
  t.fails(/ZOEN is not known/, 'build');
});

test('settings, secrets and egress of an app', () => {
  const t = setup({ kern: kern(), raad: app('raad', { egress: 'internet', secrets: ['API_KEY'], env: { MODE: 'prod' }, config: { API_URL: { required: true, description: 'The address' } } }) });
  t.ok('kern', 'set', 'latest', '--env', 'acceptatie');
  const added = t.ok('app', 'add', t.url('raad'), '--env', 'acceptatie');
  assert.match(added.stdout, /NOT READY: .*API_URL is empty/);
  assert.match(added.stdout, /Secret "raad".*API_KEY/);
  t.fails(/API_URL is empty/, 'build', '--env', 'acceptatie');
  t.write('repo/acceptatie/apps/raad/settings.yaml', { config: { API_URL: 'https://api.example.nl' } });
  t.ok('build', '--env', 'acceptatie');
  const [deployment, , policy] = t.docs('acceptatie/apps/raad/manifests.yaml');
  assert.deepStrictEqual(deployment.spec.template.spec.containers[0].env, [
    { name: 'MODE', value: 'prod' }, { name: 'API_URL', value: 'https://api.example.nl' },
    { name: 'API_KEY', valueFrom: { secretKeyRef: { name: 'raad', key: 'API_KEY' } } }]);
  assert.strictEqual(policy.spec.egress.length, 2);
});

test('an app with a chart, and an app with only an assistant', () => {
  const chart = app('litellm', { image: undefined, chart: 'chart', mcp: false });
  chart['chart/Chart.yaml'] = { apiVersion: 'v2', name: 'litellm', version: '1.0.0' };
  chart['chart/templates/service.yaml'] = 'apiVersion: v1\nkind: Service\nmetadata: { name: litellm }\n';
  const assistants = app('b1', { image: undefined, assistants: [{ name: 'b1', label: 'B1', preset: { endpoint: 'azureOpenAI' } }] });
  const t = setup({ kern: kern(), litellm: chart, b1: assistants });
  t.ok('kern', 'set', 'latest', '--env', 'acceptatie');
  t.ok('app', 'add', t.url('litellm'), '--env', 'acceptatie');
  t.ok('app', 'add', t.url('b1'), '--env', 'acceptatie');
  assert.deepStrictEqual(t.read('acceptatie/apps/litellm/fleet.yaml').helm, { releaseName: 'litellm', chart: 'chart' });
  assert.ok(t.has('acceptatie/apps/litellm/chart/templates/service.yaml'));
  assert.ok(!t.has('acceptatie/apps/litellm/manifests.yaml'));
  assert.ok(!t.has('acceptatie/apps/b1/fleet.yaml'));
  const config = t.config('acceptatie');
  assert.deepStrictEqual(config.modelSpecs.list.map((spec) => spec.name), ['govchat-standaard', 'b1']);
  assert.strictEqual(config.mcpServers, undefined);
  assert.deepStrictEqual(t.read('acceptatie/kern/fleet.yaml').dependsOn.map((need) => need.selector.matchLabels['govchat.app']), ['litellm']);
});

test('the checks that stop a build', () => {
  const t = setup({
    kern: kern(),
    time: app('time'),
    needs: app('needs', { requires: { time: '>=2.0.0' } }),
    a: app('a', { requires: { b: '>=1.0.0' } }),
    b: app('b', { requires: { a: '>=1.0.0' } }),
    old: app('old', { kern: '>=0.1.0 <0.2.0' }),
    title: app('title', { title: 'Time (test)' }),
    latest: app('latest', { image: 'registry.example/latest:latest' }),
    v1: app('v1', { contract: 'v1' }),
  });
  t.ok('kern', 'set', 'latest', '--env', 'acceptatie');
  t.fails(/needs the app time/, 'build', ...(t.ok('app', 'add', t.url('needs'), '--env', 'acceptatie'), ['--env', 'acceptatie']));
  t.ok('app', 'add', t.url('time'), '--env', 'acceptatie');
  t.fails(/needs time >=2.0.0/, 'build', '--env', 'acceptatie');
  t.ok('app', 'remove', 'needs', '--env', 'acceptatie');
  t.ok('app', 'add', t.url('a'), '--env', 'acceptatie');
  t.ok('app', 'add', t.url('b'), '--env', 'acceptatie');
  t.fails(/in a circle/, 'build', '--env', 'acceptatie');
  fs.rmSync(path.join(t.repo, 'acceptatie/apps/a'), { recursive: true });
  fs.rmSync(path.join(t.repo, 'acceptatie/apps/b'), { recursive: true });
  t.ok('app', 'add', t.url('old'), '--env', 'acceptatie');
  t.fails(/operates with kern/, 'build', '--env', 'acceptatie');
  fs.rmSync(path.join(t.repo, 'acceptatie/apps/old'), { recursive: true });
  t.fails(/"title" is missing or not valid/, 'app', 'add', t.url('title'), '--env', 'acceptatie');
  t.fails(/fixed version/, 'app', 'add', t.url('latest'), '--env', 'acceptatie');
  t.fails(/contract is "v1"/, 'app', 'add', t.url('v1'), '--env', 'acceptatie');
  t.write('repo/acceptatie/kern/settings.yaml', { librechat: { configYamlContent: 'version: 1' } });
  t.fails(/belongs to the kern/, 'build', '--env', 'acceptatie');
  t.write('repo/acceptatie/kern/settings.yaml', {});
  t.write('repo/shared/kern.yaml', {});
  t.fails(/DOMAIN_CLIENT is empty/, 'build', '--env', 'acceptatie');
});

test('sources: permitted addresses, versions and folders', () => {
  const t = setup({ kern: kern(), time: app('time') });
  t.publish('time', app('time', {}, '1.2.0'), 'v1.2.0');
  t.publish('time', app('time', {}, '1.2.0'), 'v1.3.0'); // the tag and the file are different
  t.ok('kern', 'set', 'latest', '--env', 'acceptatie');
  t.ok('kern', 'set', 'latest', '--env', 'lokaal');
  assert.ok(t.has('lokaal/kern/local-services.yaml'));
  t.fails(/not in "allowedSources"/, 'app', 'add', 'https://example.test/other/app', '--env', 'acceptatie');
  t.fails(/tag is v1.3.0/, 'app', 'add', t.url('time'), '--env', 'acceptatie');
  t.ok('app', 'add', t.url('time'), '--version', '1.0.0', '--env', 'acceptatie');
  assert.strictEqual(t.read('acceptatie/apps/time/app.yaml').version, '1.0.0');
  t.ok('app', 'add', t.url('time'), '--version', 'v1.2.0', '--env', 'acceptatie');
  assert.strictEqual(t.read('acceptatie/apps/time/app.yaml').version, '1.2.0');
  t.fails(/only permitted in a local environment/, 'app', 'add', '../src/time', '--env', 'acceptatie');
  t.ok('app', 'add', '../src/time', '--env', 'lokaal');
  assert.strictEqual(t.read('lokaal/apps/time/app.yaml').source.commit, 'local');
  t.fails(/not in the list of known apps/, 'app', 'add', 'unknown-app', '--env', 'acceptatie');
  t.fails(/is not in govchat.yaml/, 'build', '--env', 'test');
});

test('promote copies the versions and keeps the settings', () => {
  const t = setup({ kern: kern(), time: app('time'), raad: app('raad', { config: { API_URL: { required: true } } }), extra: app('extra') });
  t.ok('kern', 'set', 'latest', '--env', 'acceptatie');
  t.ok('kern', 'set', 'latest', '--env', 'productie');
  t.ok('app', 'add', t.url('extra'), '--env', 'productie');
  t.write('repo/productie/kern/settings.yaml', { librechat: { configEnv: { DOMAIN_CLIENT: 'https://prod.example.nl' } } });
  t.publish('kern', kern('0.3.0'), 'v0.3.0');
  t.ok('kern', 'set', 'latest', '--env', 'acceptatie');
  t.ok('app', 'add', t.url('time'), '--env', 'acceptatie');
  t.ok('app', 'add', t.url('raad'), '--env', 'acceptatie');
  t.write('repo/acceptatie/apps/raad/settings.yaml', { config: { API_URL: 'https://acc.example.nl' } });
  t.ok('build');

  const result = t.ok('promote');
  assert.match(result.stdout, /kern\s+0\.2\.0 -> 0\.3\.0/);
  assert.match(result.stdout, /extra\s+1\.0\.0 -> removed/);
  assert.match(result.stdout, /NOT READY: .*API_URL is empty/);
  assert.strictEqual(t.read('productie/kern/kern.yaml').version, '0.3.0');
  assert.strictEqual(t.read('productie/kern/settings.yaml').librechat.configEnv.DOMAIN_CLIENT, 'https://prod.example.nl');
  assert.ok(!t.has('productie/apps/extra'));
  assert.match(fs.readFileSync(path.join(t.repo, 'productie/apps/time/app.yaml'), 'utf8'), /--env productie/);
  t.write('repo/productie/apps/raad/settings.yaml', { config: { API_URL: 'https://prod-api.example.nl' } });
  t.ok('build', '--env', 'productie');
  assert.strictEqual(t.read('productie/kern/fleet.yaml').defaultNamespace, 'govchat');
  assert.deepStrictEqual(Object.keys(t.config('productie').mcpServers), ['raad', 'time']);
  t.ok('check');
});

test('app new makes an app that the command accepts', () => {
  const t = setup({ kern: kern() });
  t.ok('kern', 'set', 'latest', '--env', 'lokaal');
  t.ok('app', 'new', 'my-app', '--dir', '../my-app');
  assert.ok(fs.existsSync(path.join(t.top, 'my-app', '.gitignore')));
  assert.match(fs.readFileSync(path.join(t.top, 'my-app', 'server.js'), 'utf8'), /name: 'my-app'/);
  t.ok('app', 'add', '../my-app', '--env', 'lokaal');
  assert.strictEqual(t.docs('lokaal/apps/my-app/manifests.yaml')[0].spec.template.spec.containers[0].image, 'my-app:0.1.0');
  assert.strictEqual(t.config('lokaal').mcpServers['my-app'].title, 'My app');
});

test('init asks for the values and builds all environments', () => {
  const t = setup({ kern: kern() });
  t.write('repo/shared/kern.yaml', '# keep this comment\nlibrechat:\n  configEnv:\n    OTHER: "x"\n');
  t.write('repo/acceptatie/kern/settings.yaml', { ingress: { hosts: [{ host: 'old.example.nl' }], tls: [{ secretName: 'tls', hosts: ['old.example.nl'] }] } });
  t.write('repo/lokaal/kern/settings.yaml', { librechat: { configEnv: { DOMAIN_CLIENT: 'http://localhost:3080' } } });
  const result = spawnSync(process.execPath, [CLI, 'init', '--repo', t.repo], { encoding: 'utf8', input: 'https://chat-acc.gemeente.example\nhttps://chat.gemeente.example/\n' });
  assert.strictEqual(result.status, 0, result.stderr + result.stdout);
  const acc = t.read('acceptatie/kern/settings.yaml');
  assert.strictEqual(acc.librechat.configEnv.DOMAIN_SERVER, 'https://chat-acc.gemeente.example');
  assert.strictEqual(acc.ingress.hosts[0].host, 'chat-acc.gemeente.example');
  assert.deepStrictEqual(acc.ingress.tls[0].hosts, ['chat-acc.gemeente.example']);
  assert.strictEqual(t.read('productie/kern/settings.yaml').librechat.configEnv.DOMAIN_CLIENT, 'https://chat.gemeente.example');
  assert.match(fs.readFileSync(path.join(t.repo, 'shared/kern.yaml'), 'utf8'), /# keep this comment/);
  assert.ok(t.has('lokaal/kern/generated.yaml'));
  t.ok('check');
});
