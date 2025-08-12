/*
  Framework-free dashboard logic
  - Parses Excel via SheetJS (XLSX) from CDN
  - Holds data entirely in-memory
  - Renders KPIs, region table, explorer tree, and detail views
*/

// Threshold helpers
const LOSS_THRESHOLDS = { greenMax: 2, amberMax: 5 }; // percent
const SLA_THRESHOLDS = { greenMin: 95, amberMin: 85 }; // percent

function classifyLoss(pct) {
  if (pct == null || isNaN(pct)) return { cls: "", label: "—" };
  if (pct < LOSS_THRESHOLDS.greenMax) return { cls: "badge-green", label: "Green" };
  if (pct <= LOSS_THRESHOLDS.amberMax) return { cls: "badge-amber", label: "Amber" };
  return { cls: "badge-red", label: "Red" };
}
function classifySla(pct) {
  if (pct == null || isNaN(pct)) return { cls: "", label: "—" };
  if (pct >= SLA_THRESHOLDS.greenMin) return { cls: "badge-green", label: "Green" };
  if (pct >= SLA_THRESHOLDS.amberMin) return { cls: "badge-amber", label: "Amber" };
  return { cls: "badge-red", label: "Red" };
}

// State
const state = {
  raw: null,
  regions: [], // [{ name, feeders:[{...}], metrics }]
  lookups: {
    regionByName: new Map(),
    feederById: new Map(),
    dtById: new Map(),
    meterById: new Map(),
  },
  currentSelection: { level: "ALL", id: null },
  sort: { key: "region", dir: "asc" },
  resultsRows: [],
  slaGlobal: { totalRows: 0, dailyYes: 0, loadYes: 0 },
};

// Sample schema note:
// Expect an Excel workbook with sheets providing Region, Feeder, DT, Meter relationships and readings.
// For demo, if no file uploaded, generate mock data to showcase UI.

document.addEventListener("DOMContentLoaded", () => {
  const globalSearch = document.getElementById("globalSearch");
  const regionFilter = document.getElementById("regionFilter");
  const lossRange = document.getElementById("lossRange");
  const slaRange = document.getElementById("slaRange");
  const accordionRegionFilter = document.getElementById("accordionRegionFilter");

  globalSearch.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onGlobalSearch(e.target.value.trim());
  });
  regionFilter.addEventListener("change", renderAll);
  lossRange.addEventListener("change", renderAll);
  slaRange.addEventListener("change", renderAll);
  accordionRegionFilter.addEventListener("change", renderAccordionTable);

  // Auto-load workbook from hardcoded path, fallback to mock
  autoLoadWorkbook();
});

async function autoLoadWorkbook() {
  const path = "sample_feeder_dt_meter_data.xlsx";
  try {
    const resp = await fetch(path);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    const data = new Uint8Array(buf);
    const workbook = XLSX.read(data, { type: "array" });
    document.getElementById("fileName").textContent = path;
    document.getElementById("processedTime").textContent = new Date().toLocaleString();
    parseWorkbook(workbook);
  } catch (err) {
    console.warn("Failed to load Excel from hardcoded path, using mock data.", err);
    bootstrapWithMockData();
  }
}

function parseWorkbook(workbook) {
  // This parser expects certain sheets. For now, support a generic sheet named "Data"
  // with columns: Region, FeederId, FeederName, DTId, DTName, MeterId, Day1, Day2, FeederEnergy, DTEnergy
  const sheetName = workbook.SheetNames.find((n) => n.toLowerCase().includes("data")) || workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

  buildModelFromRows(rows);
  renderAll();
}

