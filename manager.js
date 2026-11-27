#!/usr/bin/env node
// De app-manager: stelt uit de keuzes van een organisatie de uitrol samen.
//
//   manager.js samenstellen <omgeving> [--repo <map>] [--controleer]
//   manager.js lokaal <omgeving> [--repo <map>]
//
// Leest stacks/<omgeving>.yaml en values/ in de uitrolrepository, haalt per adres de
// kern en de apps op in de gevraagde versie, controleert ze en schrijft deploy/<omgeving>/
// en stack.lock. Schrijft alleen bestanden: praat niet met het cluster, pusht niet en
// heeft geen token nodig. Bij elke botsing stopt hij met een fout; er wordt nooit stil
// overschreven.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const YAML = require('yaml');
const semver = require('semver');

const CONTRACT = 'v1';
const LABEL = 'govchat.app';
// LibreChat keurt het hele configuratiebestand af bij een titel die hier niet aan voldoet.
const TITLE = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}'’ -]*$/u;
const NAME = /^[a-z0-9]([-a-z0-9]{0,40}[a-z0-9])?$/;
const VERSION = /^v\d+\.\d+\.\d+$/;

class Fout extends Error {}
const fout = (message) => { throw new Fout(message); };
const eis = (ok, message) => { if (!ok) fout(message); };

const isLocal = (url) => /^(\.|\/|~)/.test(url);
const readYaml = (file) => YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
const exists = (file) => fs.existsSync(file);

function merge(base, extra) {
  if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) return extra;
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(extra)) out[key] = merge(out[key], value);
  return out;
}

// Zoekt een pad met punten ("a.b.c") op; een sleutel mag zelf geen punt bevatten.
const lookup = (obj, dotted) => dotted.split('.').reduce((at, key) => (at == null ? undefined : at[key]), obj);

// ---- ophalen ------------------------------------------------------------------------

