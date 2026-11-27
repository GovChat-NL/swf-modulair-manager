# Het appcontract, versie 1 (concept)

Wat een app moet meebrengen om aan GovChat te kunnen worden toegevoegd. De app-manager
controleert dit. Het contract begint klein en groeit mee.

**Status:** concept van 27 november 2026. Nog niet vastgesteld.

## De repository van een app

| Wat | Verplicht | Toelichting |
|---|---|---|
| `app.yaml` in de hoofdmap | ja | Wat de app is en wat hij nodig heeft. Voor elke organisatie gelijk |
| Een Helm-chart | ja, of `chart: geen` | Een map in de repository of een OCI-adres. Geen `fleet.yaml`: die schrijft de app-manager |
| `USECASE.md` | ja | De opleverchecklist: de use case, de verzonnen testdata, de korte check en het bewijs |
| `controles/aanwezig.sh` en `controles/afwezig.sh` | ja | Tonen aan dat de app werkt, en dat er zonder de app niets van draait |
| `README.md` | ja | In het Nederlands |

Een versie is een tag `vX.Y.Z` volgens semver. De tag is gelijk aan `version` in
`app.yaml` en verandert daarna niet meer.

## `app.yaml`

```yaml
name: raadsvolger            # kleine letters, cijfers en streepjes
version: 0.1.0               # semver, gelijk aan de tag zonder de v
contract: v1
title: "Raadsvolger"         # wat een beheerder ziet
description: "Zoeken in raad en commissies, met bron."
kern: ">=0.1.0 <1.0.0"       # de versies van de kern waarmee de app werkt
chart: chart                 # een map in de repository, een oci://-adres, of: geen
requires:                    # andere apps die nodig zijn
  - url: https://github.com/GovChat-NL/modulair-app-time
    version: ">=1.0.0 <2.0.0"
librechat:                   # wat de app aan de chat toevoegt
  mcpServers:
    raadsvolger:
      url: "http://raadsvolger:8080/mcp"
      title: "Raadsvolger"
      pinned: true           # standaard true: hoort vast bij elke assistent
      token: RAADSVOLGER_TOKEN   # alleen als de server een token wil: de naam van de sleutel
  modelSpecs: []             # extra assistenten, in de vorm van LibreChat
config:                      # wat een organisatie moet of kan invullen in values/<naam>.yaml
  notubiz.organisatie: { verplicht: true }
  schedule: { standaard: "0 2 * * *" }
secrets: [NOTUBIZ_API_KEY]   # alleen namen, nooit waarden
data: bewaren                # wat er met de gegevens gebeurt bij verwijderen: geen, bewaren of opruimen
```

| Veld | Verplicht | Gecontroleerd door de app-manager |
|---|---|---|
| `name`, `version`, `contract` | ja | ja |
| `kern` | ja | ja, tegen de gekozen kern |
| `chart` | ja | of het veld er is |
| `requires` | nee | ja: aanwezig, versiebereik, geen kring |
| `librechat.mcpServers` | nee | ja: naam, adres binnen het cluster, titel, geen dubbele namen |
| `librechat.modelSpecs` | nee | ja: geen dubbele namen |
| `config` | nee | ja: `verplicht` moet zijn ingevuld |
| `title`, `description`, `secrets`, `data` | nee | nog niet |

## Regels voor de chart

1. De Service heet zoals de app en luistert op poort 8080. Een MCP-server luistert op `/mcp` en spreekt streamable HTTP. Geen stdio.
2. Elk onderdeel draagt het label `govchat.app: <naam>`.
3. Er is een NetworkPolicy die alleen LibreChat toelaat. Een verbinding naar buiten staat er alleen in als de use case haar noemt.
4. Het image heeft een vaste versie, draait niet als root en met een alleen-lezen bestandssysteem. Nergens `latest`.
5. De app draait in dezelfde namespace als de kern en raakt de gegevens van een andere app niet aan.
6. Secrets staan alleen bij naam in de chart en in `app.yaml`.

## Wat een app aan de chat mag toevoegen

Alleen MCP-servers en assistenten. Instellingen van de kern zijn van de kern: een app kan
ze niet veranderen. De titel van een MCP-server mag alleen letters, cijfers, spaties,
streepjes en apostroffen bevatten; LibreChat keurt anders het hele configuratiebestand af
en start niet.

## Uitbreiden zonder te breken

Een app zegt welke versie van het contract hij volgt (`contract: v1`). Nieuwe onderdelen
komen er als optie bij. Een verplicht nieuw onderdeel is een nieuwe hoofdversie; de
app-manager ondersteunt de vorige hoofdversie dan nog een tijd naast de nieuwe.

## Open

- De velden van `config` zijn in het Nederlands (`verplicht`, `standaard`), de rest in het Engels. Dat volgt het voorbeeld uit de aanpak van 27 november 2026. Eén taal kiezen.
- `secrets` en `data` worden nog niet gecontroleerd.
- Een app die standaard uit staat na installatie: nu is "in de lijst" gelijk aan "aan". Per assistent aan en uit is nog niet uitgewerkt.
- Geplande taken (CronJob) en opslag zijn nog niet beschreven.