function buildModelFromRows(rows) {
  // Reset state
  state.regions = [];
  state.lookups.regionByName.clear();
  state.lookups.feederById.clear();
  state.lookups.dtById.clear();
  state.lookups.meterById.clear();
  state.slaGlobal = { totalRows: 0, dailyYes: 0, loadYes: 0 };

  // Column helper getters tolerant to naming differences
  const getVal = (row, candidates) => {
    const keys = Object.keys(row);
    for (const cand of candidates) {
      const c = cand.toLowerCase();
      const key = keys.find((k) => k && k.toLowerCase() === c) || keys.find((k) => k && k.toLowerCase().includes(c));
      if (key) return row[key];
    }
    return undefined;
  };
  const getStr = (row, cands, fallback = undefined) => {
    const v = getVal(row, cands);
    return v == null ? fallback : String(v).trim();
  };
  const getNum = (row, cands, fallback = null) => {
    const v = getVal(row, cands);
    const n = Number(v);
    return isFinite(n) ? n : fallback;
  };

  // Group hierarchy
  for (const r of rows) {
    const regionName = getStr(r, ["Region Name", "Region", "RegionName"], "Unknown");

    const feederId = getStr(r, ["Feeder Code", "FeederId", "Feeder Code.", "Feeder Code ", "Feeder"], "F-?");
    const feederName = getStr(r, ["Feeder Name", "Feeder"], feederId);
    const feederDay1 = getNum(r, ["Feeder Day1 reading", "Feeder Day1 Read", "Feeder Day1"], null);
    const feederDay2 = getNum(r, ["Feeder Day2 reading", "Feeder Day2 Read", "Feeder Day2"], null);
    const feederMf = getNum(r, ["MF Feeder", "Feeder MF", "MF Feed"], 1);

    const dtId = getStr(r, ["DT Code", "DTId", "DT Code "], "DT-?");
    const dtName = getStr(r, ["DT Name", "DT"], dtId);
    const dtDay1 = getNum(r, ["DT Day1 Reading", "DT Day1", "DT Day1 Read"], null);
    const dtDay2 = getNum(r, ["DT Day2 Reading", "DT Day2", "DT Day2 Read"], null);
    const dtMf = getNum(r, ["MF DT", "DT MF", "MF"], 1);

    const meterId = getStr(r, ["Meter No", "Meter No.", "Meter Number", "Meter N", "Meter"], "M-?");
    const meterDay1 = getNum(r, ["Meter Day1 Reading", "Meter Day1", "Day1", "Reading Day1"], null);
    const meterDay2 = getNum(r, ["Meter Day2 Reading", "Meter Day2", "Day2", "Reading Day2"], null);
    const dailyEnergyFlagRaw = getVal(r, ["Daily energy", "Daily Energy", "Daily_energy"]);
    const loadDataRaw = getVal(r, ["Load Data", "LoadData", "Load_Data"]);
    const dailyEnergyYes = parseYesNo(dailyEnergyFlagRaw);
    const loadDataYes = parseYesNo(loadDataRaw);

    const feederEnergy = diffEnergy(feederDay1, feederDay2, feederMf);
    const dtEnergy = diffEnergy(dtDay1, dtDay2, dtMf);

    // SLA counters (overall + per region) work at raw-row granularity
    state.slaGlobal.totalRows += 1;
    if (dailyEnergyYes) state.slaGlobal.dailyYes += 1;
    if (loadDataYes) state.slaGlobal.loadYes += 1;

    // Region
    let region = state.lookups.regionByName.get(regionName);
    if (!region) {
      region = { name: regionName, feeders: [], metrics: {}, _sla: { totalRows: 0, dailyYes: 0, loadYes: 0 } };
      state.lookups.regionByName.set(regionName, region);
      state.regions.push(region);
    }

    // Increment per-region SLA counters
    region._sla.totalRows += 1;
    if (dailyEnergyYes) region._sla.dailyYes += 1;
    if (loadDataYes) region._sla.loadYes += 1;

    // Feeder
    let feeder = state.lookups.feederById.get(feederId);
    if (!feeder) {
      feeder = { id: feederId, name: feederName, dts: [], meters: [], metrics: {}, region: regionName };
      state.lookups.feederById.set(feederId, feeder);
      region.feeders.push(feeder);
    }

    // DT
    let dt = state.lookups.dtById.get(dtId);
    if (!dt) {
      dt = { id: dtId, name: dtName, meters: [], metrics: {}, feederId };
      state.lookups.dtById.set(dtId, dt);
      feeder.dts.push(dt);
    }

    // Meter
    let meter = state.lookups.meterById.get(meterId);
    if (!meter) {
      const energy = diffEnergy(meterDay1, meterDay2, 1);
      const slaDaily = dailyEnergyYes; // as per spec, use explicit Yes/No
      const slaLoad = loadDataYes;
      meter = { id: meterId, readings: { day1: meterDay1, day2: meterDay2 }, energy, sla: { daily: slaDaily, load: slaLoad }, dtId, feederId };
      state.lookups.meterById.set(meterId, meter);
      dt.meters.push(meter);
      feeder.meters.push(meter);
    }

    // Set energy metrics based on feeder/DT readings only once per asset
    // First occurrence rule: set energy only once per feeder/dt
    if (feeder.metrics._feEnergySet !== true && typeof feederEnergy === "number") {
      feeder.metrics.feederEnergy = feederEnergy;
      feeder.metrics._feEnergySet = true;
    }
    if (dt.metrics._dtEnergySet !== true && typeof dtEnergy === "number") {
      dt.metrics.dtEnergy = dtEnergy;
      dt.metrics._dtEnergySet = true;
    }
  }

  // Aggregate counts and KPIs
  for (const region of state.regions) {
    const allDts = region.feeders.flatMap((f) => f.dts);
    const allMeters = region.feeders.flatMap((f) => f.meters);

    const totals = {
      feeders: region.feeders.length,
      dts: allDts.length,
      meters: allMeters.length,
    };

    // Compute energies
    const feederEnergy = sum(region.feeders.map((f) => f.metrics.feederEnergy ?? sumDTEnergy(f)));
    const dtEnergy = sum(allDts.map((d) => d.metrics.dtEnergy ?? sumMeterEnergy(d)));
    const consumerEnergy = sum(allMeters.map((m) => m.energy ?? 0));

    // Losses
    const lossFdt = pctLoss(feederEnergy, dtEnergy);
    const lossDtc = pctLoss(dtEnergy, consumerEnergy);
    const lossFc = pctLoss(feederEnergy, consumerEnergy);

    // SLA per spec: percentages over raw rows for the region
    const slaDailyPct = pct(region._sla.dailyYes, region._sla.totalRows);
    const slaLoadPct = pct(region._sla.loadYes, region._sla.totalRows);

    region.metrics = { ...totals, feederEnergy, dtEnergy, consumerEnergy, lossFdt, lossDtc, lossFc, slaDailyPct, slaLoadPct };

    // For feeder/dt also compute summaries
    for (const feeder of region.feeders) {
      const dts = feeder.dts;
      const meters = feeder.meters;
      const fFeederEnergy = feeder.metrics.feederEnergy ?? sumDTEnergy(feeder);
      const fDtEnergy = sum(dts.map((d) => d.metrics.dtEnergy ?? sumMeterEnergy(d)));
      const fConsumerEnergy = sum(meters.map((m) => m.energy ?? 0));
      const fLossFdt = pctLoss(fFeederEnergy, fDtEnergy);
      const fLossDtc = pctLoss(fDtEnergy, fConsumerEnergy);
      const fLossFc = pctLoss(fFeederEnergy, fConsumerEnergy);
      // For feeder/DT-level we keep SLA based on meters presence for UI detail; region/overall use raw rows
      const fSlaDaily = pct(meters.filter((m) => m.sla.daily).length, meters.length);
      const fSlaLoad = pct(meters.filter((m) => m.sla.load).length, meters.length);
      feeder.metrics = {
        ...feeder.metrics,
        feeders: 1,
        dts: dts.length,
        meters: meters.length,
        feederEnergy: fFeederEnergy,
        dtEnergy: fDtEnergy,
        consumerEnergy: fConsumerEnergy,
        lossFdt: fLossFdt,
        lossDtc: fLossDtc,
        lossFc: fLossFc,
        slaDailyPct: fSlaDaily,
        slaLoadPct: fSlaLoad,
      };
    }

    for (const dt of allDts) {
      const meters = dt.meters;
      const dtEnergyVal = dt.metrics.dtEnergy ?? sumMeterEnergy(dt);
      const consumerEnergyVal = sum(meters.map((m) => m.energy ?? 0));
      const lossDtcVal = pctLoss(dtEnergyVal, consumerEnergyVal);
      const slaDailyVal = pct(meters.filter((m) => m.sla.daily).length, meters.length);
      const slaLoadVal = pct(meters.filter((m) => m.sla.load).length, meters.length);
      dt.metrics = {
        ...dt.metrics,
        meters: meters.length,
        dtEnergy: dtEnergyVal,
        consumerEnergy: consumerEnergyVal,
        lossDtc: lossDtcVal,
        slaDailyPct: slaDailyVal,
        slaLoadPct: slaLoadVal,
      };
    }
  }

  // Build results table rows per the specification
  buildResultsTable();
}

