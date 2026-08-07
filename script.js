/* ============================================================
 * 라운지엑스24h P&L 대시보드
 * 단일 정적 페이지. localStorage 자동 저장 + JSON 가져오기/내보내기.
 * ============================================================ */

const STORAGE_KEY = "loungex_pnl_data";
const DEFAULT_OP_RATE = 0.2;
const DEFAULT_MONTHLY_LABOR = 3_000_000;
// 바리스 백오피스 API.
//  - localhost: 서버가 localhost 출처를 허용하므로 직접 호출.
//  - 그 외(github.io 등): 서버가 외부 출처를 Origin으로 차단하므로 프록시(Cloudflare Worker) 경유.
//    프록시는 서버 측에서 Origin/Referer를 barison.xyzcorp.io로 바꿔 전달한다.
const BARIS_API_DIRECT = "https://api-baris-v3-backoffice.xyzcorp.io";
const BARIS_API_PROXY = "https://loungex-baris-proxy.sigmaidea.workers.dev"; // Cloudflare Worker 프록시
const BARIS_API_BASE = (function () {
  const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
  if (isLocal) return BARIS_API_DIRECT;
  return BARIS_API_PROXY.indexOf("http") === 0 ? BARIS_API_PROXY : BARIS_API_DIRECT;
})();

// 공유 클라우드 저장소(Cloudflare Worker + KV). 저장 시 모든 기기에서 공통으로 보임.
// 인증은 별도 공유암호 없이, "업데이트"로 받은 바리스 로그인 토큰을 사용한다.
const CLOUD_BASE = "https://loungex-baris-proxy.sigmaidea.workers.dev";
const BARIS_TOKEN_STORAGE = "loungex_baris_token";
const getBarisToken = () => localStorage.getItem(BARIS_TOKEN_STORAGE) || "";
const setBarisToken = (t) => { if (t) localStorage.setItem(BARIS_TOKEN_STORAGE, t); };

const STORE_TYPE_DIRECT = "직영모델";
const STORE_TYPE_OWNER = "점주투자모델";
const STORE_TYPES = [STORE_TYPE_DIRECT, STORE_TYPE_OWNER];

function getStoreType(store) {
  return store?.type === STORE_TYPE_OWNER ? STORE_TYPE_OWNER : STORE_TYPE_DIRECT;
}

/* ---------- 상태 ---------- */
const state = {
  stores: [],   // {id, name, openDate, openingProfit, operatingProfitRate, totalInvestment}
  monthly: [],  // {storeId, yearMonth, revenue, investorPayout}
  materialRate: 0.3, // 식자재 비율(전 지점 공통). 0.1~0.3 중 선택.
  updatedAt: 0, // 마지막 로컬 수정 시각(ms). 기기 간 "가장 최근 저장본 우선" 판단용.
};

const ui = {
  filterStart: null,    // "YYYY-MM"
  filterEnd: null,      // "YYYY-MM"
  sortKey: "avgRevenue",
  sortDir: "desc",
  selectedStoreId: null,
  barisMode: "import",  // "import"(매출 전체 가져오기) | "sync"(로그인 후 클라우드 최신만)
};

let revenueChart = null;
let profitChart = null;
let trendChart = null;

/* ============================================================
 *  유틸 / 포맷
 * ============================================================ */
const uid = (prefix = "s") =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

const formatCurrency = (n) => {
  const v = Number(n) || 0;
  return "₩" + Math.round(v).toLocaleString("ko-KR");
};

const formatNumber = (n) => (Number(n) || 0).toLocaleString("ko-KR");

