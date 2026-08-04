'use strict';

/**
 * Registry of Hungarian power plants that matter for water accounting, together with
 * the model used to turn an electrical output (MW) into a water flow (m3/s).
 *
 * ---------------------------------------------------------------------------
 * WITHDRAWAL IS NOT CONSUMPTION
 * ---------------------------------------------------------------------------
 * This distinction is the single most important thing in the whole file, and the
 * thing most "power plant water use" numbers in the press get wrong.
 *
 *   withdrawal  - water taken out of the river (abstraction).
 *   discharge   - water put back, warmer.
 *   consumption - water that never comes back, because it evaporated.
 *
 * A once-through plant like Paks withdraws a huge flow and returns >99% of it. A
 * cooling-tower plant like Mátra withdraws a tiny flow and evaporates most of it.
 * Ranked by withdrawal, Paks dwarfs everything; ranked by consumption, the gap
 * nearly closes. The API always reports all three so a consumer cannot accidentally
 * compare a withdrawal against a consumption.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE LIVE POWER NUMBER COMES FROM
 * ---------------------------------------------------------------------------
 * MAVIR publishes real-time generation aggregated BY SOURCE TYPE, not per plant.
 * That distinction drives `powerSource` below:
 *
 *   'exclusive' - this plant is the only Hungarian generator of its source type,
 *                 so the aggregate IS this plant's output. True for nuclear/Paks.
 *                 Reported with confidence 'measured'.
 *   'allocated' - the plant shares its source-type aggregate with others. Its output
 *                 is estimated by distributing the aggregate across running units in
 *                 proportion to `capacityMw`. Reported with confidence 'estimated'.
 *
 * Never present an 'allocated' figure as a measurement of that specific plant.
 */