function renderAll() {
  renderKpis();
  renderRegionFilter();
  renderRegionTable();
  renderTree();
  renderDetail();
  renderAccordionFilters();
  renderAccordionTable();
}

function renderKpis() {
  const kpiGrid = document.getElementById("kpiGrid");
  const totals = computeGlobalTotals();
  const tiles = [
    { label: "Total Feeders", value: totals.feeders, hint: "Total feeders", badge: "Static" },
    { label: "Total DTs", value: totals.dts, hint: "Total DTs", badge: "Static" },
    { label: "Total Consumer Meters", value: totals.meters, hint: "Total meters", badge: "Static" },
    { label: "SLA Daily Energy %", value: fmtPct(totals.slaDailyPct), badge: classifySla(totals.slaDailyPct).label, className: classifySla(totals.slaDailyPct).cls, hint: "Rows with Daily energy = Yes" },
    { label: "SLA Load Data %", value: fmtPct(totals.slaLoadPct), badge: classifySla(totals.slaLoadPct).label, className: classifySla(totals.slaLoadPct).cls, hint: "Rows with Load Data = Yes" },
  ];

  kpiGrid.innerHTML = tiles.map((t) => `
    <div class="kpi" title="${escapeHtml(t.hint)}">
      <div class="label">${t.label}</div>
      <div class="value ${t.className ?? ''}">${t.value}</div>
      <div class="badge">${t.badge}</div>
      <div class="hint">${t.hint}</div>
    </div>
  `).join("");
}

function renderPerAssetLossList() {
  const container = document.getElementById("perAssetLossList");
  const feeders = Array.from(state.lookups.feederById.values());
  const html = feeders.map((f) => {
    const fE = f.metrics.feederEnergy ?? 0;
    const sumDt = f.dts.reduce((acc, d) => acc + (d.metrics.dtEnergy ?? 0), 0);
    const fLoss = fE ? Number((((fE - sumDt) / fE) * 100).toFixed(2)) : null;
    const fHeader = `<div><strong>${escapeHtml(f.id)}</strong> – Feeder→DT Loss % = ${fmtPctOrDash(fLoss)}</div>`;
    const dtLines = f.dts.map((d) => {
      const dE = d.metrics.dtEnergy ?? 0;
      const sumCons = d.meters.reduce((acc, m) => acc + (m.energy ?? 0), 0);
      const dLoss = dE ? Number((((dE - sumCons) / dE) * 100).toFixed(2)) : null;
      return `<div style="margin-left:16px;">${escapeHtml(d.id)} – DT→Consumer Loss % = ${fmtPctOrDash(dLoss)}</div>`;
    }).join("");
    return fHeader + dtLines;
  }).join("");
  container.innerHTML = html || '<div class="pad">No data.</div>';
}

function computeGlobalTotals() {
  const regions = state.regions;
  const feeders = sum(regions.map((r) => r.metrics.feeders ?? 0));
  const dts = sum(regions.map((r) => r.metrics.dts ?? 0));
  const meters = sum(regions.map((r) => r.metrics.meters ?? 0));
  const feederEnergy = sum(regions.map((r) => r.metrics.feederEnergy ?? 0));
  const dtEnergy = sum(regions.map((r) => r.metrics.dtEnergy ?? 0));
  const consumerEnergy = sum(regions.map((r) => r.metrics.consumerEnergy ?? 0));

  const lossFdt = pctLoss(feederEnergy, dtEnergy);
  const lossDtc = pctLoss(dtEnergy, consumerEnergy);
  const lossFc = pctLoss(feederEnergy, consumerEnergy);

  // Overall SLA per spec: ratio over all raw records
  const totalRows = state.slaGlobal.totalRows || 0;
  const slaDailyPct = totalRows ? Number(((state.slaGlobal.dailyYes / totalRows) * 100).toFixed(2)) : 0;
  const slaLoadPct = totalRows ? Number(((state.slaGlobal.loadYes / totalRows) * 100).toFixed(2)) : 0;

  return { feeders, dts, meters, lossFdt, lossDtc, lossFc, slaDailyPct, slaLoadPct };
}