// 차트 축처럼 좁은 곳에서 쓰는 짧은 금액 표기 (예: 1.2억 / 3,400만)
const formatCurrencyShort = (n) => {
  const v = Number(n) || 0;
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(abs >= 1e9 ? 0 : 1)}억`;
  if (abs >= 1e4) return `${sign}${Math.round(abs / 1e4).toLocaleString("ko-KR")}만`;
  return `${sign}${Math.round(abs).toLocaleString("ko-KR")}`;
};

const formatPercent = (rate) => `${(rate * 100).toFixed(1)}%`;

/**
 * 수익률 표시: 100% 미만이면 100에서 부족한 만큼 "-N%"로 빨간 표시.
 * 데이터 없음(투자금=0 등)이면 "-".
 */
/**
 * 회수율 가로 막대: 0~200% 스케일, 100% 기준선이 중앙에 위치.
 * 100% 이상 녹색, 미만 빨간색.
 */
function renderRecoveryBar(rate, hasInvestment) {
  if (!hasInvestment) {
    return '<span class="cell-readonly">-</span>';
  }
  const pct = rate * 100;
  const fillWidth = Math.min(Math.max(pct, 0), 100); // 0~100% 스케일
  const cls = rate >= 1 ? "pos" : "neg";
  return `
    <div class="recovery-bar" title="총 회수금액 / 총 투자금액">
      <div class="recovery-bar-fill ${cls}" style="width:${fillWidth}%"></div>
      <div class="recovery-bar-label">${pct.toFixed(1)}%</div>
    </div>
  `;
}

function formatRoiDisplay(roi, minPayout) {
  if (!minPayout) return { text: "-", cls: "" };
  if (roi < 1) {
    return { text: `-${((1 - roi) * 100).toFixed(1)}%`, cls: "neg" };
  }
  return { text: `+${((roi - 1) * 100).toFixed(1)}%`, cls: "pos" };
}

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const pad = (n) => String(n).padStart(2, "0");

const ymOfDate = (isoDate) => isoDate?.slice(0, 7) || "";

const daysBetween = (fromISO, toISO) => {
  if (!fromISO) return 0;
  const a = new Date(fromISO);
  const b = new Date(toISO);
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
};

/** 필터 [startYM, endYM] 와 매장 운영기간 [openDate, today] 의 교집합 일수 */
function daysInFilteredWindow(openDate, startYM, endYM) {
  if (!openDate || !startYM || !endYM) return 0;
  const open = new Date(openDate);
  const filterStart = new Date(`${startYM}-01T00:00:00`);
  const [ey, em] = endYM.split("-").map(Number);
  const filterEnd = new Date(ey, em, 0, 23, 59, 59, 999); // endYM 의 마지막 날
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const effStart = open > filterStart ? open : filterStart;
  const effEnd = today < filterEnd ? today : filterEnd;
  if (effStart > effEnd) return 0;
  return Math.floor((effEnd - effStart) / 86400000) + 1;
}

const monthsRange = (startYM, endYM) => {
  const out = [];
  if (!startYM || !endYM) return out;
  const [sy, sm] = startYM.split("-").map(Number);
  const [ey, em] = endYM.split("-").map(Number);
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${pad(m)}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
};

const inRange = (ym, startYM, endYM) => ym >= startYM && ym <= endYM;

const parseNumberInput = (str) => {
  if (str == null) return 0;
  const cleaned = String(str).replace(/[^0-9.\-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
};

/* ── 월 임대료: 고정 금액 또는 "매출 %" 두 가지 방식 ──
 * store.monthlyRentRate 가 있으면(예: 0.1) 임대료 = 월평균 매출(VAT 별도) × 비율,
 * 없으면 store.monthlyRent(고정 금액)를 사용한다. */
const getRentRate = (store) => {
  const r = Number(store?.monthlyRentRate);
  return Number.isFinite(r) && r > 0 ? r : null;
};

// netRevenue: VAT 별도 월평균 매출 (= 월평균매출 × 0.9)
const resolveMonthlyRent = (store, netRevenue) => {
  const rate = getRentRate(store);
  return rate != null ? netRevenue * rate : (store.monthlyRent || 0);
};

// "10%" → 0.1 형태의 비율 입력인지 판별
const parseRentInput = (str) => {
  const s = String(str ?? "").trim();
  if (s.includes("%")) {
    const pct = parseNumberInput(s);
    return pct > 0 ? { monthlyRentRate: pct / 100 } : { monthlyRentRate: null, monthlyRent: 0 };
  }
  return { monthlyRentRate: null, monthlyRent: parseNumberInput(s) };
};

/* ============================================================
 *  저장 / 복원
 * ============================================================ */
function saveLocalOnly() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ stores: state.stores, monthly: state.monthly, materialRate: state.materialRate, updatedAt: state.updatedAt })
  );
}

// 모든 데이터 변경 시 호출됨 → 수정시각 갱신 + 로컬 저장 + 클라우드 자동 동기화(디바운스)
function saveToStorage() {
  state.updatedAt = Date.now(); // 이 기기에서 방금 수정함
  saveLocalOnly();
  scheduleCloudSync();
}

// 편집 후 잠시 뒤 클라우드에 자동 저장(로그인 상태일 때만)
let cloudSyncTimer = null;
function scheduleCloudSync() {
  if (!getBarisToken()) return; // 로그인 전이면 동기화 안 함
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => { cloudSave({ silent: true }); }, 1500);
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.stores) || !Array.isArray(parsed.monthly))
      return false;
    state.stores = parsed.stores;
    state.monthly = parsed.monthly;
    state.materialRate = parsed.materialRate ?? 0.3;
    state.updatedAt = parsed.updatedAt || 0;
    return true;
  } catch {
    return false;
  }
}

/* ============================================================
 *  공유 클라우드 저장(모든 기기 공통)
 * ============================================================ */
// 현재 데이터를 클라우드에 저장. 바리스 로그인 토큰으로 인증.
async function cloudSave({ silent = false } = {}) {
  const token = getBarisToken();
  if (!token) {
    if (!silent) showToast("먼저 '업데이트'로 바리스에 로그인하세요.");
    return false;
  }
  try {
    const r = await fetch(`${CLOUD_BASE}/__data`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ stores: state.stores, monthly: state.monthly, materialRate: state.materialRate, updatedAt: state.updatedAt }),
    });
    if (r.status === 401) {
      localStorage.removeItem(BARIS_TOKEN_STORAGE);
      // 자동 저장 중이라도 인증 만료는 사용자에게 알림(동기화 끊김 방지)
      showToast("동기화가 끊겼습니다. '업데이트'로 다시 로그인해 주세요.");
      return false;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (!silent) showToast("클라우드에 저장했습니다. 이제 모든 기기에서 공통으로 보입니다.");
    return true;
  } catch (e) {
    if (!silent) showToast("저장 실패: " + (e.message || e));
    return false;
  }
}

// 사용자가 직접 입력하는 지점 필드(참고용)
const MANUAL_STORE_FIELDS = [
  "totalInvestment", "monthlyRent", "monthlyRentRate", "monthlyLabor",
  "openingProfit", "openDate", "operatingProfitRate", "type", "name", "payoutRate",
];

// 클라우드 데이터를 받아오기만 함(state 변경 없음). 없거나 실패 시 null.
async function cloudFetch() {
  const token = getBarisToken();
  if (!token) return null;
  try {
    const r = await fetch(`${CLOUD_BASE}/__data`, { headers: { Authorization: "Bearer " + token } });
    if (r.status === 401) { localStorage.removeItem(BARIS_TOKEN_STORAGE); return null; }
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data.stores) || !Array.isArray(data.monthly)) return null;
    return data;
  } catch {
    return null;
  }
}

// 클라우드에서 받아 "가장 최근 저장본 우선"으로 반영.
//  - 클라우드가 내 로컬보다 최신이면 → 클라우드로 교체(다른 기기 변경이 보임)
//  - 내 로컬이 더 최신이면 → 로컬 유지(미저장 입력 보호) + 클라우드로 밀어올림
//  - 클라우드가 비었으면 → 로컬 유지
async function cloudPull() {
  const cloud = await cloudFetch();
  if (!cloud) return false;
  if (cloud.stores.length === 0 && cloud.monthly.length === 0) return false;
  const cloudTime = cloud.updatedAt || 0;
  const localTime = state.updatedAt || 0;
  if (cloudTime > localTime) {
    // 클라우드가 더 최신 → 클라우드 채택
    state.stores = cloud.stores;
    state.monthly = cloud.monthly;
    state.materialRate = cloud.materialRate ?? state.materialRate ?? 0.3;
    state.updatedAt = cloudTime;
    saveLocalOnly();
    return true;
  }
  // 로컬이 더(또는 같게) 최신 → 로컬 유지. 로컬이 더 최신이면 클라우드로 동기화.
  if (localTime > cloudTime) scheduleCloudSync();
  return false;
}

function resetStorage() {
  localStorage.removeItem(STORAGE_KEY);
  state.stores = [];
  state.monthly = [];
}

/* ============================================================
 *  계산
 * ============================================================ */
function getMonthlyForStore(storeId) {
  return state.monthly
    .filter((m) => m.storeId === storeId)
    .sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
}

function getStoreMetrics(store, startYM, endYM) {
  const all = getMonthlyForStore(store.id);
  const filtered = all.filter((m) => inRange(m.yearMonth, startYM, endYM));

  const totalRevenue = filtered.reduce((s, m) => s + (m.revenue || 0), 0);
  const totalRevenueAll = all.reduce((s, m) => s + (m.revenue || 0), 0);
  const totalPayoutAll = all.reduce((s, m) => s + (m.investorPayout || 0), 0);
  const totalPayoutFiltered = filtered.reduce((s, m) => s + (m.investorPayout || 0), 0);

  const investment = store.totalInvestment || 0;
  const opDays = store.openDate ? Math.max(0, daysBetween(store.openDate, todayISO())) : 0;

  // 평균 매출 (월) = (누적 매출 / 운영일자) × 30
  const avgMonthlyRevenue = opDays > 0 ? (totalRevenueAll / opDays) * 30 : 0;

  // 식자재비 = 평균매출 × 식자재 비율
  const materialRate = state.materialRate ?? 0.3;
  const materialCost = avgMonthlyRevenue * materialRate;

  // 투자자 회수 비율(전 지점 20% 통일)
  const payoutRate = 0.2;
  const minMonthlyPayout = investment / 60;
  const avgMonthlyPayout = avgMonthlyRevenue * 0.9 * payoutRate;
  // 총 회수금액 = 누적 매출 × 90% × 회수비율 (월별 실적의 투자자 회수금 공식과 동일)
  const totalPayoutCalculated = totalRevenueAll * 0.9 * payoutRate;
  // 회수율 = 총 회수금액 / 총 투자금액
  const recoveryRate = investment > 0 ? totalPayoutCalculated / investment : 0;

  const roi = minMonthlyPayout > 0 ? avgMonthlyPayout / minMonthlyPayout : 0;

  // 월 임대료: 고정 금액 또는 월평균 매출(VAT 별도) 대비 비율
  const monthlyRent = resolveMonthlyRent(store, avgMonthlyRevenue * 0.9);

  // 회사 월 P&L = 월평균매출(VAT별도) - 월평균회수금액 - 월평균매출(VAT별도)×0.3(식자재)
  //             - 월 임대료 - 인건비(고정 300만)
  const operatingProfit = avgMonthlyRevenue * 0.9
    - avgMonthlyPayout
    - avgMonthlyRevenue * 0.9 * materialRate
    - monthlyRent
    - DEFAULT_MONTHLY_LABOR;

  const openingProfitInRange = 0; // 회사 P&L 에서 오픈수익 제외
  const companyPnl = operatingProfit;

  // ─ 필터 기간 기준 동일 공식 (KPI 카드에서 사용) ─
  // 필터 운영일수 기반으로 30일 정규화 (all-time formula 와 동일한 스타일)
  const filteredOpDays = daysInFilteredWindow(store.openDate, startYM, endYM);
  const avgMonthlyRevenueFiltered = filteredOpDays > 0
    ? (totalRevenue / filteredOpDays) * 30
    : 0;
  const avgMonthlyPayoutFiltered = avgMonthlyRevenueFiltered * 0.9 * payoutRate;
  const roiFiltered = minMonthlyPayout > 0
    ? avgMonthlyPayoutFiltered / minMonthlyPayout
    : 0;
  const monthlyRentFiltered = resolveMonthlyRent(store, avgMonthlyRevenueFiltered * 0.9);
  const operatingProfitFiltered = avgMonthlyRevenueFiltered * 0.9
    - avgMonthlyPayoutFiltered
    - avgMonthlyRevenueFiltered * 0.9 * materialRate
    - monthlyRentFiltered
    - DEFAULT_MONTHLY_LABOR;
  const companyPnlFiltered = operatingProfitFiltered;

  return {
    totalRevenue,
    totalRevenueAll,
    totalPayoutFiltered,
    totalPayoutAll,
    operatingProfit,
    openingProfitInRange,
    companyPnl,
    roi,
    opDays,
    minMonthlyPayout,
    avgMonthlyPayout,
    avgMonthlyRevenue,
    totalPayoutCalculated,
    recoveryRate,
    materialCost,
    monthlyRent,
    monthlyRentFiltered,
    roiFiltered,
    companyPnlFiltered,
  };
}

/**
 * 특정 월 한 달의 회사 P&L.
 * 지점 상세 표의 "회사 P&L"과 같은 공식을 그 달 매출에 적용하되,
 * 고정비(임대료·인건비)는 실제 운영일 기준으로 일할 계산한다.
 *   매출(VAT별도) - 투자자 회수금 - 식자재비 - 임대료×일할 - 인건비×일할
 * 임대료를 "매출 %"로 설정한 지점은 이미 그 달 매출에 비례하므로 일할을 또 적용하지 않는다.
 */
function getMonthlyCompanyPnl(store, monthRow) {
  const net = (monthRow.revenue || 0) * 0.9;
  const materialRate = state.materialRate ?? 0.3;

  const daysInMonth = daysInYearMonth(monthRow.yearMonth);
  const opDays = getOperatingDays(store, monthRow);
  const dayRatio = daysInMonth > 0 ? Math.min(1, Math.max(0, opDays / daysInMonth)) : 1;

  const rent = resolveMonthlyRent(store, net);
  const rentCost = getRentRate(store) != null ? rent : rent * dayRatio;

  return net
    - net * 0.2 // 투자자 회수금(회수비율 20%)
    - net * materialRate
    - rentCost
    - DEFAULT_MONTHLY_LABOR * dayRatio;
}

function getDataDateRange() {
  if (state.monthly.length === 0) {
    const now = new Date();
    const ym = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    return { min: ym, max: ym };
  }
  const yms = state.monthly.map((m) => m.yearMonth).sort();
  return { min: yms[0], max: yms[yms.length - 1] };
}

function getRecentFilter(months) {
  const { max } = getDataDateRange();
  const [y, m] = max.split("-").map(Number);
  let sy = y, sm = m - (months - 1);
  while (sm <= 0) { sm += 12; sy--; }
  return { start: `${sy}-${pad(sm)}`, end: max };
}

function getDefaultFilter() {
  const { max } = getDataDateRange();
  const start = "2026-01";
  return { start, end: max < start ? start : max };
}

/* ============================================================
 *  렌더 (전체)
 * ============================================================ */
// 로그인 버튼 텍스트를 로그인 상태에 맞게 갱신
function updateLoginButton() {
  const btn = document.getElementById("btn-login");
  if (btn) btn.textContent = getBarisToken() ? "로그아웃" : "로그인";
}

// 로그아웃 상태(토큰 없음)에서 보여줄 잠금 화면 — 데이터 숨김
function renderLocked() {
  ["kpi-roi", "kpi-company", "kpi-stores", "kpi-revenue"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = "-";
  });
  ["kpi-roi-sub", "kpi-company-sub", "kpi-stores-sub", "kpi-revenue-sub"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = "";
  });
  if (revenueChart) { revenueChart.destroy(); revenueChart = null; }
  if (profitChart) { profitChart.destroy(); profitChart = null; }
  if (trendChart) { trendChart.destroy(); trendChart = null; }
  ["chart-revenue-wrap", "chart-profit-wrap", "chart-trend-wrap"].forEach((id) => {
    const wrap = document.getElementById(id);
    if (wrap) {
      wrap.style.height = "";
      wrap.innerHTML = '<div class="empty-state">로그인하면 데이터가 표시됩니다.</div>';
    }
  });
  renderStoreHead();
  const stb = document.getElementById("store-tbody");
  if (stb) stb.innerHTML = `<tr><td colspan="${STORE_COLUMNS.length}" class="empty-state">로그인이 필요합니다. 우측 상단 "로그인"을 눌러주세요.</td></tr>`;
  const stf = document.getElementById("store-tfoot");
  if (stf) stf.innerHTML = "";
  const mtb = document.getElementById("monthly-tbody");
  if (mtb) mtb.innerHTML = '<tr><td colspan="7" class="empty-state">로그인이 필요합니다.</td></tr>';
  const mtf = document.getElementById("monthly-tfoot");
  if (mtf) mtf.innerHTML = "";
  const sel = document.getElementById("monthly-store-select");
  if (sel) sel.innerHTML = "";
  ["chart-period", "chart-profit-period", "chart-trend-period"].forEach((id) => {
    const cp = document.getElementById(id);
    if (cp) cp.textContent = "";
  });
}

function renderAll() {
  updateLoginButton();
  // 로그아웃 상태에서는 데이터를 보여주지 않음
  if (!getBarisToken()) {
    renderLocked();
    return;
  }

  const startYM = ui.filterStart;
  const endYM = ui.filterEnd;

  const matSel = document.getElementById("material-rate-select");
  if (matSel) matSel.value = String(state.materialRate ?? 0.3);

  renderKPI(startYM, endYM);
  renderChart(startYM, endYM);
  renderProfitChart(startYM, endYM);
  renderTrendChart(startYM, endYM);
  renderStoreTable(startYM, endYM);
  renderStoreSelect();
  renderMonthlyTable();

  document.getElementById("chart-period").textContent =
    state.stores.length === 0 ? "" : `${startYM} ~ ${endYM}`;
  // 회사 P&L은 지점 상세 표와 동일하게 전체 기간 월평균 기준
  const profitPeriodEl = document.getElementById("chart-profit-period");
  if (profitPeriodEl) {
    profitPeriodEl.textContent = state.stores.length === 0 ? "" : "회사 P&L · 전체 기간 월평균 기준";
  }
}

// 로그아웃: 토큰·데이터 삭제 후 잠금 화면
function logout() {
  localStorage.removeItem(BARIS_TOKEN_STORAGE);
  localStorage.removeItem(STORAGE_KEY);
  state.stores = [];
  state.monthly = [];
  state.updatedAt = 0;
  ui.selectedStoreId = null;
  renderAll();
  showToast("로그아웃되었습니다.");
}

/* ============================================================
 *  KPI
 * ============================================================ */
function renderKPI(startYM, endYM) {
  const totalStores = state.stores.length;

  let totalRevenue = 0;
  let totalCompanyPnl = 0;
  let roiSum = 0;
  let roiCount = 0;

  state.stores.forEach((store) => {
    const m = getStoreMetrics(store, startYM, endYM);
    totalRevenue += m.totalRevenue;
    // 총 회사 수익, 평균 수익률은 기간 필터와 무관하게 전체 기간 기준
    totalCompanyPnl += m.companyPnl;
    if ((store.totalInvestment || 0) > 0) {
      roiSum += m.roi;
      roiCount++;
    }
  });

  const avgRoi = roiCount > 0 ? roiSum / roiCount : 0;

  document.getElementById("kpi-stores").textContent = formatNumber(totalStores);
  document.getElementById("kpi-revenue").textContent = formatCurrency(totalRevenue);

  // 총 투자자 수익: 100% 기준으로 +초과분 / -부족분 표시
  const roiEl = document.getElementById("kpi-roi");
  if (roiCount === 0) {
    roiEl.textContent = "-";
    roiEl.classList.remove("pos", "neg");
  } else {
    const d = formatRoiDisplay(avgRoi, 1);
    roiEl.textContent = d.text;
    roiEl.classList.remove("pos", "neg");
    if (d.cls) roiEl.classList.add(d.cls);
  }

  // 총 회사 수익: 음수면 빨간색
  const companyEl = document.getElementById("kpi-company");
  companyEl.textContent = formatCurrency(totalCompanyPnl);
  companyEl.classList.toggle("neg", totalCompanyPnl < 0);
}

/* ============================================================
 *  매장별 비중 차트 (100% 누적 가로 막대)
 * ============================================================ */
// 차트 라벨용 짧은 지점명 — 공통 접두어 "라운지엑스24h" 제거 (원본 store.name 은 그대로 둠)
const shortStoreName = (name) => {
  const short = String(name || "")
    .replace(/라운지엑스\s*24\s*h/gi, "")
    .replace(/^[\s\-–—_·]+|[\s\-–—_·]+$/g, "")
    .replace(/\s+/g, " ");
  return short || String(name || ""); // 이름 전체가 접두어뿐이면 원본 유지
};

const CHART_PALETTE = [
  "#296ff7", "#23a375", "#e0921a", "#e5484d",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316",
  "#06b6d4", "#84cc16",
];

// 100% 누적 막대의 각 구간 안에 비중(%)을 그려주는 플러그인
const stackedShareLabels = {
  id: "stackedShareLabels",
  afterDatasetsDraw(chart) {
    const ctx = chart.ctx;
    ctx.save();
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    chart.data.datasets.forEach((ds, di) => {
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden) return;
      const bar = meta.data[0];
      if (!bar) return;
      const width = Math.abs(bar.x - bar.base);
      const pct = Number(ds.data[0]) || 0;
      const cx = (bar.x + bar.base) / 2;
      // 구간이 좁으면 % 만, 아주 좁으면 생략(범례에 지점명+% 가 모두 표시됨)
      if (width < 34) return;
      ctx.fillStyle = "#ffffff";
      if (width >= 78) {
        ctx.font = "600 11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
        ctx.fillText(ds.label, cx, bar.y - 9);
        ctx.font = "700 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
        ctx.fillText(`${pct.toFixed(1)}%`, cx, bar.y + 9);
      } else {
        ctx.font = "700 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
        ctx.fillText(`${pct.toFixed(1)}%`, cx, bar.y);
      }
    });
    ctx.restore();
  },
};

/**
 * 전체를 100%로 보는 단일 누적 가로 막대.
 * items: [{ name, value }] — 비중 큰 순으로 정렬된 배열. 지점마다 하나의 구간이 된다.
 */
function renderStackedShareBar({ wrapId, canvasId, chart, items, emptyText }) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return chart;

  if (items.length === 0) {
    if (chart) chart.destroy();
    wrap.style.height = "";
    wrap.innerHTML = `<div class="empty-state">${escapeHtml(emptyText)}</div>`;
    return null;
  }

  if (!document.getElementById(canvasId)) {
    wrap.innerHTML = `<canvas id="${canvasId}"></canvas>`;
  }
  const ctx = document.getElementById(canvasId);

  // 분모: 전부 양수면 총합, 음수(적자)가 섞이면 흑자 합계
  // → 흑자 지점은 0에서 오른쪽으로 쌓여 합이 100%, 적자 지점은 0에서 왼쪽으로 뻗는다
  const positiveSum = items.reduce((s, x) => s + Math.max(x.value, 0), 0);
  const denom = positiveSum > 0 ? positiveSum : items.reduce((s, x) => s + Math.abs(x.value), 0);
  const hasNegative = items.some((x) => x.value < 0);
  const negativeShare = items.reduce((s, x) => s + Math.min(x.value, 0), 0) / (denom || 1) * 100;

  // 막대 + x축 + 범례(지점 4개당 한 줄) 높이
  wrap.style.height = `${112 + Math.ceil(items.length / 4) * 26}px`;

  const data = {
    labels: [""],
    datasets: items.map((x, i) => ({
      label: x.name,
      data: [denom > 0 ? (x.value / denom) * 100 : 0],
      amount: x.value,
      backgroundColor: CHART_PALETTE[i % CHART_PALETTE.length],
      // 음수가 섞이면 어느 구간이 양 끝인지 정해지지 않으므로 모두 살짝만 둥글게
      borderRadius: hasNegative ? 2 : {
        topLeft: i === 0 ? 6 : 0,
        bottomLeft: i === 0 ? 6 : 0,
        topRight: i === items.length - 1 ? 6 : 0,
        bottomRight: i === items.length - 1 ? 6 : 0,
      },
      borderSkipped: false,
      barThickness: 46,
    })),
  };

  const options = {
    indexAxis: "y", // 좌우로 긴 가로 막대
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: {
        stacked: true,
        // 적자 지점이 있으면 0 왼쪽으로 그만큼 축을 넓힌다
        min: hasNegative ? Math.floor((negativeShare - 4) / 5) * 5 : 0,
        max: 100,
        grid: { color: (c) => (c.tick?.value === 0 && hasNegative ? "#b8bec8" : "#eceef2") },
        border: { display: false },
        // 음수 구간이 있으면 눈금 간격은 Chart.js 자동 계산에 맡긴다(축 끝 라벨 겹침 방지)
        ticks: {
          color: "#868e96",
          font: { size: 11 },
          stepSize: hasNegative ? undefined : 25,
          callback: (v) => `${v}%`,
        },
      },
      y: { stacked: true, grid: { display: false }, border: { display: false }, ticks: { display: false } },
    },
    plugins: {
      legend: {
        position: "bottom",
        labels: {
          color: "#495057",
          font: { size: 12 },
          boxWidth: 10,
          boxHeight: 10,
          usePointStyle: true,
          pointStyle: "circle",
          padding: 14,
          // 구간이 좁아 막대 안에 % 를 못 그린 지점도 범례에서 비중을 볼 수 있게
          generateLabels: (c) => c.data.datasets.map((ds, i) => ({
            text: `${ds.label}  ${(Number(ds.data[0]) || 0).toFixed(1)}%`,
            fillStyle: ds.backgroundColor,
            strokeStyle: ds.backgroundColor,
            lineWidth: 0,
            fontColor: "#495057",
            datasetIndex: i,
          })),
        },
      },
      tooltip: {
        backgroundColor: "#343a46",
        titleColor: "#ffffff",
        bodyColor: "#ffffff",
        borderColor: "#343a46",
        borderWidth: 1,
        padding: 10,
        callbacks: {
          title: (cs) => cs[0]?.dataset.label || "",
          label: (c) => `${(c.parsed.x || 0).toFixed(1)}% · ${formatCurrency(c.dataset.amount || 0)}`,
        },
      },
    },
  };

  if (chart && chart.canvas === ctx) {
    chart.data = data;
    chart.options = options;
    chart.update();
    return chart;
  }
  if (chart) chart.destroy();
  return new Chart(ctx, { type: "bar", data, options, plugins: [stackedShareLabels] });
}

function renderChart(startYM, endYM) {
  // 매출 비중 높은 것부터 낮은 것 순으로 정렬
  const items = state.stores
    .map((store) => ({ name: shortStoreName(store.name), value: getStoreMetrics(store, startYM, endYM).totalRevenue }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value);

  revenueChart = renderStackedShareBar({
    wrapId: "chart-revenue-wrap",
    canvasId: "chart-revenue",
    chart: revenueChart,
    items,
    emptyText: "선택 기간에 매출 데이터가 없습니다.",
  });
}

/* ============================================================
 *  월별 매출·순익 추이 (시간축)
 * ============================================================ */
function renderTrendChart(startYM, endYM) {
  const wrap = document.getElementById("chart-trend-wrap");
  if (!wrap) return;

  // 선택 기간의 월별로 전 지점 매출 / 회사 P&L 합산
  const revByMonth = new Map();
  const pnlByMonth = new Map();
  state.monthly.forEach((m) => {
    if (!inRange(m.yearMonth, startYM, endYM)) return;
    const store = state.stores.find((s) => s.id === m.storeId);
    if (!store) return;
    revByMonth.set(m.yearMonth, (revByMonth.get(m.yearMonth) || 0) + (m.revenue || 0));
    pnlByMonth.set(m.yearMonth, (pnlByMonth.get(m.yearMonth) || 0) + getMonthlyCompanyPnl(store, m));
  });

  // 상단 기간 선택 그대로를 시간축으로 사용(값 없는 달은 빈칸으로 둠)
  const months = monthsRange(startYM, endYM);
  const singleYear = startYM.slice(0, 4) === endYM.slice(0, 4);

  const periodEl = document.getElementById("chart-trend-period");
  if (periodEl) {
    periodEl.textContent = state.stores.length === 0 ? "" : `전 지점 합계 · ${startYM} ~ ${endYM}`;
  }

  if (!months.some((ym) => revByMonth.has(ym))) {
    if (trendChart) { trendChart.destroy(); trendChart = null; }
    wrap.style.height = "";
    wrap.innerHTML = '<div class="empty-state">선택 기간에 매출 데이터가 없습니다.</div>';
    return;
  }

  if (!document.getElementById("chart-trend")) {
    wrap.innerHTML = '<canvas id="chart-trend"></canvas>';
  }
  const ctx = document.getElementById("chart-trend");
  wrap.style.height = "";

  // 값이 없는 달은 null → 막대를 그리지 않고 빈칸으로 둔다
  const revenues = months.map((ym) => (revByMonth.has(ym) ? revByMonth.get(ym) : null));
  const pnls = months.map((ym) => (pnlByMonth.has(ym) ? pnlByMonth.get(ym) : null));
  // 단일 연도면 "1월"~"12월", 여러 해에 걸치면 "2025-01" 형태
  const labels = months.map((ym) => (singleYear ? `${Number(ym.slice(5, 7))}월` : ym));
  // 짧은 기간을 선택하면 막대가 지나치게 가늘어 보이지 않게 두께를 키운다
  const barThickness = months.length <= 6 ? 48 : 30;

  // y축 단위를 하나로 통일(억 또는 만) — 억/만이 섞여 보이지 않게
  const values = [...revenues, ...pnls].filter((v) => v != null);
  const maxAbs = Math.max(0, ...values.map(Math.abs));
  const axisUnit = maxAbs >= 1e8 ? 1e8 : maxAbs >= 1e4 ? 1e4 : 1;
  const formatAxis = (v) => {
    if (v === 0) return "0";
    if (axisUnit === 1e8) return `${(v / 1e8).toFixed(1)}억`;
    if (axisUnit === 1e4) return `${Math.round(v / 1e4).toLocaleString("ko-KR")}만`;
    return Math.round(v).toLocaleString("ko-KR");
  };

  const data = {
    labels,
    datasets: [
      {
        label: "매출",
        data: revenues,
        backgroundColor: "#296ff7",
        borderRadius: 3,
        borderSkipped: false,
        maxBarThickness: barThickness,
      },
      {
        label: "순익 (회사 P&L)",
        data: pnls,
        // 흑자는 초록, 적자는 빨강 — 부호가 한눈에 보이게
        backgroundColor: pnls.map((v) => (v < 0 ? "#e5484d" : "#23a375")),
        borderRadius: 3,
        borderSkipped: false,
        maxBarThickness: barThickness,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    scales: {
      x: {
        grid: { display: false },
        border: { display: false },
        ticks: { color: "#868e96", font: { size: 11 } },
      },
      y: {
        beginAtZero: true,
        // 0선을 진하게 — 적자 막대가 아래로 내려간 게 분명히 보이도록
        grid: { color: (c) => (c.tick?.value === 0 ? "#b8bec8" : "#eceef2") },
        border: { display: false },
        ticks: { color: "#868e96", font: { size: 11 }, callback: (v) => formatAxis(v) },
      },
    },
    plugins: {
      legend: {
        position: "bottom",
        labels: {
          color: "#495057",
          font: { size: 12 },
          boxWidth: 10,
          boxHeight: 10,
          usePointStyle: true,
          pointStyle: "circle",
          padding: 16,
          // 순익은 막대 색이 흑자/적자에 따라 달라지므로 범례 색은 초록으로 고정
          generateLabels: (c) => c.data.datasets.map((ds, i) => ({
            text: ds.label,
            fillStyle: i === 0 ? "#296ff7" : "#23a375",
            strokeStyle: i === 0 ? "#296ff7" : "#23a375",
            lineWidth: 0,
            fontColor: "#495057",
            datasetIndex: i,
          })),
        },
      },
      tooltip: {
        backgroundColor: "#343a46",
        titleColor: "#ffffff",
        bodyColor: "#ffffff",
        borderColor: "#343a46",
        borderWidth: 1,
        padding: 10,
        callbacks: { label: (c) => `${c.dataset.label}: ${formatCurrency(c.parsed.y || 0)}` },
      },
    },
  };

  if (trendChart && trendChart.canvas === ctx) {
    trendChart.data = data;
    trendChart.options = options;
    trendChart.update();
  } else {
    if (trendChart) trendChart.destroy();
    trendChart = new Chart(ctx, { type: "bar", data, options });
  }
}

// 매장별 순익(회사 P&L) 비중 — 지점 상세 표의 "회사 P&L"과 같은 월평균·전체 기간 기준
function renderProfitChart(startYM, endYM) {
  const items = state.stores
    .map((store) => {
      const m = getStoreMetrics(store, startYM, endYM);
      return { name: shortStoreName(store.name), value: m.companyPnl, revenueAll: m.totalRevenueAll };
    })
    .filter((x) => x.revenueAll > 0) // 매출 데이터가 없는 지점은 제외
    .sort((a, b) => b.value - a.value);

  profitChart = renderStackedShareBar({
    wrapId: "chart-profit-wrap",
    canvasId: "chart-profit",
    chart: profitChart,
    items,
    emptyText: "선택 기간에 순익 데이터가 없습니다.",
  });
}

/* ============================================================
 *  공통: 현재 ui.sortKey/sortDir 기준으로 정렬된 지점 행
 * ============================================================ */
function getSortedStoreRows(startYM, endYM) {
  const rows = state.stores.map((store) => {
    const m = getStoreMetrics(store, startYM, endYM);
    return { store, ...m };
  });
  rows.sort((a, b) => {
    const dir = ui.sortDir === "asc" ? 1 : -1;
    let av, bv;
    switch (ui.sortKey) {
      case "name": av = a.store.name; bv = b.store.name; break;
      case "type": av = getStoreType(a.store); bv = getStoreType(b.store); break;
      case "openDate": av = a.store.openDate || ""; bv = b.store.openDate || ""; break;
      case "opDays": av = a.opDays; bv = b.opDays; break;
      case "totalInvestment": av = a.store.totalInvestment || 0; bv = b.store.totalInvestment || 0; break;
      case "totalPayout": av = a.totalPayoutCalculated; bv = b.totalPayoutCalculated; break;
      case "recoveryRate": av = a.recoveryRate; bv = b.recoveryRate; break;
      case "avgRevenue": av = a.avgMonthlyRevenue; bv = b.avgMonthlyRevenue; break;
      case "monthlyRent": av = a.monthlyRent; bv = b.monthlyRent; break;
      case "monthlyLabor": av = a.store.monthlyLabor ?? DEFAULT_MONTHLY_LABOR; bv = b.store.monthlyLabor ?? DEFAULT_MONTHLY_LABOR; break;
      case "materialCost": av = a.materialCost; bv = b.materialCost; break;
      case "minPayout": av = a.minMonthlyPayout; bv = b.minMonthlyPayout; break;
      case "avgPayout": av = a.avgMonthlyPayout; bv = b.avgMonthlyPayout; break;
      case "roi": av = a.roi; bv = b.roi; break;
      case "companyPnl": av = a.companyPnl; bv = b.companyPnl; break;
      default: av = a.store.name; bv = b.store.name;
    }
    if (typeof av === "string") return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  });
  return rows;
}

/* ============================================================
 *  지점 상세 테이블
 * ============================================================ */
// 지점 상세 표의 컬럼 정의(헤더). 본문/합계 셀과 반드시 같은 순서.
// 헤더를 본문과 같은 곳(script.js)에서 생성해 캐시로 인한 헤더-본문 어긋남을 방지한다.
const STORE_COLUMNS = [
  { label: "지점명", sort: "name" },
  { label: "오픈일", sort: "openDate" },
  { label: "운영일자", sort: "opDays" },
  { label: "총 투자금액", sort: "totalInvestment", center: true },
  { label: "총 회수금액", sort: "totalPayout", center: true },
  { label: "회수율", sort: "recoveryRate", center: true },
  { label: "월평균 매출", sort: "avgRevenue", center: true },
  { label: "월평균 회수금액", sort: "avgPayout", center: true },
  { label: "수익률", sort: "roi" },
  { label: "월 임대료", sort: "monthlyRent", center: true, title: "더블클릭 후 금액(3000000) 또는 매출 비율(10%)을 입력하세요" },
  { label: "회사 P&L", sort: "companyPnl" },
  { label: "", action: true },
];

function renderStoreHead() {
  const thead = document.getElementById("store-thead");
  if (!thead) return;
  thead.innerHTML = "<tr>" + STORE_COLUMNS.map((c) => {
    const cls = [c.center ? "center" : "", c.action ? "col-action" : ""].filter(Boolean).join(" ");
    const sortAttr = c.sort ? ` data-sort="${c.sort}"` : "";
    const titleAttr = c.title ? ` title="${escapeHtml(c.title)}"` : "";
    return `<th${sortAttr}${titleAttr}${cls ? ` class="${cls}"` : ""}>${escapeHtml(c.label)}</th>`;
  }).join("") + "</tr>";
}

// 임대료 셀: 비율 방식이면 계산된 금액 아래에 "매출 10%" 표시
function renderRentCell(store, rentAmount) {
  const rate = getRentRate(store);
  if (rate == null) return formatCurrency(store.monthlyRent || 0);
  const pct = Number((rate * 100).toFixed(2));
  return `${formatCurrency(rentAmount)}<span class="cell-note">매출 ${pct}%</span>`;
}

function renderStoreTable(startYM, endYM) {
  renderStoreHead();
  const tbody = document.getElementById("store-tbody");
  const tfoot = document.getElementById("store-tfoot");

  if (state.stores.length === 0) {
    tbody.innerHTML =
      `<tr><td colspan="${STORE_COLUMNS.length}" class="empty-state">아직 등록된 지점이 없습니다. "+ 지점 추가" 버튼으로 시작하세요.</td></tr>`;
    tfoot.innerHTML = "";
    updateSortHeaders();
    return;
  }

  const rows = getSortedStoreRows(startYM, endYM);

  tbody.innerHTML = rows.map(({ store, ...m }) => `
    <tr data-store-id="${store.id}">
      <td><span class="cell-editable" data-edit="store" data-field="name" data-id="${store.id}">${escapeHtml(store.name)}</span></td>
      <td><span class="cell-editable" data-edit="store" data-field="openDate" data-id="${store.id}" data-input-type="date">${store.openDate || "-"}</span></td>
      <td class="num cell-readonly">${formatNumber(m.opDays)}일</td>
      <td class="num center"><span class="cell-editable" data-edit="store" data-field="totalInvestment" data-id="${store.id}" data-input-type="number">${formatCurrency(store.totalInvestment)}</span></td>
      <td class="num center cell-readonly">${formatCurrency(m.totalPayoutCalculated)}</td>
      <td class="num center cell-readonly">${renderRecoveryBar(m.recoveryRate, (store.totalInvestment || 0) > 0)}</td>
      <td class="num center cell-readonly">${formatCurrency(m.avgMonthlyRevenue * 0.9)}</td>
      <td class="num center cell-readonly ${m.avgMonthlyPayout >= m.minMonthlyPayout && m.minMonthlyPayout > 0 ? "pos" : ""}">${formatCurrency(m.avgMonthlyPayout)}</td>
      <td class="num cell-readonly ${formatRoiDisplay(m.roi, m.minMonthlyPayout).cls}">${formatRoiDisplay(m.roi, m.minMonthlyPayout).text}</td>
      <td class="num center"><span class="cell-editable" data-edit="store" data-field="monthlyRent" data-id="${store.id}" data-input-type="rent" title="금액(예: 3000000) 또는 매출 비율(예: 10%)을 입력하세요">${renderRentCell(store, m.monthlyRent)}</span></td>
      <td>
        <div class="pnl-stack">
          <div class="pnl-line ${m.operatingProfit < 0 ? "neg" : "accent"}">
            <span class="value">${formatCurrency(m.operatingProfit)}</span>
          </div>
        </div>
      </td>
      <td class="col-action">
        <button class="btn-icon" data-delete-store="${store.id}" title="지점 삭제">×</button>
      </td>
    </tr>
  `).join("");

  // 합계
  const sum = rows.reduce((acc, r) => {
    acc.investment += r.store.totalInvestment || 0;
    acc.totalPayout += r.totalPayoutCalculated;
    acc.monthlyRent += r.monthlyRent;
    acc.monthlyLabor += r.store.monthlyLabor ?? DEFAULT_MONTHLY_LABOR;
    acc.materialCost += r.materialCost;
    acc.revenueAll += r.totalRevenueAll;
    acc.payoutAll += r.totalPayoutAll;
    acc.minPayout += r.minMonthlyPayout;
    acc.openingProfit += r.openingProfitInRange;
    acc.operatingProfit += r.operatingProfit;
    acc.companyPnl += r.companyPnl;
    acc.monthsCount += getMonthlyForStore(r.store.id).length;
    acc.avgRevenue += r.avgMonthlyRevenue;
    acc.avgPayout += r.avgMonthlyPayout;
    return acc;
  }, { investment: 0, totalPayout: 0, monthlyRent: 0, monthlyLabor: 0, materialCost: 0, revenueAll: 0, payoutAll: 0, minPayout: 0, openingProfit: 0, operatingProfit: 0, companyPnl: 0, monthsCount: 0, avgRevenue: 0, avgPayout: 0 });

  const avgRevenueAll = sum.avgRevenue;
  // 지점별 회수비율이 다르므로 합계는 지점별 평균 회수금액을 합산
  const avgPayoutAll = sum.avgPayout;
  const aggregateMinPayout = sum.investment / 60;
  const avgRoi = aggregateMinPayout > 0 ? avgPayoutAll / aggregateMinPayout : 0;

  tfoot.innerHTML = `
    <tr>
      <td>합계</td>
      <td></td>
      <td></td>
      <td class="num center">${formatCurrency(sum.investment)}</td>
      <td class="num center">${formatCurrency(sum.totalPayout)}</td>
      <td class="num center">${renderRecoveryBar(sum.investment > 0 ? sum.totalPayout / sum.investment : 0, sum.investment > 0)}</td>
      <td class="num center">${formatCurrency(avgRevenueAll * 0.9)}</td>
      <td class="num center ${avgPayoutAll >= sum.minPayout / Math.max(rows.length, 1) ? "pos" : ""}">${formatCurrency(avgPayoutAll)}</td>
      <td class="num ${formatRoiDisplay(avgRoi, aggregateMinPayout).cls}">${formatRoiDisplay(avgRoi, aggregateMinPayout).text}</td>
      <td class="num center">${formatCurrency(sum.monthlyRent)}</td>
      <td>
        <div class="pnl-stack">
          <div class="pnl-line ${sum.operatingProfit < 0 ? "neg" : "accent"}"><span class="value">${formatCurrency(sum.operatingProfit)}</span></div>
        </div>
      </td>
      <td></td>
    </tr>
  `;

  updateSortHeaders();
}

function updateSortHeaders() {
  document.querySelectorAll("#store-table thead th[data-sort]").forEach((th) => {
    th.classList.remove("sorted");
    th.removeAttribute("data-arrow");
    if (th.dataset.sort === ui.sortKey) {
      th.classList.add("sorted");
      th.setAttribute("data-arrow", ui.sortDir === "asc" ? "↑" : "↓");
    }
  });
}

/* ============================================================
 *  월별 실적 테이블
 * ============================================================ */
function renderStoreSelect() {
  const sel = document.getElementById("monthly-store-select");
  if (state.stores.length === 0) {
    sel.innerHTML = '<option value="">— 등록된 지점 없음 —</option>';
    ui.selectedStoreId = null;
    return;
  }

  // 지점 상세 테이블과 동일한 정렬 순서
  const sorted = getSortedStoreRows(ui.filterStart, ui.filterEnd).map((r) => r.store);

  if (!ui.selectedStoreId || !sorted.find((s) => s.id === ui.selectedStoreId)) {
    ui.selectedStoreId = sorted[0].id;
  }
  sel.innerHTML = sorted
    .map((s) => `<option value="${s.id}" ${s.id === ui.selectedStoreId ? "selected" : ""}>${escapeHtml(s.name)}</option>`)
    .join("");
}

// 해당 연월의 달력상 일수 (예: 2026-04 → 30)
function daysInYearMonth(ym) {
  const [y, mo] = ym.split("-").map(Number);
  return new Date(y, mo, 0).getDate();
}

// 기본 실제 운영일수: 오픈월이면 오픈일~말일, 오픈 전이면 0, 이후면 그 달 전체
function defaultOperatingDays(store, ym) {
  const dim = daysInYearMonth(ym);
  if (!store.openDate) return dim;
  const openYM = store.openDate.slice(0, 7);
  if (ym < openYM) return 0;
  if (ym > openYM) return dim;
  const openDay = Number(store.openDate.slice(8, 10)) || 1;
  return Math.max(0, dim - openDay + 1);
}

// 실제 운영일수: 사용자가 입력한 값(operatingDays)이 있으면 우선, 없으면 기본 계산
function getOperatingDays(store, m) {
  if (m.operatingDays != null && m.operatingDays !== "") return Number(m.operatingDays);
  return defaultOperatingDays(store, m.yearMonth);
}

function renderMonthlyTable() {
  const tbody = document.getElementById("monthly-tbody");
  const tfoot = document.getElementById("monthly-tfoot");

  const store = state.stores.find((s) => s.id === ui.selectedStoreId);
  if (!store) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">먼저 지점을 추가하세요.</td></tr>';
    tfoot.innerHTML = "";
    return;
  }

  const rows = getMonthlyForStore(store.id);
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">해당 지점의 월별 실적이 없습니다. "+ 월 추가" 버튼으로 시작하세요.</td></tr>';
    tfoot.innerHTML = "";
    return;
  }

  let totalOpDays = 0;
  tbody.innerHTML = rows.map((m) => {
    const opProfit = (m.revenue || 0) * 0.9 * 0.1;  // 운영수익 = 매출 × 90% × 10% (= 9%)
    const payout = (m.revenue || 0) * 0.9 * 0.2; // 투자자 회수금 = 매출 × 90% × 회수비율(20%)
    const monthDays = daysInYearMonth(m.yearMonth);
    const opDays = getOperatingDays(store, m);
    totalOpDays += opDays;
    return `
      <tr data-month-key="${store.id}|${m.yearMonth}">
        <td><span class="cell-editable" data-edit="monthly" data-field="yearMonth" data-store-id="${store.id}" data-key="${m.yearMonth}" data-input-type="month">${m.yearMonth}</span></td>
        <td class="num cell-readonly">${monthDays}일</td>
        <td class="num"><span class="cell-editable" data-edit="monthly" data-field="operatingDays" data-store-id="${store.id}" data-key="${m.yearMonth}" data-input-type="number">${opDays}</span>일</td>
        <td class="num"><span class="cell-editable" data-edit="monthly" data-field="revenue" data-store-id="${store.id}" data-key="${m.yearMonth}" data-input-type="number">${formatCurrency(m.revenue)}</span></td>
        <td class="num cell-readonly">${formatCurrency(payout)}</td>
        <td class="num cell-readonly accent" style="color: var(--accent);">${formatCurrency(opProfit)}</td>
        <td class="col-action">
          <button class="btn-icon" data-delete-month="${store.id}|${m.yearMonth}" title="월 삭제">×</button>
        </td>
      </tr>
    `;
  }).join("");

  const totalRev = rows.reduce((s, m) => s + (m.revenue || 0), 0);
  const totalPayout = totalRev * 0.9 * 0.2; // 회수금 = 매출 × 90% × 회수비율(20%)
  const totalOp = totalRev * 0.9 * 0.1;     // 운영수익 = 매출 × 90% × 10%

  tfoot.innerHTML = `
    <tr>
      <td>합계</td>
      <td></td>
      <td class="num">${totalOpDays}일</td>
      <td class="num">${formatCurrency(totalRev)}</td>
      <td class="num">${formatCurrency(totalPayout)}</td>
      <td class="num" style="color: var(--accent);">${formatCurrency(totalOp)}</td>
      <td></td>
    </tr>
  `;
}

/* ============================================================
 *  편집 (더블클릭 → input)
 * ============================================================ */
function attachEditableHandlers() {
  document.body.addEventListener("dblclick", (e) => {
    const cell = e.target.closest(".cell-editable");
    if (!cell || cell.querySelector("input")) return;
    startEditing(cell);
  });
}

function startEditing(cell) {
  const inputType = cell.dataset.inputType || "text";
  const editKind = cell.dataset.edit;
  const field = cell.dataset.field;

  let originalValue, htmlInput;

  if (editKind === "store") {
    const store = state.stores.find((s) => s.id === cell.dataset.id);
    if (!store) return;
    originalValue = store[field];
  } else if (editKind === "monthly") {
    const m = state.monthly.find(
      (x) => x.storeId === cell.dataset.storeId && x.yearMonth === cell.dataset.key
    );
    if (!m) return;
    originalValue = m[field];
    // 실제 운영일을 아직 입력 안 했으면 현재 계산값을 편집 초기값으로 사용
    if (field === "operatingDays" && (originalValue == null || originalValue === "")) {
      const store = state.stores.find((s) => s.id === cell.dataset.storeId);
      if (store) originalValue = getOperatingDays(store, m);
    }
  }

  if (inputType === "number") {
    htmlInput = document.createElement("input");
    htmlInput.type = "number";
    htmlInput.step = "any";
    htmlInput.value = Number(originalValue) || 0;
  } else if (inputType === "rent") {
    // 금액(3000000) 또는 매출 비율(10%) 모두 허용 → 텍스트 입력
    const store = state.stores.find((s) => s.id === cell.dataset.id);
    const rate = getRentRate(store);
    htmlInput = document.createElement("input");
    htmlInput.type = "text";
    htmlInput.inputMode = "decimal";
    htmlInput.placeholder = "3000000 또는 10%";
    htmlInput.value = rate != null
      ? `${Number((rate * 100).toFixed(2))}%`
      : String(Number(store?.monthlyRent) || 0);
  } else if (inputType === "rate") {
    htmlInput = document.createElement("input");
    htmlInput.type = "number";
    htmlInput.step = "0.01";
    htmlInput.min = "0";
    htmlInput.max = "100";
    htmlInput.value = ((Number(originalValue) || 0) * 100).toFixed(2);
  } else if (inputType === "date") {
    htmlInput = document.createElement("input");
    htmlInput.type = "date";
    htmlInput.value = originalValue || "";
  } else if (inputType === "month") {
    htmlInput = document.createElement("input");
    htmlInput.type = "month";
    htmlInput.value = originalValue || "";
  } else {
    htmlInput = document.createElement("input");
    htmlInput.type = "text";
    htmlInput.value = originalValue || "";
  }

  htmlInput.className = "cell-input";
  cell.innerHTML = "";
  cell.appendChild(htmlInput);
  htmlInput.focus();
  if (htmlInput.select) htmlInput.select();

  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    let newValue = htmlInput.value;
    if (inputType === "number") newValue = parseNumberInput(newValue);
    else if (inputType === "rate") newValue = parseNumberInput(newValue) / 100;
    else if (inputType === "rent") newValue = parseRentInput(newValue); // { monthlyRent?, monthlyRentRate }

    applyEdit(editKind, cell, field, newValue);
  };
  const cancel = () => {
    if (committed) return;
    committed = true;
    renderAll();
  };

  htmlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  htmlInput.addEventListener("blur", commit);
}

function applyEdit(editKind, cell, field, newValue) {
  if (editKind === "store") {
    const store = state.stores.find((s) => s.id === cell.dataset.id);
    if (!store) return;
    // 임대료처럼 한 번에 여러 필드를 바꾸는 편집(금액/비율 전환)
    if (newValue && typeof newValue === "object") Object.assign(store, newValue);
    else store[field] = newValue;
  } else if (editKind === "monthly") {
    const m = state.monthly.find(
      (x) => x.storeId === cell.dataset.storeId && x.yearMonth === cell.dataset.key
    );
    if (!m) return;
    if (field === "yearMonth") {
      const dup = state.monthly.find(
        (x) => x.storeId === m.storeId && x.yearMonth === newValue && x !== m
      );
      if (dup) {
        showToast("이미 같은 연월의 데이터가 있습니다.");
        renderAll();
        return;
      }
    }
    m[field] = newValue;
  }
  saveToStorage();
  renderAll();
}

/* ============================================================
 *  CRUD
 * ============================================================ */
function addStore() {
  const newStore = {
    id: uid("s"),
    name: `새 지점 ${state.stores.length + 1}`,
    type: STORE_TYPE_DIRECT,
    openDate: todayISO(),
    openingProfit: 0,
    operatingProfitRate: DEFAULT_OP_RATE,
    totalInvestment: 0,
    monthlyRent: 0,
    monthlyLabor: DEFAULT_MONTHLY_LABOR,
  };
  state.stores.push(newStore);
  ui.selectedStoreId = newStore.id;
  saveToStorage();
  renderAll();
  showToast("지점이 추가되었습니다.");
}

function toggleStoreType(id) {
  const store = state.stores.find((s) => s.id === id);
  if (!store) return;
  const current = getStoreType(store);
  store.type = current === STORE_TYPE_DIRECT ? STORE_TYPE_OWNER : STORE_TYPE_DIRECT;
  saveToStorage();
  renderAll();
}

function deleteStore(id) {
  openConfirm({
    title: "지점 삭제",
    message: "이 지점과 관련 월별 실적이 모두 삭제됩니다. 계속하시겠습니까?",
    onConfirm: () => {
      state.stores = state.stores.filter((s) => s.id !== id);
      state.monthly = state.monthly.filter((m) => m.storeId !== id);
      if (ui.selectedStoreId === id) ui.selectedStoreId = state.stores[0]?.id || null;
      saveToStorage();
      renderAll();
      showToast("삭제되었습니다.");
    },
  });
}

function addMonth() {
  if (!ui.selectedStoreId) {
    showToast("먼저 지점을 추가하세요.");
    return;
  }
  const existing = getMonthlyForStore(ui.selectedStoreId);
  let nextYM;
  if (existing.length > 0) {
    const last = existing[existing.length - 1].yearMonth;
    let [y, m] = last.split("-").map(Number);
    m++; if (m > 12) { m = 1; y++; }
    nextYM = `${y}-${pad(m)}`;
  } else {
    const today = new Date();
    nextYM = `${today.getFullYear()}-${pad(today.getMonth() + 1)}`;
  }
  if (state.monthly.find((x) => x.storeId === ui.selectedStoreId && x.yearMonth === nextYM)) {
    showToast("이미 존재하는 연월입니다. 더블클릭으로 연월을 변경하세요.");
    return;
  }
  state.monthly.push({
    storeId: ui.selectedStoreId,
    yearMonth: nextYM,
    revenue: 0,
    investorPayout: 0,
  });
  saveToStorage();
  renderAll();
}

function deleteMonth(storeId, yearMonth) {
  state.monthly = state.monthly.filter(
    (m) => !(m.storeId === storeId && m.yearMonth === yearMonth)
  );
  saveToStorage();
  renderAll();
}

/* ============================================================
 *  바리스 API 임포트
 * ============================================================ */
/**
 * 바리스 API 호출 정책:
 *   - 운영 데이터(주문/메뉴/가격/키오스크/로봇 등)에 영향 주는 쓰기 호출은 절대 사용 금지.
 *   - 허용되는 비-GET 호출은 다음 두 개로 엄격히 제한:
 *       1) POST /xmanager/login/web   : 로그인 (인증 토큰 발급)
 *       2) PUT  /xmanager/branches/change : 현재 세션의 "보고 있는 지점" 전환
 *          ↳ 비즈니스 데이터를 변경하지 않으며 매장 운영에 영향 없음.
 *            다지점 매출을 단일 로그인으로 읽기 위해서만 사용.
 *   - 그 외 매출/지점 정보 조회는 모두 GET 사용.
 */
async function barisLogin(account, password) {
  const r = await fetch(`${BARIS_API_BASE}/xmanager/login/web`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account, password }),
  });
  // 응답 본문을 먼저 파싱(서버가 실패 사유를 payload.message로 내려줌)
  let j = null;
  try { j = await r.json(); } catch { /* 본문 없음 */ }
  const payload = j?.payload;

  if (!payload?.accessToken) {
    // 서버가 준 실제 메시지를 그대로 노출 (예: "관리자 정보 없음", "비밀번호 불일치")
    const serverMsg = payload?.message || j?.message;
    if (serverMsg) throw new Error(`로그인 실패: ${serverMsg}`);
    if (!r.ok) throw new Error(`로그인 실패 (HTTP ${r.status})`);
    throw new Error("로그인 응답에 토큰이 없습니다.");
  }
  if (!payload?.branchID) throw new Error("로그인 응답에 지점 정보가 없습니다.");
  return payload; // { accessToken, branchID, name, managerID, ... }
}

async function barisGet(path, token) {
  const r = await fetch(`${BARIS_API_BASE}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`API 오류 ${r.status}: ${path}`);
  return r.json();
}

