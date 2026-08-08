'use strict';

/**
 * Registry of the gauging stations that define Hungary's surface water balance.
 *
 * `role` decides whether a station enters the balance sum at all:
 *
 *   'inflow'    - water crosses the border INTO Hungary here. Counted in sum(Q_in).
 *   'outflow'   - water crosses the border OUT of Hungary here. Counted in sum(Q_out).
 *   'interior'  - inside the country, or redundant with another station. NEVER summed,
 *                 but still polled and exposed, because these are the gauges people
 *                 actually recognise (Budapest, Nagymaros, Szolnok...).
 *
 * The 'interior' role is the whole reason this file is verbose. Summing gauges that
 * sit downstream of each other double-counts the same water: Nagymaros carries the
 * water that was already counted at Rajka, and Dráva/Őrtilos already contains the
 * Mura. `redundantWith` records which station a gauge would duplicate.
 *
 * meanFlow (m3/s) is the long-term mean discharge. It is used for
 *   - sanity-checking incoming values (see lib/validate.js),
 *   - the climatological fallback when a gauge is stale or unreachable,
 *   - reporting how much of the balance is actually measured vs. estimated.
 * Figures are long-term averages from OVF/VITUKI hydrological yearbooks and should be
 * treated as ~2 significant figures.
 *
 * travelTimeHours is the approximate time for a discharge wave to propagate from this
 * station to the point where that water leaves the country. It is what makes a
 * same-timestamp inflow/outflow comparison physically wrong during a flood wave.
 * See domain/balance.js for how it is applied.
 *
 * uncertaintyPct is the relative 1-sigma uncertainty of the discharge value itself.
 * Discharge is not measured directly - it is read off a stage-discharge rating curve,
 * and that curve carries 5-10% error on a good river and more on a small, weir-affected
 * one. This dominates the error budget of the whole balance.
 */