function renderRegionFilter() {
  const select = document.getElementById("regionFilter");
  const prev = select.value;
  const options = ["__ALL__", ...state.regions.map((r) => r.name)];
  select.innerHTML = options.map((opt) => `<option value="${escapeHtml(opt)}">${opt === "__ALL__" ? "All Regions" : escapeHtml(opt)}</option>`).join("");
  if (options.includes(prev)) select.value = prev;
}

function renderRegionTable() {
  const tbody = document.querySelector("#regionTable tbody");
  const regionFilter = document.getElementById("regionFilter").value;
  const lossRange = document.getElementById("lossRange").value;
  const slaRange = document.getElementById("slaRange").value;

  let regions = state.regions.map((r) => ({
    region: r.name,
    feeders: r.metrics.feeders,
    dts: r.metrics.dts,
    meters: r.metrics.meters,
    lossFdt: r.metrics.lossFdt,
    lossDtc: r.metrics.lossDtc,
    lossFc: r.metrics.lossFc,
    slaDaily: r.metrics.slaDailyPct,
    slaLoad: r.metrics.slaLoadPct,
  }));

  if (regionFilter !== "__ALL__") regions = regions.filter((x) => x.region === regionFilter);
  if (lossRange !== "__ANY__") regions = regions.filter((x) => classifyLoss(x.lossFc).label.toUpperCase() === lossRange);
  if (slaRange !== "__ANY__") regions = regions.filter((x) => classifySla(x.slaDaily).label.toUpperCase() === slaRange);

  regions.sort((a, b) => {
    const { key, dir } = state.sort;
    const av = a[key];
    const bv = b[key];
    if (typeof av === "string" && typeof bv === "string") return dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    return dir === "asc" ? (av - bv) : (bv - av);
  });

  tbody.innerHTML = regions.map((r) => `
    <tr>
      <td><button class="link" data-action="open-region" data-region="${escapeHtml(r.region)}">${escapeHtml(r.region)}</button></td>
      <td>${r.feeders}</td>
      <td>${r.dts}</td>
      <td>${r.meters}</td>
      <td>${renderBadgePct(r.lossFdt, classifyLoss)}</td>
      <td>${renderBadgePct(r.lossDtc, classifyLoss)}</td>
      <td>${renderBadgePct(r.lossFc, classifyLoss)}</td>
      <td>${renderBadgePct(r.slaDaily, classifySla)}</td>
      <td>${renderBadgePct(r.slaLoad, classifySla)}</td>
    </tr>
  `).join("");

  // header sort interactions
  const headers = document.querySelectorAll("#regionTable thead th");
  headers.forEach((th) => {
    th.onclick = () => {
      const key = th.dataset.key;
      if (!key) return;
      if (state.sort.key === key) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      else state.sort = { key, dir: "asc" };
      renderRegionTable();
    };
  });

  // open region handlers
  tbody.querySelectorAll("[data-action='open-region']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.getAttribute("data-region");
      state.currentSelection = { level: "REGION", id: name };
      renderDetail();
    });
  });
}

function renderTree() {
  const tree = document.getElementById("tree");
  const regionFilter = document.getElementById("regionFilter").value;
  const regions = state.regions.filter((r) => regionFilter === "__ALL__" || r.name === regionFilter);
  tree.innerHTML = regions.map((r) => `
    <div class="node" data-type="region" data-id="${escapeHtml(r.name)}">
      <span class="icon">▸</span>
      <span class="label">${escapeHtml(r.name)}</span>
      <span class="meta">${r.metrics.feeders}F • ${r.metrics.dts}DT • ${r.metrics.meters}M</span>
    </div>
    <div class="children">
      ${r.feeders.map((f) => `
        <div class="node" data-type="feeder" data-id="${escapeHtml(f.id)}">
          <span class="icon">▸</span>
          <span class="label">Feeder ${escapeHtml(f.name)}</span>
          <span class="meta">${f.metrics.dts ?? f.dts.length}DT • ${f.metrics.meters ?? f.meters.length}M</span>
        </div>
        <div class="children">
          ${f.dts.map((d) => `
            <div class="node" data-type="dt" data-id="${escapeHtml(d.id)}">
              <span class="icon">▸</span>
              <span class="label">DT ${escapeHtml(d.name)}</span>
              <span class="meta">${d.meters.length}M</span>
            </div>
            <div class="children">
              ${d.meters.map((m) => `
                <div class="node" data-type="meter" data-id="${escapeHtml(m.id)}">
                  <span class="icon">●</span>
                  <span class="label">Meter ${escapeHtml(m.id)}</span>
                  <span class="meta">${fmtPct(m.sla.daily ? 100 : 0)} daily</span>
                </div>
              `).join("")}
            </div>
          `).join("")}
        </div>
      `).join("")}
    </div>
  `).join("");

  // expand/collapse and select
  tree.querySelectorAll(".node").forEach((node) => {
    node.addEventListener("click", (e) => {
      const type = node.getAttribute("data-type");
      const id = node.getAttribute("data-id");
      const icon = node.querySelector(".icon");
      const next = node.nextElementSibling;
      if (next && next.classList.contains("children")) {
        node.classList.toggle("open");
        icon.textContent = node.classList.contains("open") ? "▾" : "▸";
      }
      state.currentSelection = { level: type.toUpperCase(), id };
      renderDetail();
      e.stopPropagation();
    });
  });
}