/**
 * 매출 조회.
 *  - 과거 월: tot_sell_month_predict (예상매출).
 *    : 0매출 일자를 비-0 일평균으로 채워 추정. 월 중간 오픈 케이스 처리.
 *  - 현재(진행 중)/미래 월: tot_sell_month - tot_refund_month (실제 누적).
 *    : 며칠 안 지난 시점에서의 과대 추정 방지.
 */
async function barisFetchMonthRevenue(branchID, ym, token) {
  const yyyymm = ym.replace("-", "");
  const j = await barisGet(`/analysis/sales/calendar/${branchID}/${yyyymm}`, token);
  const p = j?.payload || {};
  const actual = Number(p.tot_sell_month || 0);
  const refund = Number(p.tot_refund_month || 0);
  const predict = Number(p.tot_sell_month_predict || 0);

  if (!isMonthInProgressOrFuture(ym) && predict > 0) {
    return predict;
  }
  return Math.max(0, actual - refund);
}

function isMonthInProgressOrFuture(ym) {
  const now = new Date();
  const curYM = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  return ym >= curYM;
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

const BARIS_BRAND_FILTER = "라운지엑스24h";

async function barisFetchOwnBranches(token) {
  const j = await barisGet("/xmanager/branches/own", token);
  return Array.isArray(j?.payload) ? j.payload : [];
}

/**
 * 세션의 "현재 지점"을 바꾸고 새 토큰을 받음. 비즈니스 데이터에 영향 없음.
 * 다지점 매출을 읽기 위해서만 사용. 다른 쓰기 호출은 절대 추가하지 말 것.
 */
async function barisChangeBranch(branchID, token) {
  const r = await fetch(`${BARIS_API_BASE}/xmanager/branches/change`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ branch_id: branchID }),
  });
  if (!r.ok) throw new Error(`지점 전환 실패 (HTTP ${r.status}): ${branchID}`);
  const j = await r.json();
  const newToken = j?.payload?.accessToken;
  if (!newToken) throw new Error(`지점 전환 응답에 토큰이 없습니다: ${branchID}`);
  return newToken;
}

