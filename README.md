> # ⚠️ LET OP: tijdelijke naam
> Deze repository heet nu `modulair-manager` omdat dit een pilot is voor een modulaire GovChat,
> gestart door Súdwest-Fryslân met toestemming van GovChat-NL. Werkt de pilot en is iedereen
> het eens, dan kan de naam in de toekomst `GovChat-NL-manager` worden.

# modulair-manager

De app-manager van GovChat. Hij stelt uit de keuzes van een organisatie de uitrol samen:
welke kern, welke apps, in welke versie en met welke instellingen.

LibreChat leest één configuratiebestand. Een losse app kan daar niet zelf in schrijven, en
Helm kan zulke stukken niet samenvoegen. Daarom is er een samensteller.

Dit is één van vier repositories die bij elkaar horen:

| Repository | Wat |
|---|---|
| [`modulair-kern`](https://github.com/GovChat-NL/modulair-kern) | de kale chat |
| [`modulair-app-time`](https://github.com/GovChat-NL/modulair-app-time) | de proefapp, en het voorbeeld van hoe een app eruitziet |
| [`modulair-manager`](https://github.com/GovChat-NL/modulair-manager) | de app-manager, die de uitrol samenstelt; hier staat ook het appcontract |
| [`modulair-deploy-template`](https://github.com/GovChat-NL/modulair-deploy-template) | de uitrolbasis waar een organisatie één keer een eigen repository van maakt |

## Wat hij doet

1. Hij leest `stacks/<omgeving>.yaml`: de kern en de apps, elk met een adres en een versie.
2. Hij haalt per adres die versie op en leest `kern.yaml` of `app.yaml`.
3. Hij controleert het contract, de versies, `requires` en de verplichte instellingen.
4. Hij schrijft per onderdeel een `fleet.yaml` in `deploy/<omgeving>/<naam>/`.
5. Hij schrijft één samengevoegde configuratie voor LibreChat: de kern plus wat elke gekozen app toevoegt.
6. Hij legt per versie de commit vast in `stack.lock`.

**Wat hij niet doet:** hij praat niet met het cluster, hij pusht nooit en hij heeft geen
token nodig. Hij schrijft alleen bestanden in de map waar je hem draait.

## Gebruiken

Nodig: [Node.js](https://nodejs.org) 20 of nieuwer en `git`.

```sh
git clone --branch v0.1.0 https://github.com/GovChat-NL/modulair-manager.git
cd modulair-manager && npm ci
```

In de uitrolrepository van de organisatie:

```sh
node <pad>/modulair-manager/manager.js samenstellen acceptatie
```

Daarna: bekijk de wijziging met `git diff`, commit op een branch, open een pull request
en laat een tweede persoon meekijken. De merge is de uitrol.

| Opdracht | Wat |
|---|---|
| `samenstellen <omgeving>` | Schrijft `deploy/<omgeving>/` en `stack.lock` |
| `samenstellen <omgeving> --controleer` | Schrijft niets. Faalt als `deploy/` of `stack.lock` niet past bij `stacks/` en `values/`. Bedoeld voor de controle bij een pull request |
| `lokaal <omgeving>` | Toont de `helm`-opdrachten bij `deploy/<omgeving>/`, voor een eigen laptop zonder Fleet. Voert zelf niets uit |

Met `--repo <map>` wijs je een andere map aan dan de huidige.

## Een app vanaf de schijf

Een adres mag ook een map zijn. Dan is er geen versie en geen vastgelegde commit; in
`stack.lock` staat `lokaal`. Dit is voor het bouwen van een app op de eigen laptop,
niet voor acceptatie of productie.

```yaml
apps:
  - url: ../modulair-app-mijnapp
```

## Waar hij op stopt

Bij elk van deze punten stopt het samenstellen met een foutmelding. Er wordt nooit stil
overschreven.

- een adres zonder volledige versie (`v1.2.3`), of een versie die niet op te halen is;
- een tag die anders is dan de versie in `app.yaml`;
- een adres dat niet in `allowedSources` staat;
- een tag die naar een andere commit wijst dan in `stack.lock` staat;
- een app die een ander contract volgt, of niet past bij de gekozen kern;
- een ontbrekende afhankelijkheid, of een die niet in het versiebereik valt;
- afhankelijkheden die in een kring naar elkaar verwijzen;
- twee apps met dezelfde naam, of dubbele namen van tools of assistenten;
- een verplichte instelling die niet is ingevuld;
- een titel van een tool waar LibreChat niet mee start;
- instellingen van de organisatie die `librechat.configYamlContent` overschrijven: dat deel is van de kern.

Een app die niet meer in de lijst staat, laat niets achter: `deploy/<omgeving>/` wordt
bij elke keer samenstellen opnieuw opgebouwd.

## Het appcontract

Staat in [CONTRACT.md](CONTRACT.md). Versie 1 is een concept.

## Testen

```sh
npm test
```

De tests stellen samen uit onderdelen op de schijf, zonder netwerk.

## Wat er nog niet is

- **Het scherm.** Het beheerpaneel van de branch `swf/modulairKern` (map `admin/`) is niet meegenomen: het bewerkte de bestanden van die branch en past niet op deze indeling. Dit is de samensteller als opdrachtregel.
- **De route via LiteLLM.** Staat LiteLLM aan, dan hoort de chat via LiteLLM te lopen. Dat is nog niet gebouwd.
- **Een image van de app-manager.** Er is een `Dockerfile`; het image wordt nog niet gepubliceerd.
- **Een toets tegen het schema van LibreChat.** Nu wordt alleen de titel van een tool gecontroleerd.
- **Fleet.** De `fleet.yaml`-bestanden zijn nog niet door Fleet uitgerold. Getest is de uitrol met `helm` op een lokaal cluster.

## Herkomst

Opnieuw geschreven op 27 november 2026. De regels voor het aanzetten van een MCP-server
komen uit `admin/server.js` van de branch `swf/modulairKern`, commit `7e2474d`. De
licentie is nog niet gekozen; het voorstel is EUPL-1.2 en het besluit ligt bij de
maintainers van GovChat-NL.