function renderDetail() {
  const title = document.getElementById("detailTitle");
  const metricsWrap = document.getElementById("detailMetrics");
  const body = document.getElementById("detailBody");
  const sel = state.currentSelection;

  if (sel.level === "ALL") {
    title.textContent = "Overall";
    const totals = computeGlobalTotals();
    metricsWrap.innerHTML = renderMetricGrid([
      ["Feeders", totals.feeders],
      ["DTs", totals.dts],
      ["Meters", totals.meters],
      ["F→DT Loss%", fmtPct(totals.lossFdt)],
      ["DT→Cons Loss%", fmtPct(totals.lossDtc)],
      ["F→Cons Loss%", fmtPct(totals.lossFc)],
      ["SLA Daily%", fmtPct(totals.slaDailyPct)],
      ["SLA Load%", fmtPct(totals.slaLoadPct)],
    ]);
    body.innerHTML = "<div class='pad'>Use the explorer or table to drill down.</div>";
    return;
  }

  if (sel.level === "REGION") {
    const region = state.lookups.regionByName.get(sel.id);
    if (!region) return;
    title.textContent = `Region: ${region.name}`;
    const m = region.metrics;
    metricsWrap.innerHTML = renderMetricGrid([
      ["Feeders", m.feeders],
      ["DTs", m.dts],
      ["Meters", m.meters],
      ["F→DT Loss%", fmtPct(m.lossFdt)],
      ["DT→Cons Loss%", fmtPct(m.lossDtc)],
      ["F→Cons Loss%", fmtPct(m.lossFc)],
      ["SLA Daily%", fmtPct(m.slaDailyPct)],
      ["SLA Load%", fmtPct(m.slaLoadPct)],
    ]);
    body.innerHTML = renderFeederTable(region.feeders);
    attachFeederRowHandlers();
    return;
  }

  if (sel.level === "FEEDER") {
    const feeder = state.lookups.feederById.get(sel.id);
    if (!feeder) return;
    title.textContent = `Feeder: ${feeder.name}`;
    const m = feeder.metrics;
    metricsWrap.innerHTML = renderMetricGrid([
      ["DTs", m.dts],
      ["Meters", m.meters],
      ["F→DT Loss%", fmtPct(m.lossFdt)],
      ["DT→Cons Loss%", fmtPct(m.lossDtc)],
      ["F→Cons Loss%", fmtPct(m.lossFc)],
      ["SLA Daily%", fmtPct(m.slaDailyPct)],
      ["SLA Load%", fmtPct(m.slaLoadPct)],
    ]);
    body.innerHTML = renderDtTable(feeder.dts);
    attachDtRowHandlers();
    return;
  }

  if (sel.level === "DT") {
    const dt = state.lookups.dtById.get(sel.id);
    if (!dt) return;
    title.textContent = `DT: ${dt.name}`;
    const m = dt.metrics;
    metricsWrap.innerHTML = renderMetricGrid([
      ["Meters", m.meters],
      ["DT→Cons Loss%", fmtPct(m.lossDtc)],
      ["SLA Daily%", fmtPct(m.slaDailyPct)],
      ["SLA Load%", fmtPct(m.slaLoadPct)],
    ]);
    body.innerHTML = renderMeterTable(dt.meters);
    return;
  }

  if (sel.level === "METER") {
    const meter = state.lookups.meterById.get(sel.id);
    if (!meter) return;
    title.textContent = `Meter: ${meter.id}`;
    metricsWrap.innerHTML = renderMetricGrid([
      ["Reading Day1", meter.readings.day1 ?? "—"],
      ["Reading Day2", meter.readings.day2 ?? "—"],
      ["Energy", meter.energy ?? 0],
      ["SLA Daily", meter.sla.daily ? "Yes" : "No"],
      ["SLA Load", meter.sla.load ? "Yes" : "No"],
    ]);
    body.innerHTML = "";
    return;
  }
}

function onGlobalSearch(query) {
  if (!query) return;
  // try meter
  if (state.lookups.meterById.has(query)) {
    state.currentSelection = { level: "METER", id: query };
    renderDetail();
    return;
  }
  if (state.lookups.dtById.has(query)) {
    state.currentSelection = { level: "DT", id: query };
    renderDetail();
    return;
  }
  if (state.lookups.feederById.has(query)) {
    state.currentSelection = { level: "FEEDER", id: query };
    renderDetail();
    return;
  }
  if (state.lookups.regionByName.has(query)) {
    state.currentSelection = { level: "REGION", id: query };
    renderDetail();
    return;
  }
  alert("No match found. Use exact Region/Feeder/DT/Meter identifier.");
}