async function importFromBaris({ account, password, token: presetToken, startYM, endYM, onProgress }) {
  let token;
  if (presetToken) {
    token = presetToken; // 이미 로그인된 토큰 재사용(비번 재입력 불필요)
  } else {
    onProgress?.("로그인 중...");
    const auth = await barisLogin(account, password);
    token = auth.accessToken;
  }
  setBarisToken(token); // 클라우드 저장/불러오기 인증에 재사용

  onProgress?.("지점 목록 조회 중...");
  const owned = await barisFetchOwnBranches(token);

  // "라운지엑스24h" 포함된 지점만 대상
  const targets = owned.filter((b) =>
    (b.branchNmKo || "").includes(BARIS_BRAND_FILTER) ||
    (b.branchNmEn || "").includes(BARIS_BRAND_FILTER)
  );

  if (targets.length === 0) {
    const ownedSummary = owned
      .map((b) => `${b.branchID}=${b.branchNmKo || b.branchNmEn || "(이름없음)"}`)
      .join(", ");
    throw new Error(
      `"${BARIS_BRAND_FILTER}" 포함된 지점이 없습니다.\n소유 지점: ${ownedSummary || "(없음)"}`
    );
  }

  const months = monthsRange(startYM, endYM);
  const total = targets.length * months.length;
  let done = 0;
  const branchResults = [];

  for (let i = 0; i < targets.length; i++) {
    const b = targets[i];
    const branchName = b.branchNmKo || b.branchNmEn || b.branchID;

    onProgress?.(`(${i + 1}/${targets.length}) ${branchName} 세션 전환 중...`);
    let branchToken;
    try {
      branchToken = await barisChangeBranch(b.branchID, token);
    } catch (e) {
      onProgress?.(`${branchName} 건너뜀: ${e.message}`);
      done += months.length;
      continue;
    }

    onProgress?.(`(${i + 1}/${targets.length}) ${branchName} 매출 조회 중...`);
    const monthResults = await runWithConcurrency(months, 6, async (ym) => {
      try {
        const revenue = await barisFetchMonthRevenue(b.branchID, ym, branchToken);
        return { ym, revenue };
      } catch {
        return { ym, revenue: 0 };
      } finally {
        done++;
        if (done % 5 === 0 || done === total) {
          onProgress?.(`매출 조회 중... ${done}/${total}`);
        }
      }
    });

    let firstYM = null;
    const monthly = [];
    for (const { ym, revenue } of monthResults) {
      if (revenue > 0) {
        if (!firstYM || ym < firstYM) firstYM = ym;
        monthly.push({ storeId: b.branchID, yearMonth: ym, revenue, investorPayout: 0 });
      }
    }

    branchResults.push({
      branchID: b.branchID,
      branchName,
      firstYM,
      monthly,
      monthCount: monthly.length,
    });
  }

  return { branches: branchResults };
}