// Geeft { dir, commit } van een onderdeel in de gevraagde versie.
function fetch(repo, { url, version }, what) {
  eis(typeof url === 'string' && url, `${what}: het adres (url) ontbreekt.`);
  if (isLocal(url)) {
    const dir = path.resolve(repo, url.replace(/^~/, os.homedir()));
    eis(exists(dir), `${what}: de map ${dir} bestaat niet.`);
    return { dir, commit: 'lokaal' };
  }
  eis(typeof version === 'string' && VERSION.test(version),
    `${what} (${url}): de versie ontbreekt of is onvolledig. Verwacht een volledige versie zoals v1.2.3, kreeg "${version ?? ''}".`);
  const dir = path.join(repo, '.manager-cache', url.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_'), version);
  if (!exists(path.join(dir, '.git'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    try {
      execFileSync('git', ['clone', '--quiet', '--depth', '1', '--branch', version, url, dir], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      fout(`${what}: ${url} is niet op te halen in versie ${version}.\n${String(error.stderr ?? error.message).trim()}`);
    }
  }
  const commit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { dir, commit };
}

// ---- lezen en controleren -----------------------------------------------------------

function loadStack(repo, env) {
  const file = path.join(repo, 'stacks', `${env}.yaml`);
  eis(exists(file), `stacks/${env}.yaml bestaat niet.`);
  const stack = readYaml(file);
  eis(typeof stack.namespace === 'string' && NAME.test(stack.namespace), `stacks/${env}.yaml: namespace ontbreekt of is ongeldig.`);
  eis(stack.core && typeof stack.core === 'object', `stacks/${env}.yaml: core ontbreekt.`);
  stack.apps = stack.apps ?? [];
  eis(Array.isArray(stack.apps), `stacks/${env}.yaml: apps moet een lijst zijn.`);
  const allowed = stack.allowedSources;
  if (allowed !== undefined) {
    eis(Array.isArray(allowed), `stacks/${env}.yaml: allowedSources moet een lijst zijn.`);
    for (const part of [stack.core, ...stack.apps]) {
      eis(isLocal(part.url ?? '') || allowed.some((prefix) => String(part.url).startsWith(prefix)),
        `${part.url}: dit adres staat niet in allowedSources van stacks/${env}.yaml.`);
    }
  }
  return stack;
}

function checkManifest(manifest, source, ref, file) {
  const what = `${ref.url} (${file})`;
  eis(manifest.contract === CONTRACT, `${what}: contract is "${manifest.contract}", deze app-manager ondersteunt ${CONTRACT}.`);
  eis(typeof manifest.name === 'string' && NAME.test(manifest.name), `${what}: name ontbreekt of is ongeldig (kleine letters, cijfers en streepjes).`);
  eis(semver.valid(manifest.version), `${what}: version is geen volledige semver-versie.`);
  if (source.commit !== 'lokaal') {
    eis(`v${manifest.version}` === ref.version,
      `${what}: de tag is ${ref.version}, maar in het bestand staat versie ${manifest.version}.`);
  }
}

function loadCore(repo, ref) {
  const source = fetch(repo, ref, 'De kern');
  const file = path.join(source.dir, 'kern.yaml');
  eis(exists(file), `${ref.url}: kern.yaml ontbreekt.`);
  const manifest = readYaml(file);
  checkManifest(manifest, source, ref, 'kern.yaml');
  for (const key of ['chart', 'chartVersion', 'releaseName', 'values']) eis(manifest[key], `${ref.url} (kern.yaml): ${key} ontbreekt.`);
  return { ...manifest, ref, source };
}

function loadApp(repo, ref, core) {
  const source = fetch(repo, ref, 'Een app');
  const file = path.join(source.dir, 'app.yaml');
  eis(exists(file), `${ref.url}: app.yaml ontbreekt.`);
  const manifest = readYaml(file);
  checkManifest(manifest, source, ref, 'app.yaml');
  const what = `De app ${manifest.name} (${ref.url})`;
  eis(manifest.name !== 'kern', `${what}: de naam "kern" is van de kern.`);
  eis(manifest.chart, `${what}: chart ontbreekt. Gebruik "chart: geen" voor een app zonder eigen onderdelen.`);
  eis(typeof manifest.kern === 'string' && semver.validRange(manifest.kern), `${what}: kern (het versiebereik van de kern) ontbreekt of is ongeldig.`);
  eis(semver.satisfies(core.version, manifest.kern), `${what} werkt met kern ${manifest.kern}, maar gekozen is kern ${core.version}.`);
  manifest.requires = manifest.requires ?? [];
  manifest.config = manifest.config ?? {};
  manifest.secrets = manifest.secrets ?? [];
  manifest.librechat = manifest.librechat ?? {};
  for (const [server, spec] of Object.entries(manifest.librechat.mcpServers ?? {})) {
    eis(NAME.test(server), `${what}: de naam van MCP-server "${server}" is ongeldig.`);
    eis(typeof spec.url === 'string' && /^http:\/\/[a-z0-9-]+:\d+\//.test(spec.url),
      `${what}: mcpServers.${server}.url moet een adres binnen het cluster zijn, zoals http://<service>:<poort>/mcp.`);
    eis(typeof spec.title === 'string' && TITLE.test(spec.title),
      `${what}: mcpServers.${server}.title mag alleen letters, cijfers, spaties, streepjes en apostroffen bevatten. LibreChat start anders niet.`);
  }
  return { ...manifest, ref, source };
}

const sameSource = (a, b) => String(a).replace(/\.git$|\/$/g, '').toLowerCase() === String(b).replace(/\.git$|\/$/g, '').toLowerCase();

function checkApps(apps) {
  const names = new Map();
  for (const app of apps) {
    eis(!names.has(app.name), `Twee apps heten "${app.name}": ${names.get(app.name)?.ref.url} en ${app.ref.url}. Er draait één exemplaar van een app.`);
    names.set(app.name, app);
  }
  for (const app of apps) {
    for (const need of app.requires) {
      eis(need.url && semver.validRange(need.version ?? ''), `De app ${app.name}: een regel in requires mist een adres of een geldig versiebereik.`);
      const found = apps.find((other) => sameSource(other.ref.url, need.url));
      eis(found, `De app ${app.name} heeft ${need.url} nodig (${need.version}), maar die staat niet in de lijst.`);
      eis(semver.satisfies(found.version, need.version),
        `De app ${app.name} heeft ${found.name} ${need.version} nodig, maar gekozen is ${found.version}.`);
      (app.needs = app.needs ?? []).push(found.name);
    }
  }
  // Afhankelijkheden die in een kring naar elkaar verwijzen.
  const state = new Map();
  const visit = (app, trail) => {
    if (state.get(app.name) === 'klaar') return;
    eis(state.get(app.name) !== 'bezig', `De afhankelijkheden verwijzen in een kring: ${[...trail, app.name].join(' → ')}.`);
    state.set(app.name, 'bezig');
    for (const name of app.needs ?? []) visit(names.get(name), [...trail, app.name]);
    state.set(app.name, 'klaar');
  };
  for (const app of apps) visit(app, []);
}

// De instellingen van de organisatie voor één onderdeel: values/<naam>.yaml en
// values/<omgeving>/<naam>.yaml. Geeft de bestanden en het samengevoegde resultaat.
function orgValues(repo, env, name, extra = []) {
  const files = [`values/${name}.yaml`, ...extra, `values/${env}/${name}.yaml`].filter((file) => exists(path.join(repo, file)));
  const merged = files.reduce((all, file) => merge(all, readYaml(path.join(repo, file))), {});
  return { files, merged };
}

function checkConfig(part, values, env) {
  for (const [key, rule] of Object.entries(part.config ?? {})) {
    if (!rule?.verplicht) continue;
    const value = lookup(values.merged, key);
    eis(value !== undefined && value !== null && value !== '',
      `${part.name}: de verplichte instelling ${key} is niet ingevuld in values/${part.name}.yaml of values/${env}/${part.name}.yaml.`);
  }
}

// ---- de configuratie van LibreChat samenvoegen --------------------------------------

function composeCore(core, apps) {
  const doc = YAML.parseDocument(fs.readFileSync(path.join(core.source.dir, core.values), 'utf8'));
  const at = ['librechat', 'configYamlContent'];
  eis(typeof doc.getIn(at) === 'string', `De kern: ${core.values} bevat geen librechat.configYamlContent.`);
  const config = YAML.parseDocument(doc.getIn(at));
  const list = (where) => config.getIn(where)?.items ?? [];
  const specNames = new Set(list(['modelSpecs', 'list']).map((item) => item.get('name')));
  const servers = new Map(list(['mcpServers']).map((pair) => [String(pair.key), 'de kern']));

  for (const app of apps) {
    for (const [name, spec] of Object.entries(app.librechat.mcpServers ?? {})) {
      eis(!servers.has(name), `De tool "${name}" van de app ${app.name} bestaat al (van ${servers.get(name)}).`);
      servers.set(name, `de app ${app.name}`);
      for (const key of ['mcpSettings', 'mcpServers']) if (!config.has(key)) config.set(key, config.createNode({}));
      config.setIn(['mcpServers', name], config.createNode({
        type: 'streamable-http',
        url: spec.url,
        title: spec.title,
        ...(spec.pinned !== false && { chatMenu: false }),
        ...(spec.token && { headers: { Authorization: `Bearer \${${spec.token}}` } }),
      }));
      const allowed = config.getIn(['mcpSettings', 'allowedAddresses']);
      const address = new URL(spec.url).host;
      if (allowed) allowed.add(config.createNode(address));
      else config.setIn(['mcpSettings', 'allowedAddresses'], config.createNode([address]));
      if (spec.pinned !== false) {
        list(['modelSpecs', 'list']).forEach((_, index) => {
          const where = ['modelSpecs', 'list', index, 'mcpServers'];
          const pinned = config.getIn(where);
          if (pinned) pinned.add(config.createNode(name));
          else config.setIn(where, config.createNode([name]));
        });
      }
    }
    for (const spec of app.librechat.modelSpecs ?? []) {
      eis(spec?.name && !specNames.has(spec.name), `De assistent "${spec?.name}" van de app ${app.name} bestaat al of heeft geen naam.`);
      specNames.add(spec.name);
      config.getIn(['modelSpecs', 'list']).add(config.createNode(spec));
    }
  }
  if (servers.size) config.setIn(['interface', 'mcpServers', 'use'], true);
  doc.getIn(at, true).value = config.toString({ lineWidth: 0 });
  return doc.toString({ lineWidth: 0 });
}

// ---- schrijven ----------------------------------------------------------------------

const HEADER = '# Gegenereerd door de app-manager. Niet met de hand aanpassen: pas stacks/ of values/ aan\n# en stel opnieuw samen.\n';
const dump = (value) => HEADER + YAML.stringify(value, { lineWidth: 0 });

function chartRef(app) {
  if (/^oci:\/\//.test(app.chart)) return { chart: app.chart, version: app.version };
  if (app.source.commit === 'lokaal') return { chart: path.join(app.source.dir, app.chart) };
  return { chart: `git::${app.ref.url}//${app.chart}?ref=${app.ref.version}` };
}

function compose(repo, env, outDir) {
  const stack = loadStack(repo, env);
  const core = loadCore(repo, stack.core);
  const apps = stack.apps.map((ref) => loadApp(repo, ref, core));
  checkApps(apps);

  const files = new Map(); // pad binnen deploy/<omgeving>/ → inhoud
  const copy = (target, source) => files.set(target, fs.readFileSync(path.join(repo, source)));

  const coreValues = orgValues(repo, env, 'kern', ['values/branding.yaml']);
  checkConfig(core, coreValues, env);
  eis(lookup(coreValues.merged, 'librechat.configYamlContent') === undefined,
    'values/: librechat.configYamlContent is van de kern en mag hier niet worden overschreven. Wat erbij moet, komt uit een app.');
  const coreFiles = ['values-kern.yaml'];
  files.set('kern/values-kern.yaml', HEADER + composeCore(core, apps));
  coreValues.files.forEach((file, index) => {
    const name = `values-${index + 1}-${file.replace(/^values\//, '').replace(/[/]/g, '-')}`;
    coreFiles.push(name);
    copy(`kern/${name}`, file);
  });
  const withChart = apps.filter((app) => app.chart !== 'geen');
  files.set('kern/fleet.yaml', dump({
    defaultNamespace: stack.namespace,
    labels: { [LABEL]: 'kern' },
    helm: { releaseName: core.releaseName, chart: core.chart, version: core.chartVersion, valuesFiles: coreFiles, disablePreProcess: true },
    // De chat maakt bij het starten verbinding met de tools van de apps: eerst de apps.
    ...(withChart.length && { dependsOn: withChart.map((app) => ({ selector: { matchLabels: { [LABEL]: app.name } } })) }),
  }));

  for (const app of withChart) {
    const values = orgValues(repo, env, app.name);
    checkConfig(app, values, env);
    const valuesFiles = values.files.map((file, index) => {
      const name = `values-${index + 1}-${file.replace(/^values\//, '').replace(/[/]/g, '-')}`;
      copy(`${app.name}/${name}`, file);
      return name;
    });
    files.set(`${app.name}/fleet.yaml`, dump({
      defaultNamespace: stack.namespace,
      labels: { [LABEL]: app.name },
      helm: { releaseName: app.name, ...chartRef(app), ...(valuesFiles.length && { valuesFiles }) },
      ...(app.needs?.length && { dependsOn: app.needs.map((name) => ({ selector: { matchLabels: { [LABEL]: name } } })) }),
    }));
  }
  for (const app of apps.filter((a) => a.chart === 'geen')) checkConfig(app, orgValues(repo, env, app.name), env);

  fs.rmSync(outDir, { recursive: true, force: true }); // een app die niet gekozen is, laat niets achter
  for (const [file, content] of files) {
    fs.mkdirSync(path.dirname(path.join(outDir, file)), { recursive: true });
    fs.writeFileSync(path.join(outDir, file), content);
  }
  return { stack, core, apps };
}

function writeLock(repo, env, { core, apps }, check) {
  const file = path.join(repo, 'stack.lock');
  const lock = exists(file) ? readYaml(file) : {};
  const previous = lock[env] ?? [];
  const entries = [core, ...apps].map((part) => ({ name: part.name, url: part.ref.url, version: part.ref.version ?? part.version, commit: part.source.commit }));
  for (const entry of entries) {
    const before = previous.find((old) => old.url === entry.url && old.version === entry.version);
    eis(!before || before.commit === entry.commit || entry.commit === 'lokaal' || before.commit === 'lokaal',
      `${entry.url} ${entry.version} wijst nu naar commit ${entry.commit}, maar in stack.lock staat ${before?.commit}. De tag is verplaatst. Vertrouw je de nieuwe inhoud, haal de regel dan uit stack.lock en stel opnieuw samen.`);
  }
  lock[env] = entries;
  const text = '# Per omgeving de vastgelegde commit van elke versie. Bijgehouden door de app-manager.\n' + YAML.stringify(lock, { lineWidth: 0 });
  if (check) eis(exists(file) && fs.readFileSync(file, 'utf8') === text, 'stack.lock is niet bij: stel opnieuw samen en commit de uitkomst.');
  else fs.writeFileSync(file, text);
}

function listFiles(dir, base = dir) {
  if (!exists(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(path.join(dir, entry.name), base) : [path.relative(base, path.join(dir, entry.name))]).sort();
}

// ---- opdrachten ---------------------------------------------------------------------

function samenstellen(repo, env, check) {
  const target = path.join(repo, 'deploy', env);
  if (!check) {
    const result = compose(repo, env, target);
    writeLock(repo, env, result, false);
    console.log(`deploy/${env}/ is samengesteld: kern ${result.core.version}${result.apps.map((app) => `, ${app.name} ${app.version}`).join('')}.`);
    console.log('Er is niets gepusht. Volgende stappen: bekijk de wijziging (git diff), commit op een branch, open een pull request en laat een tweede persoon meekijken. De merge is de uitrol.');
    return;
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-'));
  try {
    const result = compose(repo, env, temp);
    const want = listFiles(temp);
    const have = listFiles(target);
    const different = [...new Set([...want, ...have])].filter((file) =>
      !want.includes(file) || !have.includes(file) || !fs.readFileSync(path.join(temp, file)).equals(fs.readFileSync(path.join(target, file))));
    eis(!different.length, `deploy/${env}/ past niet bij stacks/ en values/. Stel opnieuw samen en commit de uitkomst. Afwijkend: ${different.join(', ')}`);
    writeLock(repo, env, result, true);
    console.log(`deploy/${env}/ klopt met stacks/${env}.yaml en values/.`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// Zonder Fleet, voor een eigen laptop: toont de helm-opdrachten bij deploy/<omgeving>/.
// Voert zelf niets uit.
function lokaal(repo, env) {
  const base = path.join(repo, 'deploy', env);
  eis(exists(base), `deploy/${env}/ bestaat niet: stel eerst samen.`);
  const bundles = fs.readdirSync(base).filter((name) => exists(path.join(base, name, 'fleet.yaml')))
    .map((name) => ({ name, fleet: readYaml(path.join(base, name, 'fleet.yaml')) }));
  const order = [];
  const place = (bundle) => {
    if (order.includes(bundle)) return;
    for (const need of bundle.fleet.dependsOn ?? []) place(bundles.find((other) => other.name === need.selector.matchLabels[LABEL]));
    order.push(bundle);
  };
  bundles.forEach(place);
  const quote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;
  console.log('# Alleen voor een eigen wegwerpcluster. Op acceptatie en productie rolt Rancher uit.');
  for (const { name, fleet } of order) {
    const { helm } = fleet;
    let chart = helm.chart;
    const git = /^git::(.+)\/\/(.+)\?ref=(.+)$/.exec(chart);
    if (git) chart = path.join(repo, '.manager-cache', git[1].replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_'), git[3], git[2]);
    console.log(['helm upgrade --install', helm.releaseName, quote(chart), helm.version && /^oci:/.test(chart) ? `--version ${helm.version}` : '',
      `--namespace ${fleet.defaultNamespace} --create-namespace`,
      ...(helm.valuesFiles ?? []).map((file) => `-f ${quote(path.join(base, name, file))}`), '--wait --timeout 20m'].filter(Boolean).join(' '));
  }
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name) => { const at = args.indexOf(name); return at < 0 ? null : args.splice(at, 2)[1]; };
  const repo = path.resolve(flag('--repo') ?? '.');
  const check = args.includes('--controleer');
  const [command, env] = args.filter((arg) => !arg.startsWith('--'));
  try {
    eis(['samenstellen', 'lokaal'].includes(command) && env && NAME.test(env),
      'Gebruik: manager.js samenstellen <omgeving> [--repo <map>] [--controleer]\n         manager.js lokaal <omgeving> [--repo <map>]');
    if (command === 'samenstellen') samenstellen(repo, env, check);
    else lokaal(repo, env);
  } catch (error) {
    if (!(error instanceof Fout)) throw error;
    console.error(`FOUT: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { compose, merge, lookup };
