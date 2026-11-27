'use strict';
// Stelt samen uit onderdelen op de schijf, in een tijdelijke map. Geen netwerk nodig.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');

const CORE_VALUES = `librechat:
  configYamlContent: |
    version: 1.3.19
    interface:
      mcpServers: { use: false, create: false }
    modelSpecs:
      list:
        - name: govchat-standaard
          label: "GovChat standaard"
`;
const core = { 'kern.yaml': { name: 'kern', version: '0.1.0', contract: 'v1', chart: 'oci://example/librechat', chartVersion: '3.2.1', releaseName: 'librechat', values: 'values.yaml', config: { 'librechat.configEnv.DOMAIN_CLIENT': { verplicht: true } } }, 'values.yaml': CORE_VALUES };
const app = (name, extra = {}) => ({ 'app.yaml': { name, version: '1.0.0', contract: 'v1', kern: '>=0.1.0 <1.0.0', chart: 'chart',
  librechat: { mcpServers: { [name]: { url: `http://${name}:8080/mcp`, title: `Tool ${name}` } } }, ...extra } });

function setup(parts, stackApps, values = { 'values/kern.yaml': { librechat: { configEnv: { DOMAIN_CLIENT: 'https://x' } } } }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-test-'));
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), typeof content === 'string' ? content : YAML.stringify(content));
  };
  for (const [name, files] of Object.entries(parts)) for (const [file, content] of Object.entries(files)) write(`onderdelen/${name}/${file}`, content);
  write('repo/stacks/test.yaml', { namespace: 'govchat', core: { url: '../onderdelen/kern' }, apps: stackApps.map((name) => ({ url: `../onderdelen/${name}` })) });
  for (const [file, content] of Object.entries(values)) write(`repo/${file}`, content);
  return path.join(dir, 'repo');
}
const run = (repo, ...extra) => spawnSync(process.execPath, [path.join(__dirname, '..', 'manager.js'), 'samenstellen', 'test', '--repo', repo, ...extra], { encoding: 'utf8' });
const read = (repo, file) => YAML.parse(fs.readFileSync(path.join(repo, file), 'utf8'));
const fails = (result, pattern) => { assert.strictEqual(result.status, 1, result.stdout); assert.match(result.stderr, pattern); };

test('de kern met één app', () => {
  const repo = setup({ kern: core, time: app('time') }, ['time']);
  const result = run(repo);
  assert.strictEqual(result.status, 0, result.stderr);
  const config = YAML.parse(read(repo, 'deploy/test/kern/values-kern.yaml').librechat.configYamlContent);
  assert.strictEqual(config.interface.mcpServers.use, true);
  assert.strictEqual(config.mcpServers.time.url, 'http://time:8080/mcp');
  assert.strictEqual(config.mcpServers.time.chatMenu, false);
  assert.deepStrictEqual(config.mcpSettings.allowedAddresses, ['time:8080']);
  assert.deepStrictEqual(config.modelSpecs.list[0].mcpServers, ['time']);
  const fleet = read(repo, 'deploy/test/time/fleet.yaml');
  assert.deepStrictEqual(fleet.labels, { 'govchat.app': 'time' });
  assert.deepStrictEqual(read(repo, 'deploy/test/kern/fleet.yaml').dependsOn, [{ selector: { matchLabels: { 'govchat.app': 'time' } } }]);
  assert.strictEqual(read(repo, 'stack.lock').test.length, 2);
  assert.strictEqual(run(repo, '--controleer').status, 0);
});

test('een app die niet meer gekozen is, laat niets achter', () => {
  const repo = setup({ kern: core, time: app('time') }, ['time']);
  run(repo);
  fs.writeFileSync(path.join(repo, 'stacks/test.yaml'), YAML.stringify({ namespace: 'govchat', core: { url: '../onderdelen/kern' }, apps: [] }));
  fails(run(repo, '--controleer'), /past niet bij/);
  assert.strictEqual(run(repo).status, 0);
  assert.ok(!fs.existsSync(path.join(repo, 'deploy/test/time')));
  const text = fs.readFileSync(path.join(repo, 'deploy/test/kern/values-kern.yaml'), 'utf8');
  assert.ok(!text.includes('time:8080'));
  assert.strictEqual(YAML.parse(YAML.parse(text).librechat.configYamlContent).interface.mcpServers.use, false);
});

test('afhankelijkheid: volgorde, ontbrekend, verkeerde versie en kring', () => {
  const needs = (url, version = '>=1.0.0 <2.0.0') => ({ requires: [{ url, version }] });
  let repo = setup({ kern: core, time: app('time'), raad: app('raad', needs('../onderdelen/time')) }, ['raad', 'time']);
  assert.strictEqual(run(repo).status, 0);
  assert.deepStrictEqual(read(repo, 'deploy/test/raad/fleet.yaml').dependsOn, [{ selector: { matchLabels: { 'govchat.app': 'time' } } }]);
  repo = setup({ kern: core, raad: app('raad', needs('../onderdelen/time')) }, ['raad']);
  fails(run(repo), /staat niet in de lijst/);
  repo = setup({ kern: core, time: app('time'), raad: app('raad', needs('../onderdelen/time', '>=2.0.0')) }, ['raad', 'time']);
  fails(run(repo), /gekozen is 1\.0\.0/);
  repo = setup({ kern: core, time: app('time', needs('../onderdelen/raad')), raad: app('raad', needs('../onderdelen/time')) }, ['raad', 'time']);
  fails(run(repo), /kring/);
});

test('botsingen stoppen met een fout', () => {
  const twin = app('klok'); twin['app.yaml'].librechat.mcpServers = { time: { url: 'http://klok:8080/mcp', title: 'Klok' } };
  fails(run(setup({ kern: core, time: app('time'), klok: twin }, ['time', 'klok'])), /bestaat al/);
  const title = app('time'); title['app.yaml'].librechat.mcpServers.time.title = 'Tijd (proef)';
  fails(run(setup({ kern: core, time: title }, ['time'])), /title mag alleen/);
  fails(run(setup({ kern: core, time: app('time', { kern: '>=1.0.0' }) }, ['time'])), /gekozen is kern 0\.1\.0/);
  fails(run(setup({ kern: core }, [], {})), /verplichte instelling/);
  fails(run(setup({ kern: core }, [], { 'values/kern.yaml': { librechat: { configEnv: { DOMAIN_CLIENT: 'x' }, configYamlContent: 'x' } } })), /is van de kern/);
  const repo = setup({ kern: core, time: app('time', { config: { 'bron.id': { verplicht: true } } }) }, ['time']);
  fails(run(repo), /bron\.id/);
});

test('een adres zonder volledige versie wordt geweigerd', () => {
  const repo = setup({ kern: core }, []);
  fs.writeFileSync(path.join(repo, 'stacks/test.yaml'), YAML.stringify({ namespace: 'govchat', core: { url: 'https://example.invalid/kern', version: 'v1' } }));
  fails(run(repo), /versie ontbreekt of is onvolledig/);
  fs.writeFileSync(path.join(repo, 'stacks/test.yaml'), YAML.stringify({ namespace: 'govchat', core: { url: 'https://example.invalid/kern', version: 'v1.0.0' }, allowedSources: ['https://github.com/GovChat-NL/'] }));
  fails(run(repo), /allowedSources/);
});
