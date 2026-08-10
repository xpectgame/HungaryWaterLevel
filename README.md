# HungaryWaterLevel

Magyarország felszíni vízmérlege és az erőművek hűtővíz-használata, közel valós időben,
egyetlen REST API-ból.

Két nyílt adatforrásból származtatva: **OVF** vízrajzi adatok (data.vizugy.hu) és
**MAVIR** villamosenergia-rendszer adatok. Ez egy független, származtatott termék —
egyik szervezet sem hitelesítette.

```bash
npm install
npm run backfill        # 30 nap szintetikus előzmény, hogy legyen mit nézni
npm start               # http://localhost:3000
```

Alapból `fixture` (szintetikus) adattal fut, tehát azonnal működik hálózat nélkül is.
Minden válasz `_meta.synthetic: true` mezőt kap — szintetikus vízadat soha nem szivároghat
ki valósként. Az éles bekötéshez lásd: [Éles üzem előtt](#éles-üzem-előtt).

---

## Végpontok

| Végpont | Mit ad |
|---|---|
| `GET /api/v1/snapshot` | **Vízmérleg + erőművi vízhasználat egyben** — ezt hívja a frontend |
| `GET /api/v1/balance` | Nettó vízforgalom (ΔQ) bizonytalansággal |
| `GET /api/v1/balance/history` | Mérleg idősor |
| `GET /api/v1/stations` | Mérőállomás-regiszter aktuális vízhozammal |
| `GET /api/v1/stations/:id/timeseries` | Egy állomás előzménye |
| `GET /api/v1/powerplants` | Erőművek modellezett vízhasználata |
| `GET /api/v1/powerplants/:id` | Egy erőmű + hőterhelés a befogadó folyóra |
| `GET /api/v1/water-use` | Erőművi összesítés, vízkivétel szerint rendezve |
| `GET /api/v1/lakes` | Balaton, Velencei-tó, Fertő — vízszint a saját rekordtartományában |
| `GET /api/v1/rainfall` | Csapadék 47 állomáson, mindegyik a **saját sokéves átlagához** mérve |
| `GET /api/v1/rainfall/:id` | Egy csapadékmérő napi bontásban |
| `GET /api/v1/events` | Miből mi következik + **`arrivals`**: mi van úton a folyón lefelé |
| `GET /api/v1/geojson` | Térképkész FeatureCollection |
| `GET /api/v1/meta/sources` | Adatforrások, licenc, **ismert korlátok** |
| `GET /api/v1/health` | Állapot és adatfrissesség |

Paraméterek: `?method=instant|lagged` (mérleg), `?model=linear|thermal` (hűtésmodell),
`?ungauged=true|false`, `?from=&to=&limit=`, `?days=7|30|90` (csapadék).

Teljes séma: `openapi.yaml`.

---

## Módszertan

A koncepció megépíthető, de a vázlatban szereplő képlet önmagában rossz eredményt ad.
Az alábbi pontokon tér el az implementáció, és mindegyiknek fizikai oka van.

### 1. A belépő szelvények listája duplán számolt

A vázlat belépő állomásként sorolta fel a **Duna/Nagymaros** és a **Tisza/Szeged**
szelvényt. Egyik sem határszelvény:

- **Nagymaros** 150 km-rel Rajka alatt van, az ott mért vizet Rajkánál már megszámoltuk.
  A kettő összeadása gyakorlatilag megduplázza a Dunát (~2000 m³/s hiba).
- **Szeged** 11 folyamkilométerrel Tiszasziget felett van — ugyanaz a víz.
- **Mura/Letenye** a Dráva/Őrtilos szelvény *felett* torkollik, tehát az Őrtilosnál mért
  570 m³/s **már tartalmazza** a Murát.

A regiszterben ezek `role: 'interior'` jelölést kapnak: lekérdezhetők és megjelennek a
térképen, de **soha nem kerülnek be az összegbe**. A `redundantWith` mező megmondja,
melyik állomást duplikálnák. (`src/config/stations.js`)

### 2. Hiányzott két jelentős beáramlás

A vázlatból kimaradt a **Szamos** (~120 m³/s, Csenger) és a **Körösök** rendszere
(Sebes-, Fekete-, Fehér-Körös + Berettyó, együtt ~75 m³/s). A Szamos önmagában nagyobb,
mint a Rába, Sajó és Hernád együtt. Ezek bekerültek, a Túrral, Krasznával, Bódvával,
Ipollyal, Lajtával, Pinkával és Répcével együtt — összesen 20 belépő szelvény.

### 3. A mért állomások nem fedik le a teljes beáramlást

A 20 belépő szelvény sokéves átlaga ~3350 m³/s, a publikált országos beáramlás viszont
~114 km³/év ≈ **3610 m³/s**. A különbség valós víz: apró határvízfolyásokon és
csatornákon érkezik.

Ha ezt elhagyjuk, a mérleg ~260 m³/s-mal negatívabbnak látszik — ami **nagyobb, mint maga
a mérendő jel**. Ezért külön, megnevezett tagként szerepel (`inflow.ungaugedM3s`), a
hálózat aktuális vízbőségével skálázva, és `?ungauged=false`-szal kikapcsolható.

### 4. A ΔQ két nagy szám különbsége — a hibája nagyobb, mint ő maga

Ez a projekt legfontosabb tanulsága.

| | m³/s |
|---|---|
| Beáramlás | ~3610 |
| Kiáramlás | ~3710 |
| **Nettó** | **~−100** |

A vízhozamot nem mérik közvetlenül: vízállásból számolják vízhozamgörbével, aminek
5–10% hibája van. Ez ~3600 m³/s-on állomásonként 150–250 m³/s, négyzetes összegzés után
**±200 m³/s** a nettó értéken.

Vagyis a tipikus válasz így néz ki:

```json
"net": {
  "m3s": 2.3,
  "uncertaintyM3s": 202.7,
  "significant": false,
  "interpretation": "The net difference is within measurement uncertainty - it cannot be distinguished from zero."
}
```

A `significant` flag akkor `true`, ha |net| > 2σ. **Általában `false` — és ez a helyes
válasz, nem hiba.** A frontend ezért a bizonytalanságot ugyanakkora vizuális súllyal
jeleníti meg, mint magát az értéket.

Egy szám bizonytalanság nélkül itt félrevezető lenne: minden 15 percben más előjelet
mutatna, és a nézője trendet olvasna ki a mérési zajból.

### 5. Az azonos időpontú összehasonlítás árvíznél fizikailag hibás

A Rajkánál ma belépő víz ~4 nap múlva hagyja el az országot Mohácsnál; a Felső-Tiszán ez
8+ nap. Nyugodt vízjárásnál ez nem számít, áradáskor viszont a belépő hullám hatalmas
hamis „nyereségként" jelenik meg, amíg ki nem lép.

A `?method=lagged` minden belépő állomást visszatol a saját futásidejével
(`travelTimeHours` a regiszterben), a kilépő szelvényeket pedig időbeli referenciaként
kezeli. Ha nincs elég előzmény, automatikusan `instant`-ra vált, és ezt a
`dataQuality.warnings`-ban jelzi.

A futásidők közelítések (árhullám-terjedési sebességből), és konfigurálhatók.

### 6. A MAVIR nem közöl erőművenkénti valós idejű termelést

Amit közöl: **energiaforrás szerinti** bontás (atom, lignit, földgáz, nap, szél…) 15
perces frissítéssel. Ez a vázlat egyetlen ténybeli tévedése — de szerencsés kimenetellel:

> **Paks I az egyetlen magyar atomerőmű**, tehát az „atom" aggregátum *pontosan*
> Paks termelése.

Vagyis épp az az erőmű olvasható közvetlenül, amelyik a vízkivétel ~60%-át adja.
Ezek a mezők `confidence: "measured"` jelölést kapnak.

A gázflotta (Dunamenti, Gönyű, Csepel, Tisza II) egy közös aggregátumon osztozik. Ezt
beépített teljesítmény arányában osztjuk szét — `confidence: "estimated"`, és minden
ilyen mező visz magával egy `caveat` mezőt, mert a valós menetrend költségalapú, nem
kapacitásarányos. **Az összegük megbízható, a köztük lévő felosztás nem.**

### 7. Vízkivétel ≠ vízfogyasztás

A vázlat ezt helyesen írta le, ezért elsőrendű mezővé tettük. Ez a legtöbb sajtóban
megjelenő „erőművi vízhasználat" szám hibája.

Az API mindhármat külön adja:

| | Paks I (frissvízhűtés) | Mátra (hűtőtornyos) |
|---|---|---|
| Vízkivétel | **100,9 m³/s** | 0,14 m³/s |
| Visszavezetés | 100,3 m³/s | 0,03 m³/s |
| **Tényleges fogyasztás** | **0,61 m³/s** | **0,11 m³/s** |

Paks 700-szor annyi vizet vesz ki, mint a Mátra — de csak 5-ször annyit *fogyaszt*.
A frissvízhűtés a vizet kölcsönveszi, nem elhasználja. A `/snapshot` ezért mindkét
arányt visszaadja (`powerWithdrawalShareOfInflow` és `powerConsumptionShareOfInflow`),
hogy a becsületes összehasonlítás ugyanolyan könnyen elérhető legyen, mint a látványos.

### 8. Két független hűtésmodell, keresztellenőrzésre

- **`linear`** (alapértelmezett, a vázlat képlete): `Q = P_aktuális / P_névleges × Q_névleges`
- **`thermal`**: a kondenzátorban leadandó hőből számol —
  `Q = P_hő / (ρ · c_p · ΔT)`

Paksra 2000 MW-on: **105 m³/s** (linear) vs **96 m³/s** (thermal) — 8% eltérés két
egymástól teljesen független úton. Ez validálja a modellt.

További konzisztencia-ellenőrzés: 105 m³/s × ~90% éves kihasználtság ≈ 2,98 milliárd
m³/év, épp a 3,1 milliárd m³/év hatósági korlát alatt. A két publikált szám egymással
összhangban van — de csak akkor, ha az üzemanyagcsere-leállásokat is beszámoljuk.
(Erre külön teszt van: `test/domain.test.js`)

Egy fenntartás: a valóságban diszkrét szivattyúk járnak. Egy négyblokkos erőmű 50%-on
általában két blokk teljes hűtővíz-árammal, nem négy blokk fél árammal. A modellek ennek
a lépcsős görbének a burkolói.

### 9. Szivattyús tározó: a vízhasználat nem függ a MW-tól

Zárt láncú rendszer — a víz fel-le mozog, a termelés nem fogyasztja. Csak a tározófelület
párolgását kell pótolni, amit az időjárás hajt, nem a teljesítmény. A `closed_loop`
modell ezért **szándékosan figyelmen kívül hagyja** a `powerMw` értéket.

### 10. Csapadék: a saját mérce archívuma az összehasonlítási alap

Egy vízhozamadat megmondja, mennyi víz van a folyóban. Azt nem, hogy miért — aszály idején
pedig egyedül ez a kérdés. A csapadék a rendszer bemenete, és mérhető: `AdatFajtaKod 71`,
a meteorológiai hálózat (`vmoType 14`) 441 közzétett állomásából 262 jelentett három napon
belül. **A minta növekmény**, nem folyószám, ezért egy időszak összege a mintáinak összege
— ami azért lényeges, mert a mérési gyakoriság állomásonként 15 perc és 1 nap között
változik, és az összegzés mindegyikre helyes.

A „szokásos" érték **ugyanannak a mércének a saját tízéves archívumából** jön, nem
klímaatlaszból. Egy atlaszérték rácscellára interpolált, és nagyobb mértékben térne el a
műszertől, mint amekkora jelet mérni akarunk. Két korlátot a válasz kimond:

* **Az alap egy friss évtized, nem harmincéves normál.** Ez az évtized Magyarországon
  száraz volt, így a hiány ehhez mérve inkább *kisebbnek* látszik a valóságosnál. A torzítás
  egy irányba mutat, és ez a helyes irány.
* **A hálózat nem országos.** A Közép-Duna-völgyi és a Közép-dunántúli igazgatóság
  területén nincs közzétett meteorológiai állomás, a Dél-dunántúlin egy sem jelentett, és a
  folyami mércék közül **egy sem** ad csapadékot (mind az 1193-at megkérdeztük). A Dunántúl
  ezért üres a térképen — nem azért, mert nem esett, hanem mert nem mérik ott.

Két adatminőségi szűrő, mindkettő valós hibából: egy hónap csak akkor számít bele az
átlagba, ha legalább 24 napja jelentett, és a 8 mm alatti havi „átlag" nem száraz hónap,
hanem fűtetlen mérce — Répcevis tíz teljes januárja 0,0 mm, májusa 96 mm; egy billenőedényes
mérő nem méri a havat.

### 11. Amit ez az adatforrás nem ad — és ezért nincs benne

Mindhármat lemértük, nem feltételeztük. `npm run probe -- --forecast --well-scan --matrix`
megismétli.

| Amit szeretnénk | Mit ad a szolgáltatás |
|---|---|
| **Előrejelzés** | `AdatTipusKod 5` („előrejelzett") **HTTP 500** minden állomásra, vízállásra és vízhozamra is, egyesével kérve is. A 6 („számított") és 15 („becsült") üres. Nincs mit lekérni. |
| **Talajvíz** | `AdatFajtaKod 69` **0 találat az 524 közzétett kútból** 60 napra visszamenőleg, minden adattípussal. A sekély talajvízszint ezen az API-n nem jelenik meg. |
| **Rétegvíz** | `AdatFajtaKod 70` működik, de 131 kút adott bármit 60 napra, és mindössze **12 jelentett egy héten belül** — abból 10 egyetlen igazgatóság területén. Ez nem országos kép. Ráadásul a rétegvíz a mély, zárt vízadó nyomásszintje: **nem azonos a talajvízzel**, és annak nevezni a legfélrevezetőbb dolog lenne, amit ez a projekt tehet. |
| **Belvíz** | Nincs rá mérőkód. A belvizet elöntött területként (hektár) jelentik, nem idősorként. |

Előrejelzés helyett az szerepel az oldalon, ami **őszintén állítható**: hol tart most a víz.
Ami ma elhalad Komárom alatt, az holnap ér Budapestre — ez nem modell, hanem ugyanaz a víz és
a szakasz futásideje. A futásidő a folyamkilométer-távolságból és a folyóra jellemző
hullámsebességből **származtatott**, nem kézzel beírt: egy elgépelt óraszám, ami nem stimmel a
két mérce távolságával, olyan hiba, amit soha senki nem venne észre.

---

## Éles üzem előtt

**A két upstream végpont nincs ellenőrizve.** A fejlesztőkörnyezetből a
`data.vizugy.hu`, `vizugy.hu` és `mavir.hu` egyaránt HTTP 403-at adott (hálózati
policy), így a pontos útvonalak és válaszformátumok nem voltak lemérhetők.

Ezért az adapterek nem tartalmaznak találgatott végpontot beégetve — a kérés és a
válasz-leképezés is konfiguráció. A hiányzó darab pótlása:

### Hol futtasd a probe-ot

Bárhol, ahonnan elérhető a két szolgáltatás. Növekvő sorrendben, amennyi telepítést igényel:

**1. GitHub Actions — semmit nem kell telepíteni.** Actions fül → *Probe upstream
endpoints* → *Run workflow*. A kimenet a job logjában olvasható. Ez a legegyszerűbb, és
egy futó ingyenes.

**2. Saját gép** — Node 22+ kell hozzá:

```bash
npm ci
npm run probe               # mindkét szolgáltatás
npm run probe -- --mavir    # csak MAVIR
npm run probe -- --url=https://data.vizugy.hu/valami/utvonal
```

Magyar IP-ről ez a legvalószínűbben működő út: ha egy szolgáltatás adatközponti
IP-ket tilt, a runner elbukik, a laptopod nem.

**3. Böngésző, kézzel.** Nyisd meg a portált, F12 → Network fül, tölts be egy
állomásgrafikont, és nézd meg, milyen URL-t hív. Utána azt add a `--url=` kapcsolónak.
Ez a legbiztosabb, ha a portál JavaScriptből tölti az adatot.

A `probe` kiírja a válasz alakját pontozott útvonalakként, amik közvetlenül
ráilleszthetők a `VIZUGY_ARRAY_PATH` / `VIZUGY_VALUE_FIELD` / `MAVIR_ARRAY_PATH`
beállításokra. Lásd `.env.example`.

**Konkrétan ez hiányzik:**

1. `src/sources/vizugy.js` → `EXTERNAL_IDS` — a portál saját állomás-azonosítói.
   Szándékosan üres: találgatott azonosítókkal az API csendben rossz folyót szolgálna ki.
2. A vízügyi végpont útvonala és válaszformátuma.
3. A MAVIR chart-végpont megerősítése (a `SERIES_ALIASES` ékezet- és kisbetű-érzéketlen,
   tehát a magyar sorozatnevek magukban felismerhetők).
4. Vízjogi engedélyek az OKIRKapuból — jelenleg `confidence: "unknown"` mezők.

Amíg ezek nincsenek meg, a `DATA_PROVIDER=live` üresen tér vissza, és a mérleg
klimatológiai átlagokra esik vissza, `quality: "climatology"` jelöléssel — nem hazudik
mérést.

---

## Architektúra

```
data.vizugy.hu ─┐
                ├─→ sources/ ─→ validate ─→ store (SQLite) ─→ domain/ ─→ routes/ ─→ JSON
mavir.hu ───────┘   (adapter)   (szűrés)    (idősor)         (mérleg,      (REST)
                                                              hűtés,
                                                              allokáció)
```

```
src/
├── config/     stations.js (30 állomás), powerplants.js (8 erőmű), index.js (env)
├── sources/    vizugy.js, mavir.js, fixture.js (szintetikus), index.js (választó)
├── domain/     balance.js (ΔQ + hibaterjedés), cooling.js (MW→m³/s),
│               allocation.js (aggregátum→erőmű), snapshot.js (összefűzés)
├── store/      timeseries.js (node:sqlite)
├── jobs/       poll.js (15 perces ciklus), probe.js (végpont-felderítés)
├── routes/     balance, stations, powerplants, geo, meta
└── lib/        http, jsonpath, validate, cache, params
```

**Tervezési döntések:**

- **SQLite** (`node:sqlite`, beépített) Postgres helyett: napi ~3000 sor, nincs szerver.
  A `store/timeseries.js` szűk interfész — Postgresre váltani egyetlen modul újraírása.
- **Az idősor a termelést tárolja, nem a vízértéket.** Így egy javított együttható
  visszamenőleg is javítja a történetet, ahelyett hogy a régi modell kimenete örökre
  bennragadna.
- **A mérleg-pillanatképek viszont mentődnek**, mert azok a történeti rekord — az utólagos
  újraszámolás más eredményt adna, és egy magát csendben átíró grafikon rosszabb, mint
  egy kicsit elavult.
- **A poller sosem dönti le a szervert**: az API a legutóbbi jó pillanatképet szolgálja
  ki, és jelzi a korát. A `/health` `degraded`-et ad, ha az adat állott.

## Tesztek

```bash
npm test    # 47 teszt
```

Lefedi a duplaszámolás elleni védelmet, a hibaterjedést, a klimatológiai visszaesést, a
futásidő-eltolást, mindkét hűtésmodellt, az allokáció bizalmi szintjeit, a
plauzibilitás-szűrést és a teljes HTTP réteget.

## Üzemeltetés

Két üzemmód van, ugyanabból a kódból.

### Szerver mód (teljes funkcionalitás)

Hosszan futó folyamat: 15 perces poller + SQLite lemezen. Ez tudja az idősorokat és a
futásidő-korrigált mérleget. Railway, Fly.io, Render vagy egy VPS.

```bash
DATA_PROVIDER=live NODE_ENV=production npm start
```

### Serverless mód (Vercel)

Serverlessen nincs perzisztens lemez és nincs folyamat két kérés között. Két változat van,
és a különbség nem elsősorban a történeti adat:

**A hálózati udvariasság a fő szempont.** Megosztott tároló nélkül minden hidegindított
instance maga kéri le az upstreamet — kb. 30 kérés a `data.vizugy.hu`-ra hidegindításonként.
Forgalom mellett ez óránként több száz kérés egy ingyenes állami szolgáltatás felé. Cronnal
+ megosztott tárolóval az upstream **pontosan egy ciklust lát ütemenként**, függetlenül
attól, hányan nézik.

| | memória | Postgres + cron |
|---|---|---|
| Upstream terhelés | forgalommal skálázódik | fix, 96 ciklus/nap |
| `/snapshot`, `/balance`, `/stations`, `/powerplants`, `/geojson` | ✅ | ✅ |
| `/balance/history`, `/stations/:id/timeseries` | az instance rövid ablaka | teljes |
| `?method=lagged` | visszaesik `instant`-ra | ✅ |
| Kell hozzá | semmi | egy Postgres URL |

A `DATABASE_URL` jelenléte automatikusan a Postgres útra vált (`STORE`-ral felülbírálható).
A `VERCEL=1`-et magától felismeri.

#### Vercel deploy (Pro)

A `vercel.json` mindent beállít, beleértve a 15 perces cront. **A `*/15 * * * *` ütemezés
Pro-t igényel** — Hobby tieren a cron csak napi egyszer fut.

1. Importáld a repót Vercelen.
2. Köss be egy Postgrest. Supabase-nél: *Project Settings → Database → Connection
   string → **Transaction pooler***. Ez a `...pooler.supabase.com:6543` végpont — **ne**
   a közvetlen 5432-est. A serverless vízszintesen skálázódik, és pool nélkül elfogynak
   a kapcsolatok.

   A store ehhez igazodik: a táblaneveket explicit módon minősíti séma-előtaggal, nem
   `search_path`-ra épít, mert a transaction mode pooler nem garantáltan továbbítja azt
   — és `SET search_path` sem élné túl a tranzakciók közti váltást. Ha ez nem így lenne,
   a store csendben a `public` sémába írna.
3. Környezeti változók:

```
DATABASE_URL=postgres://...            # a poololt URL
CRON_SECRET=<hosszú véletlen string>   # e nélkül a cron production-ben nem indul el
DATA_PROVIDER=fixture                  # amíg az upstream nincs bekötve
ALLOW_FIXTURE_IN_PRODUCTION=true       # ugyanezért
```

`fixture`-rel szintetikus adatot szolgál ki — sárga sáv jelzi a felületen, és minden
válaszban ott a `_meta.synthetic: true`. Ha az upstream bekötve, `DATA_PROVIDER=live`, és
az alsó két sor törölhető.

A `DATABASE_SCHEMA` opcionális: saját sémába teszi a táblákat, így egy ingyenes Postgres
megosztható más projektekkel.

#### Miért nem működne a naiv deploy

A `jobs/poll.js` háttér-intervalluma serverlessen soha nem fut le, mert a folyamat nem él
két kérés között. A `vercel.json`-beli cron az, ami ezt kiváltja — és a cron végpont
kifejezetten **hibát dob**, ha memóriás tárolóval hívják meg, mert olyankor egy olyan
instance memóriájába írna, amelyik utána egyetlen kérést sem szolgál ki. A 200-as válasz
és a semmittevés a legrosszabb kombináció.

### Lokálisan

```bash
STATELESS=true npm start                          # memóriás, on-demand
DATABASE_URL=postgres://... npm start             # Postgres
npm start                                         # SQLite + háttér-poller
```

Tesztek Postgres ellen is:

```bash
TEST_DATABASE_URL=postgres://... npm test         # 82 teszt
```

Ez azért számít: SQLite-tal egy elfelejtett `await` észrevétlenül működik, mert az érték
már ott van. Csak valódi async adatbázison bukik meg.

## Licenc és hivatkozás

Kód: MIT.

Az adatok az **OVF** (vízrajz) és a **MAVIR** (villamosenergia-rendszer) nyílt adatai.
Az OVF adatai ingyenesen felhasználhatók az OVF vagy az illetékes vízügyi igazgatóság
megjelölésével. Ezt a hivatkozást a `/api/v1/meta/sources` végpont is visszaadja, és a
frontend is kiírja.