const STATIONS = [
  // ---------------------------------------------------------------------------
  // DANUBE SYSTEM - inflow
  // ---------------------------------------------------------------------------
  {
    id: 'duna-rajka',
    name: 'Duna – Rajka',
    river: 'Duna',
    role: 'inflow',
    riverKm: 1848,
    lat: 47.9975,
    lon: 17.1997,
    country: 'SK/AT',
    meanFlow: 2020,
    travelTimeHours: 90,
    uncertaintyPct: 5,
    note:
      'Old Danube riverbed below the Cunovo diversion. NOT the total Danube inflow - see suspectedIssue.',
    // The live feed reads ~410 m3/s here against a long-term mean of 2020, and that is
    // not low water: the Danube's recorded minimum at Bratislava, 20 km upstream, is
    // several times this. The gauge sits at 1848 fkm, below the Cunovo diversion that
    // sends the bulk of the river into the Gabcikovo power canal on the Slovak side.
    // What passes Rajka is the released flow in the old riverbed; the canal rejoins
    // near Szap at about 1811 fkm.
    //
    // If that reading is right, summing Rajka as the Danube inflow understates the
    // country's total inflow by well over a thousand cubic metres a second - the
    // largest single error available in this project. It is left as 'inflow' rather
    // than quietly reassigned because the fix is a methodology decision (which section
    // represents the border) and not a config tweak, and because the balance response
    // surfaces suspectedIssue so the number is never presented as settled.
    suspectedIssue: 'below-diversion',
  },
  {
    id: 'lajta-mosonmagyarovar',
    name: 'Lajta – Mosonmagyaróvár',
    river: 'Lajta',
    role: 'inflow',
    lat: 47.8706,
    lon: 17.2712,
    country: 'AT',
    meanFlow: 8,
    travelTimeHours: 85,
    uncertaintyPct: 10,
  },
  {
    id: 'raba-szentgotthard',
    name: 'Rába – Szentgotthárd',
    river: 'Rába',
    role: 'inflow',
    lat: 46.9539,
    lon: 16.2811,
    country: 'AT',
    meanFlow: 28,
    travelTimeHours: 110,
    uncertaintyPct: 8,
  },
  {
    id: 'pinka-felsocsatar',
    name: 'Pinka – Felsőcsatár',
    river: 'Pinka',
    role: 'inflow',
    lat: 47.2072,
    lon: 16.4319,
    country: 'AT',
    meanFlow: 3,
    travelTimeHours: 115,
    uncertaintyPct: 12,
  },
  {
    id: 'repce-zsira',
    name: 'Répce – Zsira',
    river: 'Répce',
    role: 'inflow',
    lat: 47.4494,
    lon: 16.6858,
    country: 'AT',
    meanFlow: 3.5,
    travelTimeHours: 110,
    uncertaintyPct: 12,
  },
  {
    id: 'ipoly-ipolytarnoc',
    name: 'Ipoly – Ipolytarnóc',
    river: 'Ipoly',
    role: 'inflow',
    lat: 48.2358,
    lon: 19.6247,
    country: 'SK',
    meanFlow: 5,
    travelTimeHours: 70,
    uncertaintyPct: 12,
    note: 'Ipoly is a border river for most of its length; this is the upstream entry section.',
  },

  // ---------------------------------------------------------------------------
  // TISZA SYSTEM - inflow
  // ---------------------------------------------------------------------------
  {
    id: 'tisza-tiszabecs',
    name: 'Tisza – Tiszabecs',
    river: 'Tisza',
    role: 'inflow',
    riverKm: 744,
    lat: 48.1017,
    lon: 22.8161,
    country: 'UA',
    meanFlow: 143,
    travelTimeHours: 200,
    uncertaintyPct: 6,
    note: 'Upper Tisza entry section. Extremely flashy - can exceed 3000 m3/s during Carpathian floods.',
  },
  {
    id: 'tur-garbolc',
    name: 'Túr – Garbolc',
    river: 'Túr',
    role: 'inflow',
    lat: 48.0086,
    lon: 22.8981,
    country: 'UA',
    meanFlow: 5,
    travelTimeHours: 190,
    uncertaintyPct: 15,
  },
  {
    id: 'szamos-csenger',
    name: 'Szamos – Csenger',
    river: 'Szamos',
    role: 'inflow',
    lat: 47.8367,
    lon: 22.6836,
    country: 'RO',
    meanFlow: 120,
    travelTimeHours: 175,
    uncertaintyPct: 7,
    note: 'Third largest inflow after the Danube and Tisza. Frequently omitted from simplified balances.',
  },
  {
    id: 'kraszna-agerdomajor',
    name: 'Kraszna – Ágerdőmajor',
    river: 'Kraszna',
    role: 'inflow',
    lat: 47.8697,
    lon: 22.5033,
    country: 'RO',
    meanFlow: 9,
    travelTimeHours: 175,
    uncertaintyPct: 15,
  },
  {
    id: 'bodrog-felsoberecki',
    name: 'Bodrog – Felsőberecki',
    river: 'Bodrog',
    role: 'inflow',
    lat: 48.3861,
    lon: 21.6583,
    country: 'SK/UA',
    meanFlow: 116,
    travelTimeHours: 150,
    uncertaintyPct: 7,
  },
  {
    id: 'sajo-sajopuspoki',
    name: 'Sajó – Sajópüspöki',
    river: 'Sajó',
    role: 'inflow',
    lat: 48.2506,
    lon: 20.3097,
    country: 'SK',
    meanFlow: 28,
    travelTimeHours: 160,
    uncertaintyPct: 10,
  },
  {
    id: 'bodva-hidvegardo',
    name: 'Bódva – Hidvégardó',
    river: 'Bódva',
    role: 'inflow',
    lat: 48.5453,
    lon: 20.8281,
    country: 'SK',
    meanFlow: 5.6,
    travelTimeHours: 160,
    uncertaintyPct: 15,
  },
  {
    id: 'hernad-hidasnemeti',
    name: 'Hernád – Hidasnémeti',
    river: 'Hernád',
    role: 'inflow',
    lat: 48.5133,
    lon: 21.2597,
    country: 'SK',
    meanFlow: 29,
    travelTimeHours: 155,
    uncertaintyPct: 9,
  },

  // ---------------------------------------------------------------------------
  // KÖRÖS / MAROS SYSTEM - inflow
  // ---------------------------------------------------------------------------
  {
    id: 'sebes-koros-korosszakal',
    name: 'Sebes-Körös – Körösszakál',
    river: 'Sebes-Körös',
    role: 'inflow',
    lat: 47.0289,
    lon: 21.5981,
    country: 'RO',
    meanFlow: 26,
    travelTimeHours: 120,
    uncertaintyPct: 10,
  },
  {
    id: 'berettyo-pocsaj',
    name: 'Berettyó – Pocsaj',
    river: 'Berettyó',
    role: 'inflow',
    lat: 47.2856,
    lon: 21.8103,
    country: 'RO',
    meanFlow: 11,
    travelTimeHours: 120,
    uncertaintyPct: 13,
  },
  {
    id: 'fekete-koros-sarkad',
    name: 'Fekete-Körös – Sarkad (Ant)',
    river: 'Fekete-Körös',
    role: 'inflow',
    lat: 46.7439,
    lon: 21.4056,
    country: 'RO',
    meanFlow: 26,
    travelTimeHours: 115,
    uncertaintyPct: 10,
  },
  {
    id: 'feher-koros-gyula',
    name: 'Fehér-Körös – Gyula',
    river: 'Fehér-Körös',
    role: 'inflow',
    lat: 46.6439,
    lon: 21.2778,
    country: 'RO',
    meanFlow: 12,
    travelTimeHours: 115,
    uncertaintyPct: 11,
  },
  {
    id: 'maros-mako',
    name: 'Maros – Makó',
    river: 'Maros',
    role: 'inflow',
    lat: 46.2158,
    lon: 20.4808,
    country: 'RO',
    meanFlow: 184,
    travelTimeHours: 12,
    uncertaintyPct: 6,
    note: 'Standard Maros gauge, a short distance inside the border; enters the Tisza just above Szeged.',
  },

  // ---------------------------------------------------------------------------
  // DRÁVA SYSTEM - inflow
  // ---------------------------------------------------------------------------
  {
    id: 'drava-ortilos',
    name: 'Dráva – Őrtilos',
    river: 'Dráva',
    role: 'inflow',
    riverKm: 236,
    lat: 46.2769,
    lon: 16.8933,
    country: 'HR/SI',
    meanFlow: 570,
    travelTimeHours: 28,
    uncertaintyPct: 6,
    note: 'Sits ~1 km below the Mura confluence, so this value already contains the Mura.',
  },

  // ---------------------------------------------------------------------------
  // OUTFLOW - the three sections through which essentially all water leaves
  // ---------------------------------------------------------------------------
  {
    id: 'duna-mohacs',
    name: 'Duna – Mohács',
    river: 'Duna',
    role: 'outflow',
    riverKm: 1447,
    lat: 45.9939,
    lon: 18.6892,
    country: 'HR/RS',
    meanFlow: 2350,
    travelTimeHours: 0,
    uncertaintyPct: 5,
  },
  {
    id: 'drava-dravaszabolcs',
    name: 'Dráva – Drávaszabolcs',
    river: 'Dráva',
    role: 'outflow',
    riverKm: 68,
    lat: 45.8028,
    lon: 18.2181,
    country: 'HR',
    meanFlow: 595,
    travelTimeHours: 0,
    uncertaintyPct: 6,
    note: 'The Dráva leaves Hungary separately and joins the Danube inside Croatia, downstream of Mohács.',
  },
  {
    id: 'tisza-tiszasziget',
    name: 'Tisza – Tiszasziget',
    river: 'Tisza',
    role: 'outflow',
    riverKm: 163,
    lat: 46.1683,
    lon: 20.1531,
    country: 'RS',
    meanFlow: 820,
    travelTimeHours: 0,
    uncertaintyPct: 6,
  },

  // ---------------------------------------------------------------------------
  // INTERIOR / REDUNDANT - polled and served, never summed
  // ---------------------------------------------------------------------------
  {
    id: 'duna-nagymaros',
    name: 'Duna – Nagymaros',
    river: 'Duna',
    role: 'interior',
    riverKm: 1695,
    lat: 47.7906,
    lon: 18.9631,
    meanFlow: 2200,
    uncertaintyPct: 5,
    redundantWith: 'duna-rajka',
    note: 'Deep inside the country. Carries the water already counted at Rajka - summing both double-counts the Danube.',
  },
  {
    id: 'duna-budapest',
    name: 'Duna – Budapest',
    river: 'Duna',
    role: 'interior',
    riverKm: 1646,
    lat: 47.4979,
    lon: 19.0500,
    meanFlow: 2300,
    uncertaintyPct: 5,
    redundantWith: 'duna-rajka',
    note: 'Reference gauge of the country; kept for display, excluded from the balance.',
  },
  {
    id: 'duna-paks',
    name: 'Duna – Paks',
    river: 'Duna',
    role: 'interior',
    riverKm: 1531,
    lat: 46.5789,
    lon: 18.8558,
    meanFlow: 2320,
    uncertaintyPct: 5,
    redundantWith: 'duna-rajka',
    note: 'Receiving water body of the Paks nuclear plant. Used as the denominator for thermal load checks.',
  },
  {
    id: 'tisza-szeged',
    name: 'Tisza – Szeged',
    river: 'Tisza',
    role: 'interior',
    riverKm: 174,
    lat: 46.2530,
    lon: 20.1414,
    meanFlow: 815,
    uncertaintyPct: 6,
    redundantWith: 'tisza-tiszasziget',
    note: 'About 11 river km above the exit section - effectively the same water as Tiszasziget.',
  },
  {
    id: 'tisza-szolnok',
    name: 'Tisza – Szolnok',
    river: 'Tisza',
    role: 'interior',
    riverKm: 334,
    lat: 47.1747,
    lon: 20.1969,
    meanFlow: 570,
    uncertaintyPct: 6,
    redundantWith: 'tisza-tiszasziget',
  },
  {
    id: 'mura-letenye',
    name: 'Mura – Letenye',
    river: 'Mura',
    role: 'interior',
    lat: 46.4297,
    lon: 16.7208,
    meanFlow: 160,
    uncertaintyPct: 8,
    redundantWith: 'drava-ortilos',
    note: 'Joins the Dráva just above Őrtilos, so its water is already inside the Őrtilos reading.',
  },
];