function buildResultsTable() {
  const uniqueFeeders = Array.from(state.lookups.feederById.values());
  const uniqueDts = Array.from(state.lookups.dtById.values());
  const uniqueMeters = Array.from(state.lookups.meterById.values());

  // Cons_E per meter (dedup + non-negative rule)
  const meterEnergyById = new Map();
  for (const m of uniqueMeters) {
    const energy = m.energy;
    if (energy == null) continue;
    if (energy < 0) continue; // flag for review: we exclude negatives from sums
    meterEnergyById.set(m.id, energy);
  }

  // DT_E per DT (dedup + non-negative)
  const dtEnergyById = new Map();
  for (const d of uniqueDts) {
    const e = d.metrics.dtEnergy;
    if (e == null) continue;
    if (e < 0) continue;
    dtEnergyById.set(d.id, e);
  }

  // Feeder_E per feeder (dedup + non-negative)
  const feederEnergyById = new Map();
  for (const f of uniqueFeeders) {
    const e = f.metrics.feederEnergy;
    if (e == null) continue;
    if (e < 0) continue;
    feederEnergyById.set(f.id, e);
  }

  // Aggregations
  const sumConsByDt = new Map();
  for (const m of uniqueMeters) {
    const e = meterEnergyById.get(m.id) ?? 0;
    sumConsByDt.set(m.dtId, (sumConsByDt.get(m.dtId) ?? 0) + e);
  }

  const sumDtByFeeder = new Map();
  for (const d of uniqueDts) {
    const e = dtEnergyById.get(d.id) ?? 0;
    sumDtByFeeder.set(d.feederId, (sumDtByFeeder.get(d.feederId) ?? 0) + e);
  }

  const sumConsByFeeder = new Map();
  for (const m of uniqueMeters) {
    const e = meterEnergyById.get(m.id) ?? 0;
    sumConsByFeeder.set(m.feederId, (sumConsByFeeder.get(m.feederId) ?? 0) + e);
  }

  // Build rows
  const rows = [];

  // Rows at feeder-level paired with blank DT columns
  for (const f of uniqueFeeders) {
    const Feeder_Code = f.id;
    const Feeder_E = feederEnergyById.get(Feeder_Code) ?? null;
    const Sum_DT_E = sumDtByFeeder.get(Feeder_Code) ?? 0;
    const Sum_Cons_E = sumConsByFeeder.get(Feeder_Code) ?? 0;
    const Feeder_to_DT_Loss = lossOrNull(Feeder_E, Sum_DT_E);
    const Feeder_to_Cons_Loss = lossOrNull(Feeder_E, Sum_Cons_E);

    rows.push({
      Feeder_Code,
      Feeder_E,
      Sum_DT_E,
      Feeder_to_DT_Loss,
      Sum_Cons_E,
      Feeder_to_Cons_Loss,
      DT_Code: "",
      DT_E: null,
      Sum_Cons_E_for_DT: null,
      DT_to_Cons_Loss: null,
    });
  }

  // Rows at DT-level
  for (const d of uniqueDts) {
    const DT_Code = d.id;
    const DT_E = dtEnergyById.get(DT_Code) ?? null;
    const Sum_Cons_E_for_DT = sumConsByDt.get(DT_Code) ?? 0;
    const DT_to_Cons_Loss = lossOrNull(DT_E, Sum_Cons_E_for_DT);
    rows.push({
      Feeder_Code: d.feederId,
      Feeder_E: null,
      Sum_DT_E: null,
      Feeder_to_DT_Loss: null,
      Sum_Cons_E: null,
      Feeder_to_Cons_Loss: null,
      DT_Code,
      DT_E,
      Sum_Cons_E_for_DT,
      DT_to_Cons_Loss,
    });
  }

  state.resultsRows = rows;
}

function lossOrNull(input, comparedSum) {
  if (input == null || input === 0) return null;
  return Number((((input - (comparedSum ?? 0)) / input) * 100).toFixed(2));
}

function renderResultsTable() {
  // deprecated table removed in favor of accordion
}

function renderAccordionFilters() {
  const select = document.getElementById("accordionRegionFilter");
  if (!select) return;
  const prev = select.value;
  const options = ["__ALL__", ...state.regions.map((r) => r.name)];
  select.innerHTML = options.map((opt) => `<option value="${escapeHtml(opt)}">${opt === "__ALL__" ? "All Regions" : escapeHtml(opt)}</option>`).join("");
  if (options.includes(prev)) select.value = prev;
}

function renderAccordionTable() {
  const tbody = document.querySelector('#accordionTable tbody');
  if (!tbody) return;
  const regionSel = document.getElementById('accordionRegionFilter').value;
  const regions = state.regions.filter((r) => regionSel === '__ALL__' || r.name === regionSel);

  // Build rows with data attributes for expand/collapse
  const rows = [];
  for (const region of regions) {
    for (const feeder of region.feeders) {
      const feederEnergy = feeder.metrics.feederEnergy ?? 0;
      const sumDt = feeder.dts.reduce((a, d) => a + (d.metrics.dtEnergy ?? 0), 0);
      const sumConsFeeder = feeder.meters.reduce((a, m) => a + (m.energy ?? 0), 0);
      const f2dtLoss = feederEnergy ? Number((((feederEnergy - sumDt) / feederEnergy) * 100).toFixed(2)) : null;
      const f2consLoss = feederEnergy ? Number((((feederEnergy - sumConsFeeder) / feederEnergy) * 100).toFixed(2)) : null;

      rows.push({
        type: 'feeder', id: feeder.id, parentId: region.name,
        name: feeder.name,
        code: feeder.id,
        energy: feederEnergy,
        f2dt: f2dtLoss,
        f2cons: f2consLoss,
      });

      for (const dt of feeder.dts) {
        const dtEnergy = dt.metrics.dtEnergy ?? 0;
        const sumConsDt = dt.meters.reduce((a, m) => a + (m.energy ?? 0), 0);
        const dt2ConsLoss = dtEnergy ? Number((((dtEnergy - sumConsDt) / dtEnergy) * 100).toFixed(2)) : null;
        rows.push({
          type: 'dt', id: dt.id, parentId: feeder.id,
          name: dt.name,
          code: dt.id,
          energy: dtEnergy,
          dt2cons: dt2ConsLoss,
        });

        for (const meter of dt.meters) {
          const consEnergy = meter.energy ?? diffEnergy(meter.readings.day1, meter.readings.day2, 1) ?? 0;
          rows.push({
            type: 'meter', id: meter.id, parentId: dt.id,
            name: '',
            code: meter.id,
            energy: consEnergy,
          });
        }
      }
    }
  }

  // initial render with only feeders visible
  tbody.innerHTML = rows.filter(r => r.type === 'feeder').map(r => rowHtml(r, 0, true)).join('');

  // attach expand handlers
  tbody.querySelectorAll('[data-type="feeder"]').forEach((tr) => {
    tr.addEventListener('click', () => toggleExpand(tr, rows));
  });
  
  // Also attach handlers for any DT rows that might be visible initially
  tbody.querySelectorAll('[data-type="dt"]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleExpand(tr, rows);
    });
  });
}