const PLANTS = [
  {
    id: 'paks-1',
    name: 'Paksi Atomerőmű (Paks I)',
    nameEn: 'Paks Nuclear Power Plant (Paks I)',
    type: 'nuclear',
    status: 'operating',
    lat: 46.5725,
    lon: 18.8547,
    capacityMw: 2000,
    unitCount: 4,
    // Matches how the units are named in ENTSO-E outage messages, so per-unit
    // availability can replace the guess the units model would otherwise make.
    entsoeUnitPattern: '^paks',
    receivingWater: 'Duna',
    receivingWaterStationId: 'duna-paks',
    intakeRiverKm: 1527,
    outfallRiverKm: 1526,
    powerSource: { mode: 'exclusive', mavirSourceType: 'nuclear' },
    cooling: {
      type: 'once_through',
      // Anchor of the linear model - the figure quoted for Paks at nominal output.
      nominalWithdrawalM3s: 105,
      // Fraction of withdrawal that never returns. Once-through plants lose only the
      // extra evaporation driven off the warmed river downstream of the outfall.
      consumptiveFraction: 0.006,
      // Thermodynamic model inputs (used when model=thermal).
      netElectricalEfficiency: 0.33,
      condenserDeltaTK: 9.7,
      // Minimum flow while the plant is shut down: service and emergency cooling
      // circuits keep running, so withdrawal never actually reaches zero.
      idleWithdrawalM3s: 4,
    },
    permit: {
      annualM3: 3.1e9,
      note: 'Regulatory abstraction ceiling commonly cited for Paks I.',
      confidence: 'indicative',
      verify: 'OKIRKapu / vízjogi üzemeltetési engedély',
    },
  },

  {
    id: 'paks-2',
    name: 'Paks II (épülő)',
    nameEn: 'Paks II (under construction)',
    type: 'nuclear',
    status: 'under_construction',
    lat: 46.5680,
    lon: 18.8480,
    capacityMw: 2400,
    unitCount: 2,
    receivingWater: 'Duna',
    receivingWaterStationId: 'duna-paks',
    // No live generation exists yet - this plant contributes 0 to every current figure
    // and is served only so the map can show planned water demand.
    powerSource: { mode: 'none' },
    cooling: {
      type: 'cooling_tower',
      nominalWithdrawalM3s: 3.6,
      consumptiveFraction: 0.8,
      netElectricalEfficiency: 0.36,
      condenserDeltaTK: 10,
      idleWithdrawalM3s: 0,
    },
    permit: {
      annualM3: null,
      note: 'Design water demand from the environmental impact study; hybrid cooling towers were the selected option. Figures are planning values, not an operating permit.',
      confidence: 'planning',
      verify: 'Paks II környezeti hatástanulmány (KHT)',
    },
  },

  {
    id: 'matra',
    name: 'Mátrai Erőmű (Visonta)',
    nameEn: 'Mátra Power Plant (Visonta)',
    type: 'lignite',
    status: 'operating',
    lat: 47.7692,
    lon: 20.0500,
    capacityMw: 950,
    receivingWater: 'Tisza (Kiskörei-tározó, távvezetéken)',
    powerSource: { mode: 'allocated', mavirSourceType: 'coal' },
    cooling: {
      type: 'cooling_tower',
      nominalWithdrawalM3s: 0.8,
      // Wet cooling towers reject heat by evaporating water. Most of what is
      // withdrawn is genuinely consumed - the opposite profile to Paks.
      consumptiveFraction: 0.8,
      netElectricalEfficiency: 0.32,
      stackLossFraction: 0.15,
      idleWithdrawalM3s: 0.05,
    },
    permit: { annualM3: null, confidence: 'unknown', verify: 'OKIRKapu' },
  },

  {
    id: 'gonyu',
    name: 'Gönyűi Erőmű',
    nameEn: 'Gönyű Power Plant',
    type: 'natural_gas_ccgt',
    status: 'operating',
    lat: 47.7333,
    lon: 17.8167,
    capacityMw: 433,
    receivingWater: 'Duna',
    powerSource: { mode: 'allocated', mavirSourceType: 'naturalGas' },
    cooling: {
      type: 'once_through',
      nominalWithdrawalM3s: 9,
      consumptiveFraction: 0.01,
      netElectricalEfficiency: 0.59,
      stackLossFraction: 0.5,
      condenserDeltaTK: 7,
      idleWithdrawalM3s: 0.2,
    },
    permit: { annualM3: null, confidence: 'unknown', verify: 'OKIRKapu' },
  },

  {
    id: 'dunamenti',
    name: 'Dunamenti Erőmű (Százhalombatta)',
    nameEn: 'Dunamenti Power Plant',
    type: 'natural_gas_ccgt',
    status: 'operating',
    lat: 47.3167,
    lon: 18.9333,
    capacityMw: 700,
    receivingWater: 'Duna',
    powerSource: { mode: 'allocated', mavirSourceType: 'naturalGas' },
    cooling: {
      type: 'once_through',
      nominalWithdrawalM3s: 14,
      consumptiveFraction: 0.01,
      netElectricalEfficiency: 0.5,
      stackLossFraction: 0.45,
      condenserDeltaTK: 7,
      idleWithdrawalM3s: 0.3,
    },
    permit: { annualM3: null, confidence: 'unknown', verify: 'OKIRKapu' },
  },

  {
    id: 'csepel-2',
    name: 'Csepeli Erőmű (Csepel II)',
    nameEn: 'Csepel II Power Plant',
    type: 'natural_gas_ccgt',
    status: 'operating',
    lat: 47.4167,
    lon: 19.0667,
    capacityMw: 410,
    receivingWater: 'Duna',
    powerSource: { mode: 'allocated', mavirSourceType: 'naturalGas' },
    cooling: {
      type: 'once_through',
      nominalWithdrawalM3s: 8,
      consumptiveFraction: 0.01,
      netElectricalEfficiency: 0.55,
      stackLossFraction: 0.5,
      condenserDeltaTK: 7,
      idleWithdrawalM3s: 0.2,
    },
    permit: { annualM3: null, confidence: 'unknown', verify: 'OKIRKapu' },
  },

  {
    id: 'tisza-2',
    name: 'Tiszai Erőmű (Tisza II)',
    nameEn: 'Tisza II Power Plant',
    type: 'natural_gas_steam',
    status: 'operating',
    lat: 47.9333,
    lon: 21.0500,
    capacityMw: 900,
    receivingWater: 'Tisza',
    receivingWaterStationId: 'tisza-szolnok',
    powerSource: { mode: 'allocated', mavirSourceType: 'naturalGas' },
    cooling: {
      type: 'once_through',
      nominalWithdrawalM3s: 41,
      consumptiveFraction: 0.012,
      netElectricalEfficiency: 0.36,
      stackLossFraction: 0.15,
      condenserDeltaTK: 7,
      idleWithdrawalM3s: 1,
    },
    permit: { annualM3: null, confidence: 'unknown', verify: 'OKIRKapu' },
    note: 'Withdraws from the Tisza, a river with roughly a third of the Danube\'s flow - so its relative thermal load is far higher than the raw m3/s suggests.',
  },

  {
    id: 'matra-pumped-storage',
    name: 'Szivattyús-tározós erőmű (tervezett)',
    nameEn: 'Pumped storage plant (planned)',
    type: 'pumped_storage',
    status: 'planned',
    lat: 47.9000,
    lon: 20.4000,
    capacityMw: 600,
    receivingWater: 'helyi vízfolyás / local watercourse',
    powerSource: { mode: 'none' },
    cooling: {
      // A closed-loop system. The water cycles between an upper and a lower reservoir
      // and is not consumed by generating - only evaporation from the open reservoir
      // surfaces has to be replaced, and that is driven by weather, not by MW.
      type: 'closed_loop',
      nominalWithdrawalM3s: 0,
      consumptiveFraction: 1,
      reservoirSurfaceM2: 1.2e6,
      // Net evaporation minus precipitation over a Hungarian reservoir, annualised.
      netEvaporationMmPerYear: 350,
      idleWithdrawalM3s: 0,
    },
    permit: { annualM3: null, confidence: 'planning', verify: 'KHT / vízjogi engedély' },
    note: 'Placeholder for the pumped-storage schemes under discussion. Water use is independent of instantaneous MW - do not scale it with generation.',
  },
];

const byId = new Map(PLANTS.map((p) => [p.id, p]));

function getPlant(id) {
  return byId.get(id) || null;
}

function listPlants(status) {
  return status ? PLANTS.filter((p) => p.status === status) : PLANTS.slice();
}

/** Plants that have a live generation figure available right now. */
function livePlants() {
  return PLANTS.filter((p) => p.powerSource.mode !== 'none' && p.status === 'operating');
}

/** Plants sharing a MAVIR source-type aggregate, used for proportional allocation. */
function plantsBySourceType(sourceType) {
  return livePlants().filter((p) => p.powerSource.mavirSourceType === sourceType);
}

module.exports = {
  PLANTS,
  getPlant,
  listPlants,
  livePlants,
  plantsBySourceType,
};