/**
 * Long-term mean discharge that crosses the border through watercourses too small,
 * too numerous or too poorly gauged to list individually.
 *
 * The gauged inflow set above sums to ~3350 m3/s, while the published long-term mean
 * inflow for Hungary is ~114 km3/year (~3610 m3/s). The difference is real water, not a
 * mistake: it arrives through minor border streams and canals. Ignoring it makes the net
 * balance look ~300 m3/s more negative than it is, which is larger than the signal being
 * measured - so it is applied as an explicit, separately reported term rather than
 * silently folded into the total.
 */
const UNGAUGED_INFLOW = {
  meanFlow: 260,
  uncertaintyPct: 40,
  source: 'Difference between the gauged inflow set and the published long-term mean inflow (~114 km3/a).',
};

const byId = new Map(STATIONS.map((s) => [s.id, s]));

function getStation(id) {
  return byId.get(id) || null;
}

function listStations(role) {
  return role ? STATIONS.filter((s) => s.role === role) : STATIONS.slice();
}

/** Stations that are actually polled - everything, including interior display gauges. */
function pollableStations() {
  return STATIONS.slice();
}

/** Stations that participate in the balance sums. */
function balanceStations() {
  return STATIONS.filter((s) => s.role === 'inflow' || s.role === 'outflow');
}

module.exports = {
  STATIONS,
  UNGAUGED_INFLOW,
  getStation,
  listStations,
  pollableStations,
  balanceStations,
};