function rowHtml(r, level, collapsible) {
  const indentCls = level === 1 ? 'indent-1' : level >= 2 ? 'indent-2' : '';
  const icon = collapsible ? '<span class="icon">▸</span>' : '<span class="icon">•</span>';
  if (r.type === 'feeder') {
    return `
      <tr class="row-toggle ${indentCls}" data-type="feeder" data-id="${escapeHtml(r.id)}" data-parent="${escapeHtml(r.parentId)}">
        <td>${icon} ${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.code)}</td>
        <td>${fmtNumOrDash(r.energy)}</td>
        <td>${fmtPctOrDash(r.f2dt)}</td>
        <td>${fmtPctOrDash(r.f2cons)}</td>
      </tr>
    `;
  }
  if (r.type === 'dt') {
    return `
      <tr class="row-toggle ${indentCls}" data-type="dt" data-id="${escapeHtml(r.id)}" data-parent="${escapeHtml(r.parentId)}">
        <td>${icon} ${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.code)}</td>
        <td>${fmtNumOrDash(r.energy)}</td>
        <td></td>
        <td>${fmtPctOrDash(r.dt2cons)}</td>
      </tr>
    `;
  }
  // meter
  return `
    <tr class="row-toggle ${indentCls}" data-type="meter" data-id="${escapeHtml(r.id)}" data-parent="${escapeHtml(r.parentId)}">
      <td>${icon} Meter</td>
      <td>${escapeHtml(r.code)}</td>
      <td>${fmtNumOrDash(r.energy)} kWh</td>
      <td></td>
      <td></td>
    </tr>
  `;
}

function toggleExpand(tr, rows) {
  const type = tr.getAttribute('data-type');
  const id = tr.getAttribute('data-id');
  const nextLevel = type === 'feeder' ? 1 : type === 'dt' ? 2 : 3;
  const tbody = tr.parentElement;
  const iconEl = tr.querySelector('.icon');
  const isOpen = tr.classList.contains('open');

  if (isOpen) {
    // collapse: remove all descendant rows
    const toRemove = [];
    let sibling = tr.nextElementSibling;
    while (sibling && sibling.getAttribute('data-parent') !== null) {
      const sid = sibling.getAttribute('data-id');
      const sparent = sibling.getAttribute('data-parent');
      // remove until we reach another feeder (no parent or parent is region)
      if (type === 'feeder' && sibling.getAttribute('data-type') === 'feeder') break;
      if (type === 'dt' && sibling.getAttribute('data-type') !== 'meter') break;
      toRemove.push(sibling);
      sibling = sibling.nextElementSibling;
    }
    toRemove.forEach((el) => el.remove());
    tr.classList.remove('open');
    iconEl.textContent = '▸';
    return;
  }

  // expand children
  const children = rows.filter(r => r.parentId === id && ((type === 'feeder' && r.type === 'dt') || (type === 'dt' && r.type === 'meter')));
  const html = children.map(r => rowHtml(r, nextLevel, r.type !== 'meter')).join('');
  tr.insertAdjacentHTML('afterend', html);
  tr.classList.add('open');
  iconEl.textContent = '▾';

  // attach next-level handlers
  if (type === 'feeder') {
    let sibling = tr.nextElementSibling;
    while (sibling && sibling.getAttribute('data-parent') === id) {
      if (sibling.getAttribute('data-type') === 'dt') {
        sibling.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleExpand(sibling, rows);
        });
      }
      sibling = sibling.nextElementSibling;
    }
  } else if (type === 'dt') {
    // For DT rows, attach handlers to meter rows that get expanded
    let sibling = tr.nextElementSibling;
    while (sibling && sibling.getAttribute('data-parent') === id) {
      if (sibling.getAttribute('data-type') === 'meter') {
        // Meter rows don't need click handlers since they don't expand
        sibling.style.cursor = 'default';
      }
      sibling = sibling.nextElementSibling;
    }
  }
}

// Render helpers
function renderBadgePct(value, classifier) {
  const cls = classifier(value).cls;
  return `<span class="cell-badge ${cls}">${fmtPct(value)}</span>`;
}

function renderMetricGrid(pairs) {
  return pairs.map(([label, value]) => `
    <div class="metric">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
    </div>
  `).join("");
}

function renderFeederTable(feeders) {
  return `
  <div class="table-wrap">
    <table class="table">
      <thead>
        <tr>
          <th>Feeder</th>
          <th>DTs</th>
          <th>Meters</th>
          <th>F→DT Loss%</th>
          <th>DT→Cons Loss%</th>
          <th>F→Cons Loss%</th>
          <th>SLA Daily%</th>
          <th>SLA Load%</th>
        </tr>
      </thead>
      <tbody>
        ${feeders.map((f) => `
          <tr>
            <td><button class="link" data-action="open-feeder" data-id="${escapeHtml(f.id)}">${escapeHtml(f.name)}</button></td>
            <td>${f.metrics.dts}</td>
            <td>${f.metrics.meters}</td>
            <td>${renderBadgePct(f.metrics.lossFdt, classifyLoss)}</td>
            <td>${renderBadgePct(f.metrics.lossDtc, classifyLoss)}</td>
            <td>${renderBadgePct(f.metrics.lossFc, classifyLoss)}</td>
            <td>${renderBadgePct(f.metrics.slaDailyPct, classifySla)}</td>
            <td>${renderBadgePct(f.metrics.slaLoadPct, classifySla)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  </div>`;
}

function attachFeederRowHandlers() {
  document.querySelectorAll("[data-action='open-feeder']").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-id");
      state.currentSelection = { level: "FEEDER", id };
      renderDetail();
    });
  });
}

function renderDtTable(dts) {
  return `
  <div class="table-wrap">
    <table class="table">
      <thead>
        <tr>
          <th>DT</th>
          <th>Meters</th>
          <th>DT→Cons Loss%</th>
          <th>SLA Daily%</th>
          <th>SLA Load%</th>
        </tr>
      </thead>
      <tbody>
        ${dts.map((d) => `
          <tr>
            <td><button class="link" data-action="open-dt" data-id="${escapeHtml(d.id)}">${escapeHtml(d.name)}</button></td>
            <td>${d.meters.length}</td>
            <td>${renderBadgePct(d.metrics.lossDtc, classifyLoss)}</td>
            <td>${renderBadgePct(d.metrics.slaDailyPct, classifySla)}</td>
            <td>${renderBadgePct(d.metrics.slaLoadPct, classifySla)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  </div>`;
}

function attachDtRowHandlers() {
  document.querySelectorAll("[data-action='open-dt']").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-id");
      state.currentSelection = { level: "DT", id };
      renderDetail();
    });
  });
}