/** 단일 지점 결과를 기존 상태에 안전하게 병합 */
function mergeBarisResult(result) {
  const { branchID, branchName, firstYM, monthly } = result;

  // 1) stores: 이미 있으면 보존(투자금/오픈수익/오픈일 등 사용자 입력 유지), 없으면 추가
  const existing = state.stores.find((s) => s.id === branchID);
  if (!existing) {
    state.stores.push({
      id: branchID,
      name: branchName,
      type: STORE_TYPE_DIRECT,
      openDate: firstYM ? `${firstYM}-01` : todayISO(),
      openingProfit: 0,
      operatingProfitRate: DEFAULT_OP_RATE,
      totalInvestment: 0,
      monthlyRent: 0,
      monthlyLabor: DEFAULT_MONTHLY_LABOR,
    });
  } else if (!existing.name) {
    existing.name = branchName;
  }

  // 2) monthly: 해당 지점의 month는 매출만 갱신, investorPayout(사용자 입력)는 보존
  const incomingByYM = new Map(monthly.map((m) => [m.yearMonth, m.revenue]));
  // 기존 항목 업데이트
  for (const m of state.monthly) {
    if (m.storeId === branchID && incomingByYM.has(m.yearMonth)) {
      m.revenue = incomingByYM.get(m.yearMonth);
      incomingByYM.delete(m.yearMonth);
    }
  }
  // 신규 월 추가
  for (const [ym, revenue] of incomingByYM) {
    state.monthly.push({ storeId: branchID, yearMonth: ym, revenue, investorPayout: 0 });
  }

  if (!ui.selectedStoreId) ui.selectedStoreId = branchID;
}