function renderMeterTable(meters) {
  return `
  <div class="table-wrap">
    <table class="table">
      <thead>
        <tr>
          <th>Meter</th>
          <th>Day1</th>
          <th>Day2</th>
          <th>Energy</th>
          <th>SLA Daily</th>
          <th>SLA Load</th>
        </tr>
      </thead>
      <tbody>
        ${meters.map((m) => `
          <tr>
            <td><button class="link" data-action="open-meter" data-id="${escapeHtml(m.id)}">${escapeHtml(m.id)}</button></td>
            <td>${m.readings.day1 ?? "—"}</td>
            <td>${m.readings.day2 ?? "—"}</td>
            <td>${m.energy ?? 0}</td>
            <td>${m.sla.daily ? '<span class="cell-badge badge-green">Yes</span>' : '<span class="cell-badge badge-red">No</span>'}</td>
            <td>${m.sla.load ? '<span class="cell-badge badge-green">Yes</span>' : '<span class="cell-badge badge-red">No</span>'}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  </div>`;
}

// Utilities
function computeEnergy(day1, day2) {
  if (day1 == null || day2 == null) return null;
  const diff = Number(day2) - Number(day1);
  return isFinite(diff) ? Math.max(0, Number(diff.toFixed(2))) : null;
}
function diffEnergy(day1, day2, mf = 1) {
  const base = computeEnergy(day1, day2);
  if (base == null) return null;
  const e = base * (isFinite(mf) ? Number(mf) : 1);
  return Number(e.toFixed(2));
}
function computeSlaFlag(val) { return val != null && val !== false; }
function parseYesNo(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  if (s === "yes" || s === "y" || s === "true" || s === "1") return true;
  if (s === "no" || s === "n" || s === "false" || s === "0") return false;
  return Boolean(v);
}
function numberOrNull(v) { const n = Number(v); return isFinite(n) ? n : null; }
function sum(arr) { return arr.reduce((a, b) => a + (Number(b) || 0), 0); }
function sumMeterEnergy(dt) { return sum(dt.meters.map((m) => m.energy ?? 0)); }
function sumDTEnergy(feeder) { return sum(feeder.dts.map((d) => d.metrics.dtEnergy ?? sumMeterEnergy(d))); }
function pct(part, whole) { if (!whole) return 0; return Number(((part / whole) * 100).toFixed(2)); }
function pctLoss(input, output) { if (!input) return 0; return Number((((input - output) / input) * 100).toFixed(2)); }
function fmtPct(v) { return (v == null || isNaN(v)) ? "—" : `${v.toFixed(2)}%`; }
function fmtPctOrDash(v) { return (v == null || isNaN(v)) ? "—" : `${Number(v).toFixed(2)}%`; }
function fmtNumOrDash(v) { return (v == null || isNaN(v)) ? "—" : Number(v).toFixed(2); }
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Interactions from tables to detail selection
document.addEventListener("click", (e) => {
  const t = e.target;
  if (t.matches && t.matches("button.link[data-action='open-meter']")) {
    state.currentSelection = { level: "METER", id: t.getAttribute("data-id") };
    renderDetail();
  } else if (t.matches && t.matches("button.link[data-action='open-dt']")) {
    state.currentSelection = { level: "DT", id: t.getAttribute("data-id") };
    renderDetail();
  } else if (t.matches && t.matches("button.link[data-action='open-feeder']")) {
    state.currentSelection = { level: "FEEDER", id: t.getAttribute("data-id") };
    renderDetail();
  }
});

// Mock data bootstrap
function bootstrapWithMockData() {
  const rows = [];
  const regions = ["Region 1", "Region 2", "Region 3"]; 
  let feederCounter = 0, dtCounter = 0, meterCounter = 0;
  for (const region of regions) {
    for (let f = 0; f < 5; f++) {
      const feederId = `F${++feederCounter}`;
      const feederName = feederId;
      for (let d = 0; d < 4; d++) {
        const dtId = `DT${++dtCounter}`;
        const dtName = dtId;
        for (let m = 0; m < 10; m++) {
          const meterId = `M${++meterCounter}`;
          const day1 = 100 + Math.floor(Math.random() * 900);
          const day2 = day1 + Math.floor(Math.random() * 20);
          const feederEnergy = 100 + Math.random() * 50; // synthetic
          const dtEnergy = 80 + Math.random() * 40; // synthetic
          rows.push({ Region: region, FeederId: feederId, FeederName: feederName, DTId: dtId, DTName: dtName, MeterId: meterId, Day1: day1, Day2: day2, FeederEnergy: feederEnergy, DTEnergy: dtEnergy });
        }
      }
    }
  }
  document.getElementById("fileName").textContent = "Mock Data";
  document.getElementById("processedTime").textContent = new Date().toLocaleString();
  buildModelFromRows(rows);
  renderAll();
}