/* ============================================================
 *  바리스 모달
 * ============================================================ */
// mode: "import"(업데이트=바리스 매출 전체 가져오기) | "sync"(로그인 후 클라우드 최신만 빠르게)
function openBarisModal(mode = "import") {
  ui.barisMode = mode === "sync" ? "sync" : "import";
  const modal = document.getElementById("modal-baris");
  const form = document.getElementById("baris-form");
  form.reset();
  setBarisStatus("", "");
  // 진행상황 모드에서 숨겼던 요소 복원
  const desc = modal.querySelector(".muted");
  if (desc) desc.style.display = "";
  form.style.display = "";
  const h = modal.querySelector("h3");
  const submitBtn = document.getElementById("btn-baris-submit");
  if (submitBtn) submitBtn.style.display = "";
  if (ui.barisMode === "sync") {
    if (h) h.textContent = "로그인 (최신 데이터 동기화)";
    if (submitBtn) submitBtn.textContent = "로그인";
  } else {
    if (h) h.textContent = "바리스에서 매출 가져오기";
    if (submitBtn) submitBtn.textContent = "가져오기";
  }
  modal.hidden = false;
  setTimeout(() => form.elements.account.focus(), 50);
}

// 로그인 입력 없이 진행상황만 보여주는 모달(이미 로그인된 상태에서 업데이트할 때)
function openBarisProgress(title) {
  const modal = document.getElementById("modal-baris");
  const h = modal.querySelector("h3");
  const desc = modal.querySelector(".muted");
  const form = document.getElementById("baris-form");
  const submitBtn = document.getElementById("btn-baris-submit");
  if (h) h.textContent = title;
  if (desc) desc.style.display = "none";
  form.style.display = "none";
  if (submitBtn) submitBtn.style.display = "none";
  setBarisStatus("", "");
  modal.hidden = false;
}

const BARIS_DEFAULT_START_YM = "2026-01";
function getCurrentYM() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function closeBarisModal() {
  document.getElementById("modal-baris").hidden = true;
}

function setBarisStatus(text, kind = "") {
  const el = document.getElementById("baris-status");
  el.textContent = text || "";
  el.className = "baris-status" + (kind ? ` ${kind}` : "");
}

// 공통 임포트 실행: importArgs(account/password 또는 token)를 받아 실행하고 화면 반영
async function runBarisImport(importArgs, disableBtns) {
  const startYM = BARIS_DEFAULT_START_YM;
  const endYM = getCurrentYM();
  disableBtns(true);
  try {
    const result = await importFromBaris({
      ...importArgs, startYM, endYM,
      onProgress: (msg) => setBarisStatus(msg, ""),
    });

    // 가장 최근 저장본 우선으로 클라우드 반영(다른 기기 변경 반영 + 내 미저장 입력 보호).
    // 그 위에 바리스 매출을 병합하고, 끝에 저장하며 이 결과를 최신본으로 만든다.
    setBarisStatus("클라우드 동기화 중...", "");
    await cloudPull();

    for (const b of result.branches) mergeBarisResult(b);
    const def = getDefaultFilter();
    ui.filterStart = def.start;
    ui.filterEnd = def.end;
    document.getElementById("filter-start").value = ui.filterStart;
    document.getElementById("filter-end").value = ui.filterEnd;
    saveToStorage();
    renderAll();

    // 병합 결과를 클라우드에 자동 저장 → 모든 기기 공통
    await cloudSave({ silent: true });

    const totalMonthly = result.branches.reduce((s, b) => s + b.monthCount, 0);
    const names = result.branches.map((b) => b.branchName).join(", ");
    setBarisStatus(
      `✓ ${result.branches.length}개 지점 / 매출 ${totalMonthly}건 업데이트 완료.\n${names}`,
      "ok"
    );
    showToast(`${result.branches.length}개 지점을 업데이트했습니다.`);
    setTimeout(closeBarisModal, 1800);
  } catch (err) {
    const msg = err.message || String(err);
    // 토큰 만료(401) 등 인증 실패면 로그인 재요청
    if (/401|로그인|관리자 정보/.test(msg)) {
      localStorage.removeItem(BARIS_TOKEN_STORAGE);
      openBarisModal("import");
      setBarisStatus("로그인이 만료됐습니다. 다시 로그인해 주세요.", "error");
    } else {
      setBarisStatus(msg, "error");
    }
  } finally {
    disableBtns(false);
  }
}

function setBarisBtnsDisabled(v) {
  document.getElementById("btn-baris-submit").disabled = v;
}

async function handleBarisSubmit() {
  const form = document.getElementById("baris-form");
  const account = form.elements.account.value.trim();
  const password = form.elements.password.value;

  if (!account || !password) {
    setBarisStatus("관리자 ID와 비밀번호를 입력하세요.", "error");
    return;
  }

  if (ui.barisMode === "sync") {
    // 빠른 로그인 + 클라우드 최신만 반영(바리스 매출 전체 재조회는 하지 않음)
    setBarisBtnsDisabled(true);
    try {
      setBarisStatus("로그인 중...", "");
      const auth = await barisLogin(account, password);
      setBarisToken(auth.accessToken);
      setBarisStatus("최신 데이터 불러오는 중...", "");
      await cloudPull();
      refreshAfterDataChange();
      setBarisStatus("✓ 최신 데이터를 불러왔습니다.", "ok");
      showToast("동기화 완료");
      setTimeout(closeBarisModal, 1000);
    } catch (err) {
      setBarisStatus(err.message || String(err), "error");
    } finally {
      setBarisBtnsDisabled(false);
      form.elements.password.value = "";
      form.elements.account.value = "";
    }
    return;
  }

  await runBarisImport({ account, password }, setBarisBtnsDisabled);
  // 비밀번호·ID 즉시 제거
  form.elements.password.value = "";
  form.elements.account.value = "";
}

/* ============================================================
 *  모달 / 토스트
 * ============================================================ */
let modalConfirmHandler = null;

function openConfirm({ title, message, onConfirm }) {
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-message").textContent = message;
  modalConfirmHandler = onConfirm;
  document.getElementById("modal").hidden = false;
}

function closeModal() {
  document.getElementById("modal").hidden = true;
  modalConfirmHandler = null;
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

/* ============================================================
 *  필터
 * ============================================================ */
function initFilters() {
  const def = getDefaultFilter();
  ui.filterStart = def.start;
  ui.filterEnd = def.end;

  const startEl = document.getElementById("filter-start");
  const endEl = document.getElementById("filter-end");
  startEl.value = ui.filterStart;
  endEl.value = ui.filterEnd;

  startEl.addEventListener("change", (e) => {
    ui.filterStart = e.target.value || ui.filterStart;
    if (ui.filterStart > ui.filterEnd) ui.filterStart = ui.filterEnd;
    startEl.value = ui.filterStart;
    renderAll();
  });
  endEl.addEventListener("change", (e) => {
    ui.filterEnd = e.target.value || ui.filterEnd;
    if (ui.filterEnd < ui.filterStart) ui.filterEnd = ui.filterStart;
    endEl.value = ui.filterEnd;
    renderAll();
  });

  document.getElementById("btn-all-period").addEventListener("click", () => {
    const r = getDataDateRange();
    ui.filterStart = r.min;
    ui.filterEnd = r.max;
    startEl.value = r.min;
    endEl.value = r.max;
    renderAll();
  });

  const applyRecent = (months) => {
    const r = getRecentFilter(months);
    ui.filterStart = r.start;
    ui.filterEnd = r.end;
    startEl.value = r.start;
    endEl.value = r.end;
    renderAll();
  };
  document.getElementById("btn-recent-12").addEventListener("click", () => applyRecent(12));
  document.getElementById("btn-recent-3").addEventListener("click", () => applyRecent(3));
  document.getElementById("btn-recent-1").addEventListener("click", () => applyRecent(1));
}

/* ============================================================
 *  이벤트 바인딩
 * ============================================================ */
function bindEvents() {
  // 화면 폭이 차트 범례 브레이크포인트(760px)를 넘나들면 차트만 다시 그림
  let lastNarrow = window.matchMedia("(max-width: 760px)").matches;
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const narrow = window.matchMedia("(max-width: 760px)").matches;
      if (narrow !== lastNarrow) {
        lastNarrow = narrow;
        renderChart(ui.filterStart, ui.filterEnd);
        renderProfitChart(ui.filterStart, ui.filterEnd);
        renderTrendChart(ui.filterStart, ui.filterEnd);
      }
    }, 150);
  });


  document.getElementById("btn-save").addEventListener("click", cloudSave);

  document.getElementById("btn-add-store").addEventListener("click", addStore);
  document.getElementById("btn-add-month").addEventListener("click", addMonth);

  // 식자재 비율 변경(전 지점 공통)
  document.getElementById("material-rate-select").addEventListener("change", (e) => {
    state.materialRate = parseFloat(e.target.value);
    saveToStorage();
    renderAll();
  });

  document.getElementById("monthly-store-select").addEventListener("change", (e) => {
    ui.selectedStoreId = e.target.value;
    renderMonthlyTable();
  });

  // 정렬 (헤더가 매 렌더마다 재생성되므로 위임 방식으로 바인딩)
  document.getElementById("store-thead").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]");
    if (!th) return;
    const k = th.dataset.sort;
    if (ui.sortKey === k) {
      ui.sortDir = ui.sortDir === "asc" ? "desc" : "asc";
    } else {
      ui.sortKey = k;
      ui.sortDir = "asc";
    }
    renderStoreTable(ui.filterStart, ui.filterEnd);
    renderStoreSelect();
  });

  // 삭제 + 타입 토글 위임
  document.body.addEventListener("click", (e) => {
    const dStore = e.target.closest("[data-delete-store]");
    if (dStore) {
      deleteStore(dStore.dataset.deleteStore);
      return;
    }
    const dMonth = e.target.closest("[data-delete-month]");
    if (dMonth) {
      const [storeId, ym] = dMonth.dataset.deleteMonth.split("|");
      deleteMonth(storeId, ym);
      return;
    }
    const tChip = e.target.closest("[data-toggle-type]");
    if (tChip) {
      toggleStoreType(tChip.dataset.toggleType);
      return;
    }
  });

  // 모달
  document.querySelectorAll("#modal [data-close]").forEach((el) =>
    el.addEventListener("click", closeModal)
  );
  document.getElementById("modal-confirm").addEventListener("click", () => {
    if (modalConfirmHandler) modalConfirmHandler();
    closeModal();
  });

  // 로그인 ↔ 로그아웃 토글
  document.getElementById("btn-login").addEventListener("click", () => {
    if (getBarisToken()) logout();
    else openBarisModal("sync");
  });

  // 업데이트(바리스 매출 갱신). 이미 로그인돼 있으면 비번 재입력 없이 토큰으로 바로 실행.
  document.getElementById("btn-baris").addEventListener("click", () => {
    const token = getBarisToken();
    if (!token) { openBarisModal("import"); return; }
    openBarisProgress("바리스 매출 업데이트 중...");
    runBarisImport({ token }, setBarisBtnsDisabled);
  });
  document.querySelectorAll("#modal-baris [data-close-baris]").forEach((el) =>
    el.addEventListener("click", closeBarisModal)
  );
  // 제출은 폼 submit 이벤트 하나로만 처리(버튼 click 중복 바인딩 제거 → 로그인 1회만 호출)
  document.getElementById("baris-form").addEventListener("submit", (e) => {
    e.preventDefault();
    handleBarisSubmit();
  });

  // ESC로 열려 있는 모달 닫기
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!document.getElementById("modal-baris").hidden) closeBarisModal();
    if (!document.getElementById("modal").hidden) closeModal();
  });

  // 편집
  attachEditableHandlers();
}

/* ============================================================
 *  유틸: HTML escape
 * ============================================================ */
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[c]));
}

/* ============================================================
 *  부트
 * ============================================================ */
// 데이터가 통째로 바뀐 뒤(클라우드 반영 등) 선택 지점/필터를 보정하고 다시 그림
function refreshAfterDataChange() {
  if (!ui.selectedStoreId || !state.stores.find((s) => s.id === ui.selectedStoreId)) {
    ui.selectedStoreId = state.stores[0] ? state.stores[0].id : null;
  }
  const def = getDefaultFilter();
  ui.filterStart = def.start;
  ui.filterEnd = def.end;
  const se = document.getElementById("filter-start");
  const ee = document.getElementById("filter-end");
  if (se) se.value = ui.filterStart;
  if (ee) ee.value = ui.filterEnd;
  renderAll();
}

function init() {
  // 초기 데이터 없음(빈 상태로 시작). 데이터는 "업데이트"/직접 입력/클라우드에서 가져옴.
  loadFromStorage();
  if (state.stores.length > 0) ui.selectedStoreId = state.stores[0].id;

  initFilters();
  bindEvents();
  renderAll();

  // 클라우드 공유 데이터를 불러와(최근 저장본 우선) 모든 기기에서 공통 표시
  cloudPull().then((pulled) => {
    if (pulled) refreshAfterDataChange();
    // 토큰이 없으면(미로그인/만료) 자동으로 로그인 창을 띄워 최신 데이터 동기화 유도
    if (!getBarisToken()) {
      openBarisModal("sync");
      setBarisStatus("다른 기기의 최신 데이터를 보려면 로그인하세요.", "");
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
