/* ============================================================
 * 라운지엑스24h 대시보드
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
  barisMode: "import",  // "import"(매출 전체 가져오기) | "sync"(로그인 후 클라우드 최신만)
};

let revenueChart = null;
let trendChart = null;

// 지점 운영 현황(바리스 홈과 같은 값). 실시간 상태라 저장하지 않고 화면에서만 쓴다.
let branchStatusSummary = null;

/* ============================================================
 *  유틸 / 포맷
 * ============================================================ */
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

/**
 * 그 달의 객단가 — 바리스에서 받아온 avgTicket(avg_cust_tran)을 우선 쓰고,
 * 없으면(수기로 객수만 넣은 달) 매출 ÷ 객수로 대체한다.
 */
function monthTicket(m) {
  const imported = Number(m.avgTicket) || 0;
  if (imported > 0) return imported;
  const customers = Number(m.customers) || 0;
  return customers > 0 ? (m.revenue || 0) / customers : 0;
}

function getStoreMetrics(store, startYM, endYM) {
  const all = getMonthlyForStore(store.id);
  const filtered = all.filter((m) => inRange(m.yearMonth, startYM, endYM));

  const totalRevenue = filtered.reduce((s, m) => s + (m.revenue || 0), 0);
  // 객수·객단가는 값이 있는 달만 대상으로 한다(일부 달만 있어도 평균이 희석되지 않게)
  const withCustomers = filtered.filter((m) => (Number(m.customers) || 0) > 0);
  const customersFiltered = withCustomers.reduce((s, m) => s + Number(m.customers), 0);
  // 객단가 합계 = Σ(객단가 × 객수) → 나중에 객수로 나누면 객수 가중평균이 된다
  const ticketSumFiltered = withCustomers.reduce((s, m) => s + monthTicket(m) * Number(m.customers), 0);

  // 지점 상세용(전체 기간 기준)
  const withCustomersAll = all.filter((m) => (Number(m.customers) || 0) > 0);
  const customersAll = withCustomersAll.reduce((s, m) => s + Number(m.customers), 0);
  const ticketSumAll = withCustomersAll.reduce((s, m) => s + monthTicket(m) * Number(m.customers), 0);
  const avgTicket = customersAll > 0 ? ticketSumAll / customersAll : 0;
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
    avgMonthlyRevenueFiltered,
    filteredOpDays,
    customersFiltered,
    ticketSumFiltered,
    customersAll,
    ticketSumAll,
    avgTicket,
  };
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
  ["kpi-revenue", "kpi-avg-store-revenue", "kpi-avg-daily-revenue", "kpi-avg-ticket"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = "-";
  });
  ["kpi-avg-ticket-sub"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = "";
  });
  branchStatusSummary = null;
  renderBranchStatus();
  if (revenueChart) { revenueChart.destroy(); revenueChart = null; }
  if (trendChart) { trendChart.destroy(); trendChart = null; }
  ["chart-revenue-wrap", "chart-trend-wrap"].forEach((id) => {
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
  ["chart-period", "chart-trend-period"].forEach((id) => {
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

  renderKPI(startYM, endYM);
  renderChart(startYM, endYM);
  renderTrendChart(startYM, endYM);
  renderStoreTable(startYM, endYM);

  document.getElementById("chart-period").textContent =
    state.stores.length === 0 ? "" : `${startYM} ~ ${endYM}`;
}

// 로그아웃: 토큰·데이터 삭제 후 잠금 화면
function logout() {
  localStorage.removeItem(BARIS_TOKEN_STORAGE);
  localStorage.removeItem(STORAGE_KEY);
  state.stores = [];
  state.monthly = [];
  state.updatedAt = 0;
  renderAll();
  showToast("로그아웃되었습니다.");
}

/* ============================================================
 *  KPI
 * ============================================================ */
/** 바리스에서 지점 운영 상태를 받아 "라운지엑스24h" 지점만 집계 */
async function refreshBranchStatus() {
  const token = getBarisToken();
  if (!token) {
    branchStatusSummary = null;
    renderBranchStatus();
    return;
  }
  try {
    const rows = await barisFetchBranchStatus(token);
    const mine = rows
      .filter((r) => r.branchName.includes(BARIS_BRAND_FILTER))
      .sort((a, b) => a.branchName.localeCompare(b.branchName, "ko"));
    const operating = mine.filter((r) => r.status === "OPERATING").length;
    branchStatusSummary = {
      total: mine.length,
      operating,
      idle: mine.length - operating,
      branches: mine,
    };
    renderBranchStatus(); // 상태 타일을 먼저 그리고, 주문가능 수는 받는 대로 채운다

    // 지점별 오늘 실적/상품 수 — 바리스 운영관리 페이지와 같은 소스
    const detailErrors = [];
    await runWithConcurrency(mine, 4, async (b) => {
      if (!b.branchId) {
        detailErrors.push(`${b.branchName}: branchId 없음`);
        return;
      }
      // 캘린더 API는 세션의 "현재 지점"에 묶여 있어 지점 전환 토큰이 필요하다.
      // 지점당 한 번만 전환해 두 조회에 함께 쓴다(전환 실패 시 기본 토큰으로 시도).
      let branchToken = token;
      try {
        branchToken = await barisChangeBranch(b.branchId, token);
      } catch (e) {
        detailErrors.push(`${b.branchName}: 지점 전환 실패 (${e.message})`);
      }
      try {
        Object.assign(b, await barisFetchBranchDashboard(b.branchId, branchToken));
      } catch (e) {
        detailErrors.push(`${b.branchName}: 오늘 지표 (${e.message})`);
      }
      try {
        Object.assign(b, await barisFetchDailySeries(b.branchId, branchToken));
      } catch (e) {
        detailErrors.push(`${b.branchName}: 일별 실적 (${e.message})`);
      }
      try {
        Object.assign(b, await barisFetchPayTypes(b.branchId, branchToken));
      } catch (e) {
        detailErrors.push(`${b.branchName}: 결제수단 (${e.message})`);
      }
    });
    // 새로운 결제수단이 생기면 알아볼 수 있게 종류를 남긴다
    const payTypeNames = [...new Set(mine.flatMap((b) => (b.payTypes || []).map((p) => p.name)))];
    if (payTypeNames.length) console.info("[결제수단 종류]", payTypeNames.join(", "));
    // 바리스 매출분석 화면과 숫자를 직접 대조할 수 있게 원본을 남긴다
    const payRows = mine.flatMap((b) =>
      (b.payTypes || []).map((p) => ({ 지점: b.branchName, 결제수단: p.name, 건수: p.count, 금액: p.amount }))
    );
    if (payRows.length && console.table) console.table(payRows);

    const ok = mine.filter((b) => Number.isFinite(b.orderable)).length;
    const graphed = mine.filter((b) => (b.series || []).length > 0).length;
    if (detailErrors.length) console.warn("[지점 상세 조회 실패]", detailErrors);
    // 오늘 지표든 배경 그래프든 전 지점이 비면 원인을 화면에도 알린다
    if ((ok === 0 || graphed === 0) && detailErrors.length) {
      showToast(`지점 상세 조회 실패 — ${detailErrors[0]}`);
    }
  } catch (e) {
    console.warn("[지점 운영 현황 조회 실패]", e?.message || e);
    branchStatusSummary = null; // 조회 실패 시 카드 자체를 감춘다(빈 값 표시 방지)
  }
  renderBranchStatus();
  // 지점 상세의 "현장 : 앱" 열은 방금 받은 결제수단을 쓰므로 함께 다시 그린다
  if (state.stores.length > 0) renderStoreTable(ui.filterStart, ui.filterEnd);
}

/* ── 오늘 날씨 ──────────────────────────────────────────────
 *  Open-Meteo(무료·키 불필요·CORS 허용)에서 서울 현재 날씨를 받는다.
 *  실패하면 바리스 매출 캘린더가 주는 그날의 weather 문자열로 대체한다. */
const SEOUL = { lat: 37.5665, lon: 126.978 };

// WMO 날씨 코드 → { 아이콘 종류, 한국어 }
function wmoToWeather(code) {
  const c = Number(code);
  if (c === 0) return { kind: "clear", label: "맑음" };
  if (c === 1) return { kind: "partly", label: "구름 조금" };
  if (c === 2) return { kind: "partly", label: "구름 많음" };
  if (c === 3) return { kind: "cloudy", label: "흐림" };
  if (c === 45 || c === 48) return { kind: "fog", label: "안개" };
  if (c >= 51 && c <= 57) return { kind: "rain", label: "이슬비" };
  if (c >= 61 && c <= 67) return { kind: "rain", label: "비" };
  if (c >= 71 && c <= 77) return { kind: "snow", label: "눈" };
  if (c >= 80 && c <= 82) return { kind: "rain", label: "소나기" };
  if (c === 85 || c === 86) return { kind: "snow", label: "눈" };
  if (c >= 95) return { kind: "thunder", label: "뇌우" };
  return { kind: "cloudy", label: "흐림" };
}

// 바리스 캘린더 문자열 → 같은 아이콘 종류
const BARIS_WEATHER_KIND = {
  "맑음": "clear",
  "구름많음": "partly",
  "흐림": "cloudy",
  "비": "rain",
  "소나기": "rain",
  "비/눈": "snow",
  "눈": "snow",
};

let todayWeatherLive = null; // { kind, label, temp }

async function refreshWeather() {
  try {
    const r = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${SEOUL.lat}&longitude=${SEOUL.lon}` +
      `&current=temperature_2m,weather_code&timezone=Asia%2FSeoul`
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const cur = (await r.json())?.current;
    if (!cur) throw new Error("current 없음");
    todayWeatherLive = { ...wmoToWeather(cur.weather_code), temp: toFiniteNumber(cur.temperature_2m) };
  } catch (e) {
    console.warn("[날씨 조회 실패]", e?.message || e); // 캘린더 값으로 대체된다
  }
  renderToday();
}

/* 손그림 느낌의 작은 날씨 아이콘 — 이모지는 OS마다 모양이 달라 직접 그린다 */
function weatherIcon(kind) {
  const sun = `<circle cx="9" cy="9" r="4.2" fill="#FFC53D"/>` +
    [0, 45, 90, 135, 180, 225, 270, 315]
      .map((deg) => `<line x1="9" y1="1.6" x2="9" y2="3.4" stroke="#FFC53D" stroke-width="1.6"
         stroke-linecap="round" transform="rotate(${deg} 9 9)"/>`)
      .join("");
  const cloud = (x, y, fill) =>
    `<path d="M${x + 3} ${y + 9}a3.4 3.4 0 0 1 .4-6.8 5 5 0 0 1 9.4-1.2 3.6 3.6 0 0 1 .6 7.1z"
       transform="translate(${x - 1} ${y - 1})" fill="${fill}"/>`;
  const drops = (color) =>
    [7, 12, 17].map((x, i) =>
      `<line x1="${x}" y1="${18 + (i % 2)}" x2="${x - 1.6}" y2="${21.5 + (i % 2)}"
         stroke="${color}" stroke-width="1.8" stroke-linecap="round"/>`).join("");
  const flakes = (color) =>
    [7, 12, 17].map((x, i) =>
      `<circle cx="${x}" cy="${19.5 + (i % 2)}" r="1.3" fill="${color}"/>`).join("");

  const body = {
    clear: sun,
    partly: `<g transform="translate(3 -1) scale(0.72)">${sun}</g>${cloud(3, 7, "#C9DDF7")}`,
    cloudy: `${cloud(1, 4, "#DCE6F2")}${cloud(4, 7, "#C9DDF7")}`,
    fog: `${cloud(3, 4, "#D6DEE8")}` +
      [17, 20].map((y) => `<line x1="5" y1="${y}" x2="19" y2="${y}" stroke="#B7C2D0"
        stroke-width="1.6" stroke-linecap="round"/>`).join(""),
    rain: `${cloud(3, 4, "#C9DDF7")}${drops("#5B9BF8")}`,
    snow: `${cloud(3, 4, "#DCE6F2")}${flakes("#7FB4E8")}`,
    thunder: `${cloud(3, 4, "#B9CBE0")}<path d="M13 16.5l-4 5h3l-1.4 4 4.4-5.6h-3z" fill="#FFC53D"/>`,
  }[kind] || "";

  return `<svg class="weather-icon" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

// 맨 위 줄: 오늘 날짜 + 날씨
function renderToday() {
  const dateEl = document.getElementById("today-date");
  if (dateEl) {
    const d = new Date();
    const dow = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
    dateEl.textContent = `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${dow})`;
  }

  const wEl = document.getElementById("today-weather");
  if (!wEl) return;

  let w = todayWeatherLive;
  if (!w) {
    // 실시간 조회 실패 시 지점 캘린더가 준 그날의 날씨로 대체
    const fromBaris = (branchStatusSummary?.branches || []).map((b) => b.todayWeather).find(Boolean);
    if (fromBaris) w = { kind: BARIS_WEATHER_KIND[fromBaris] || "cloudy", label: fromBaris };
  }

  wEl.hidden = !w;
  if (!w) return;
  wEl.innerHTML =
    `${weatherIcon(w.kind)}<span class="weather-label">${escapeHtml(w.label)}</span>` +
    (Number.isFinite(w.temp) ? `<span class="weather-temp">${Math.round(w.temp)}°</span>` : "");
}

function renderBranchStatus() {
  renderToday();

  const card = document.getElementById("branch-status-card");
  if (!card) return;
  const s = branchStatusSummary;
  if (!s || s.total === 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  document.getElementById("status-total").textContent = `${formatNumber(s.total)}개`;
  document.getElementById("status-operating").textContent = formatNumber(s.operating);
  document.getElementById("status-idle").textContent = formatNumber(s.idle);

  // 지점 하나당 카드 하나 — 지점명 + 바리스 운영관리 페이지의 오늘 지표
  const bars = document.getElementById("status-bars");
  if (!bars) return;
  // 오늘 음료 제조 수량이 많은 지점부터. 수량이 아직 없는 지점은 뒤로.
  const ordered = [...(s.branches || [])].sort((a, b) => {
    const x = Number.isFinite(a.todayProduced) ? a.todayProduced : -1;
    const y = Number.isFinite(b.todayProduced) ? b.todayProduced : -1;
    return y - x || a.branchName.localeCompare(b.branchName, "ko");
  });
  bars.innerHTML = ordered.map((b) => {
    const cls = b.status === "OPERATING" ? "operating" : b.status === "NO_DATA" ? "nodata" : "idle";
    // 운영중은 카드 색으로 이미 드러나므로 글자로는 예외 상태만 적는다
    const label = b.status === "OPERATING" ? "" : b.status === "NO_DATA" ? "데이터 없음" : "미운영";
    return `
      <div class="branch-card ${cls}">
        ${sparkline(b.series)}
        <div class="branch-card-head">
          <span class="branch-card-name">${escapeHtml(shortStoreName(b.branchName))}</span>
          ${monthChangeMark(b.monthChange)}
          ${label ? `<span class="branch-card-status">${label}</span>` : ""}
        </div>
        <div class="branch-card-hero">
          <span class="branch-hero-value">${
            Number.isFinite(b.todayAmount) ? `${formatNumber(b.todayAmount)}<span class="branch-hero-unit">원</span>` : "-"
          }</span>
          <span class="branch-hero-label">오늘 매출</span>
        </div>
        <div class="branch-card-foot">${cardFootItems(b).join('<span class="branch-foot-dot">·</span>')}</div>
        <div class="branch-card-sale">${salePill(b)}</div>
      </div>`;
  }).join("");
}

/* 카드 아래 한 줄 — 오늘 주문·제조. 라벨이 길어 카드가 복잡해지므로
   "오늘"은 큰 숫자(오늘 매출)에서 한 번만 말하고 여기서는 짧은 말만 쓴다. */
function cardFootItems(b) {
  const items = [];
  if (Number.isFinite(b.todayOrders)) {
    items.push(`<span>주문 <b>${formatNumber(b.todayOrders)}</b>건</span>`);
  }
  if (Number.isFinite(b.todayProduced)) {
    items.push(`<span>제조 <b>${formatNumber(b.todayProduced)}</b>잔</span>`);
  }
  return items; // 값이 하나도 없으면 상태 칩("데이터 없음")만 남기고 비워 둔다
}

/* 판매 상태는 매장이 지금 돈을 벌 수 있는지를 좌우해서, 다른 지표와 섞지 않고
   알약 하나로 떼어 놓는다. 품절이 있으면 빨간 배경으로 바로 눈에 띄게 한다. */
function salePill(b) {
  if (!Number.isFinite(b.orderable) || !Number.isFinite(b.sellable)) return "";
  const soldout = b.sellable - b.orderable;
  if (soldout <= 0) {
    return `<span class="branch-sale">전 상품 판매중 <b>${formatNumber(b.sellable)}</b></span>`;
  }
  return `<span class="branch-sale short">품절 <b>${formatNumber(soldout)}</b>` +
    `<span class="branch-sale-sub">주문가능 ${formatNumber(b.orderable)}/${formatNumber(b.sellable)}</span></span>`;
}

/* 지난달 대비 매출 변화율 — 이번 달은 한 달 예상치로 환산해 비교한다 */
function monthChangeMark(pct) {
  if (!Number.isFinite(pct)) return "";
  const rounded = Math.round(pct);
  // 지점명 옆에 놓이므로 무엇 대비인지 글자로 밝힌다(이번 달은 한 달 예상치 기준)
  const title = "이번 달 예상 매출 ÷ 지난달 실제 매출 · 어제까지의 일평균으로 환산";
  const body = rounded === 0
    ? "±0%"
    : `${rounded > 0 ? "▲" : "▼"}${Math.abs(rounded)}%`;
  const dir = rounded === 0 ? "flat" : rounded > 0 ? "up" : "down";
  return `<span class="branch-month ${dir}" title="${title}">` +
    `<span class="branch-month-label">지난달 대비</span>${body}</span>`;
}

/* 카드 배경 스파크라인 — 최근 6개월 일별 매출.
   세 단계로 다듬는다.
     1) 14일 이동평균 : 요일 편차(주말 골)와 하루짜리 튐을 걷어낸다
     2) 40점으로 축약 : 180점을 300px 에 그리면 점 간격이 1.7px 라 미세 떨림이 남는다
     3) Catmull-Rom   : 남은 점을 부드러운 곡선으로 잇는다(꺾인 선 대신)
   세로축은 0이 아니라 데이터 최소~최대. 0 기준이면 20~30% 변동이 위쪽에 붙어
   직선처럼 보이기 때문. */
function sparkline(series) {
  const raw = (series || []).filter((v) => Number.isFinite(v));
  if (raw.length < 14) return "";
  const pts = downsample(movingAverage(raw, 14), 40);
  const max = Math.max(...pts);
  const min = Math.min(...pts);
  if (max <= 0) return "";
  const [lo, hi] = max > min ? [min, max] : [min - 1, min + 1]; // 완전 평평하면 가운데 선

  const stepX = 100 / (pts.length - 1);
  const xy = pts.map((v, i) => [i * stepX, 100 - ((v - lo) / (hi - lo)) * 100]);
  const line = smoothPath(xy);
  return `
    <svg class="branch-spark" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <path class="spark-area" d="${line} L 100 100 L 0 100 Z" />
      <path class="spark-line" d="${line}" />
    </svg>`;
}

// 구간 평균으로 점 개수를 줄인다(맨 끝 점은 살린다)
function downsample(values, target) {
  if (values.length <= target) return values;
  const size = values.length / target;
  return Array.from({ length: target }, (_, i) => {
    const slice = values.slice(Math.floor(i * size), Math.max(Math.floor((i + 1) * size), Math.floor(i * size) + 1));
    return slice.reduce((sum, v) => sum + v, 0) / slice.length;
  });
}

/* Catmull-Rom 스플라인을 3차 베지어로 옮긴 것.
   점을 모두 지나가면서 접선이 이어져, 꺾임 없이 매끄럽게 이어진다. */
function smoothPath(points) {
  if (points.length < 2) return "";
  const at = (i) => points[Math.min(Math.max(i, 0), points.length - 1)];
  let d = `M ${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1[0].toFixed(2)} ${c1[1].toFixed(2)}, ${c2[0].toFixed(2)} ${c2[1].toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d;
}

// 앞쪽 구간은 창이 모자라므로 있는 값까지만 평균낸다(길이 유지)
function movingAverage(values, window) {
  return values.map((_, i) => {
    const from = Math.max(0, i - window + 1);
    const slice = values.slice(from, i + 1);
    return slice.reduce((sum, v) => sum + v, 0) / slice.length;
  });
}

function renderKPI(startYM, endYM) {
  let totalRevenue = 0;
  let totalCustomers = 0;
  let totalTicketSum = 0;
  // 평균 월매출: 매출이 있는 매장의 "선택 기간 월평균 매출"을 매장 수로 나눈 값
  let avgMonthlyRevenueSum = 0;
  let revenueStoreCount = 0;

  state.stores.forEach((store) => {
    const m = getStoreMetrics(store, startYM, endYM);
    totalRevenue += m.totalRevenue;
    totalCustomers += m.customersFiltered;
    totalTicketSum += m.ticketSumFiltered;
    if (m.totalRevenue > 0) {
      avgMonthlyRevenueSum += m.avgMonthlyRevenueFiltered;
      revenueStoreCount++;
    }
  });

  // 선택 기간에 매출이 있는 매장만 분모로 (오픈 전 지점이 평균을 끌어내리지 않게)
  const avgStoreRevenue = revenueStoreCount > 0 ? avgMonthlyRevenueSum / revenueStoreCount : 0;

  document.getElementById("kpi-revenue").textContent = formatCurrency(totalRevenue);
  document.getElementById("kpi-avg-store-revenue").textContent = formatCurrency(avgStoreRevenue);
  document.getElementById("kpi-avg-daily-revenue").textContent = formatCurrency(avgStoreRevenue / 30);

  // 평균 객단가 = 바리스 월별 객단가의 객수 가중평균. 객수가 없으면 "-" 로 둔다.
  const ticketEl = document.getElementById("kpi-avg-ticket");
  const ticketSubEl = document.getElementById("kpi-avg-ticket-sub");
  if (totalCustomers > 0) {
    ticketEl.textContent = formatCurrency(totalTicketSum / totalCustomers);
    ticketSubEl.textContent = `선택 기간 · 객수 ${formatNumber(totalCustomers)}명`;
  } else {
    ticketEl.textContent = "-";
    ticketSubEl.textContent = "월별 실적에 객수를 입력하면 표시됩니다";
  }
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
 *  월별 매출 추이 (시간축 · 지점별)
 * ============================================================ */

/**
 * 진행 중인 이번 달 매출을 한 달치로 환산한 예상값.
 *   예상 = 현재까지 매출 / 경과 운영일 × 그 달 전체 운영일
 * 오픈월이면 오픈일부터를 한 달로 본다. 이미 끝난 달(또는 오늘이 말일)이면 null.
 */
function projectFullMonthRevenue(store, ym, revenueSoFar) {
  const today = todayISO();
  if (ym !== today.slice(0, 7) || !(revenueSoFar > 0)) return null;

  const openDay = store.openDate && store.openDate.slice(0, 7) === ym
    ? Number(store.openDate.slice(8, 10)) || 1
    : 1;
  const fullDays = Math.max(0, daysInYearMonth(ym) - openDay + 1);

  // 사용자가 이번 달 운영일수를 직접 넣었으면 그 값을 경과일로 본다
  const row = state.monthly.find((m) => m.storeId === store.id && m.yearMonth === ym);
  const entered = row && row.operatingDays != null && row.operatingDays !== "" ? Number(row.operatingDays) : null;
  const elapsed = Math.min(
    entered != null ? entered : Math.max(0, Number(today.slice(8, 10)) - openDay + 1),
    fullDays
  );

  if (elapsed <= 0 || fullDays <= elapsed) return null; // 달이 이미 다 찼으면 예상 = 실적
  return (revenueSoFar / elapsed) * fullDays;
}

function renderTrendChart(startYM, endYM) {
  const wrap = document.getElementById("chart-trend-wrap");
  if (!wrap) return;

  // 지점 × 월 매출 — 지점마다 하나의 추세선
  const revByStoreMonth = new Map(); // storeId -> Map(yearMonth -> revenue)
  const totalByStore = new Map();
  state.monthly.forEach((m) => {
    if (!inRange(m.yearMonth, startYM, endYM)) return;
    if (!state.stores.some((s) => s.id === m.storeId)) return;
    if (!revByStoreMonth.has(m.storeId)) revByStoreMonth.set(m.storeId, new Map());
    const byMonth = revByStoreMonth.get(m.storeId);
    byMonth.set(m.yearMonth, (byMonth.get(m.yearMonth) || 0) + (m.revenue || 0));
    totalByStore.set(m.storeId, (totalByStore.get(m.storeId) || 0) + (m.revenue || 0));
  });

  // 매출 비중 순 정렬 — 위쪽 "매출 비중" 차트와 색이 같아지도록 동일 기준
  const storeRows = state.stores
    .filter((s) => (totalByStore.get(s.id) || 0) > 0)
    .sort((a, b) => (totalByStore.get(b.id) || 0) - (totalByStore.get(a.id) || 0));

  // 상단 기간 선택 그대로를 시간축으로 사용(값 없는 달은 빈칸으로 둠)
  const months = monthsRange(startYM, endYM);
  const singleYear = startYM.slice(0, 4) === endYM.slice(0, 4);

  const periodEl = document.getElementById("chart-trend-period");
  const setPeriodText = (note) => {
    if (!periodEl) return;
    periodEl.textContent = state.stores.length === 0 ? "" : `지점별 매출 · ${startYM} ~ ${endYM}${note}`;
  };
  setPeriodText("");

  if (storeRows.length === 0) {
    if (trendChart) { trendChart.destroy(); trendChart = null; }
    wrap.style.height = "";
    wrap.innerHTML = '<div class="empty-state">선택 기간에 매출 데이터가 없습니다.</div>';
    return;
  }

  if (!document.getElementById("chart-trend")) {
    wrap.innerHTML = '<canvas id="chart-trend"></canvas>';
  }
  const ctx = document.getElementById("chart-trend");
  // 선 영역 + x축 + 범례(지점 4개당 한 줄) 높이
  wrap.style.height = `${260 + Math.ceil(storeRows.length / 4) * 24}px`;

  // 단일 연도면 "1월"~"12월", 여러 해에 걸치면 "2025-01" 형태
  const labels = months.map((ym) => (singleYear ? `${Number(ym.slice(5, 7))}월` : ym));
  // 값이 없는 달은 null → 점을 찍지 않고 선을 끊어 둔다(spanGaps: false)
  const datasets = storeRows.map((store, i) => {
    const byMonth = revByStoreMonth.get(store.id) || new Map();
    const color = CHART_PALETTE[i % CHART_PALETTE.length];
    return {
      label: shortStoreName(store.name),
      data: months.map((ym) => (byMonth.has(ym) ? byMonth.get(ym) : null)),
      borderColor: color,
      backgroundColor: color,
      pointBackgroundColor: color,
      pointBorderColor: "#ffffff",
      pointBorderWidth: 2,
      borderWidth: 2.5,
      pointRadius: 4,
      pointHoverRadius: 6,
      tension: 0.3, // 살짝만 부드럽게 — 실제 값에서 크게 벗어나지 않는 정도
      spanGaps: false,
      fill: false,
    };
  });

  // 진행 중인 이번 달 — 직전 달 실적에서 이어지는 점선으로 "한 달 환산" 예상치를 덧그린다
  const projIdx = months.indexOf(todayISO().slice(0, 7));
  const projections = storeRows.map((store, i) =>
    projIdx < 0 ? null : projectFullMonthRevenue(store, months[projIdx], datasets[i].data[projIdx])
  );
  const hasProjection = projections.some((v) => v != null);

  const projDatasets = !hasProjection ? [] : storeRows.map((store, i) => {
    const color = CHART_PALETTE[i % CHART_PALETTE.length];
    const data = months.map(() => null);
    if (projections[i] != null) {
      if (projIdx > 0) data[projIdx - 1] = datasets[i].data[projIdx - 1]; // 직전 달에서 출발
      data[projIdx] = projections[i];
    }
    return {
      label: `${shortStoreName(store.name)} (예상)`,
      data,
      borderColor: color,
      backgroundColor: color,
      pointBackgroundColor: "#ffffff",
      pointBorderColor: color,
      pointBorderWidth: 2,
      borderWidth: 2,
      borderDash: [5, 4],
      pointRadius: (c) => (c.dataIndex === projIdx ? 4 : 0),
      pointHoverRadius: (c) => (c.dataIndex === projIdx ? 6 : 0),
      tension: 0,
      spanGaps: false,
      fill: false,
      isProjection: true,
    };
  });

  if (hasProjection) {
    const projLabel = singleYear ? `${Number(months[projIdx].slice(5, 7))}월` : months[projIdx];
    setPeriodText(` · 점선은 ${projLabel} 예상(한 달 환산)`);
  }

  // 월 합계는 툴팁 하단에만 쓴다(선은 지점별 값 그대로 그린다) — 실적 기준
  const monthTotals = months.map((ym, mi) =>
    datasets.reduce((s, ds) => s + (ds.data[mi] || 0), 0)
  );
  const projTotal = projections.reduce((s, v, i) => s + (v != null ? v : (projIdx >= 0 ? datasets[i].data[projIdx] || 0 : 0)), 0);
  // y축 단위를 하나로 통일(억 또는 만) — 억/만이 섞여 보이지 않게
  const maxAbs = Math.max(
    0,
    ...datasets.flatMap((ds) => ds.data.filter((v) => v != null).map(Math.abs)),
    ...projections.filter((v) => v != null)
  );
  const axisUnit = maxAbs >= 1e8 ? 1e8 : maxAbs >= 1e4 ? 1e4 : 1;
  const formatAxis = (v) => {
    if (v === 0) return "0";
    if (axisUnit === 1e8) return `${(v / 1e8).toFixed(1)}억`;
    if (axisUnit === 1e4) return `${Math.round(v / 1e4).toLocaleString("ko-KR")}만`;
    return Math.round(v).toLocaleString("ko-KR");
  };

  const data = { labels, datasets: [...datasets, ...projDatasets] };

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
        grid: { color: "#eceef2" },
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
          padding: 14,
          // 예상선은 실선과 같은 지점이므로 범례에 따로 두지 않는다
          filter: (item, chartData) => !chartData.datasets[item.datasetIndex]?.isProjection,
        },
        // 지점 하나를 끄면 그 지점의 실선과 예상 점선이 함께 꺼진다
        onClick: (e, item, legend) => {
          const ch = legend.chart;
          const storeCount = ch.data.datasets.filter((d) => !d.isProjection).length;
          [item.datasetIndex, item.datasetIndex + storeCount].forEach((di) => {
            if (ch.data.datasets[di]) ch.setDatasetVisibility(di, !ch.isDatasetVisible(di));
          });
          ch.update();
        },
      },
      tooltip: {
        backgroundColor: "#343a46",
        titleColor: "#ffffff",
        bodyColor: "#ffffff",
        footerColor: "#ffffff",
        borderColor: "#343a46",
        borderWidth: 1,
        padding: 10,
        // 예상선은 출발점(직전 달)에도 값이 있으므로 예상 달에서만 보여준다
        filter: (item) => item.parsed.y != null && (!item.dataset.isProjection || item.dataIndex === projIdx),
        callbacks: {
          label: (c) => `${c.dataset.label}: ${formatCurrency(c.parsed.y)}`,
          footer: (items) => {
            if (items.length === 0) return "";
            const i = items[0].dataIndex;
            const lines = [`합계: ${formatCurrency(monthTotals[i] || 0)}`];
            if (hasProjection && i === projIdx) lines.push(`예상 합계: ${formatCurrency(projTotal)}`);
            return lines.join("\n");
          },
        },
      },
    },
  };

  if (trendChart && trendChart.canvas === ctx) {
    trendChart.data = data;
    trendChart.options = options;
    trendChart.update();
  } else {
    if (trendChart) trendChart.destroy();
    trendChart = new Chart(ctx, { type: "line", data, options });
  }
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
      // 일평균은 월평균을 30으로 나눈 값이라 정렬 순서는 같지만, 컬럼별 정렬 상태 표시를 위해 따로 둔다
      case "avgDailyRevenue": av = a.avgMonthlyRevenue; bv = b.avgMonthlyRevenue; break;
      case "cumulativeCustomers": av = a.customersAll; bv = b.customersAll; break;
      case "avgTicket": av = a.avgTicket; bv = b.avgTicket; break;
      case "appRatio": av = payChannelSplit(branchPayTypes(a.store))?.appPct ?? -1;
                       bv = payChannelSplit(branchPayTypes(b.store))?.appPct ?? -1; break;
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
  { label: "월평균 매출", sort: "avgRevenue", center: true },
  { label: "일평균 매출", sort: "avgDailyRevenue", center: true, title: "누적 매출 ÷ 운영일자 (VAT 별도)" },
  { label: "평균 일누적 방문객", sort: "cumulativeCustomers", center: true, title: "오픈 이후 누적 객수 (객수가 입력된 달 기준)" },
  { label: "평균 객단가", sort: "avgTicket", center: true, title: "바리스 매출 캘린더의 평균 객단가 · 객수 가중평균" },
  { label: "앱 결제비율", sort: "appRatio", center: true, title: "누적 결제 건수 중 앱 결제 비중 · 결제수단이 \"앱 …\"(앱 X-pay·앱 신용카드 등)이면 앱, 나머지는 현장" },
];

/* 지점 상세(로컬 매출 데이터)와 바리스 실시간 상태를 잇는다.
   두 데이터가 서로 다른 API에서 와 지점ID 체계가 다를 수 있어, 이름으로도 맞춰 본다.
   공백·괄호·접두어 차이로 어긋나는 경우가 많아 이름은 정규화해 비교한다. */
const normalizeBranchName = (name) =>
  String(name || "").replace(/[\s()\-–—_·]/g, "").toLowerCase();

function branchPayTypes(store) {
  const list = branchStatusSummary?.branches || [];
  const key = normalizeBranchName(store.name);
  const hit =
    list.find((b) => b.branchId && b.branchId === store.id) ||
    list.find((b) => normalizeBranchName(b.branchName) === key);
  return hit?.payTypes;
}

// 앱 결제 비중 — 나머지는 현장(키오스크) 결제
function channelCell(split) {
  if (!split) return "-";
  return `<span class="channel-app">${Math.round(split.appPct)}%</span>`;
}

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

function renderStoreTable(startYM, endYM) {
  renderStoreHead();
  const tbody = document.getElementById("store-tbody");
  const tfoot = document.getElementById("store-tfoot");

  if (state.stores.length === 0) {
    tbody.innerHTML =
      `<tr><td colspan="${STORE_COLUMNS.length}" class="empty-state">아직 등록된 지점이 없습니다. 우측 상단 "업데이트"로 바리스에서 가져오세요.</td></tr>`;
    tfoot.innerHTML = "";
    updateSortHeaders();
    return;
  }

  const rows = getSortedStoreRows(startYM, endYM);

  tbody.innerHTML = rows.map(({ store, ...m }) => `
    <tr data-store-id="${store.id}">
      <td>${escapeHtml(store.name)}</td>
      <td class="num center cell-readonly">${formatCurrency(m.avgMonthlyRevenue * 0.9)}</td>
      <td class="num center cell-readonly">${formatCurrency(m.avgMonthlyRevenue * 0.9 / 30)}</td>
      <td class="num center cell-readonly">${m.customersAll > 0 ? `${formatNumber(m.customersAll)}명` : "-"}</td>
      <td class="num center cell-readonly">${m.avgTicket > 0 ? formatCurrency(m.avgTicket) : "-"}</td>
      <td class="num center cell-readonly">${channelCell(payChannelSplit(branchPayTypes(store)))}</td>
    </tr>
  `).join("");

  // 마지막 행은 합계가 아니라 "매장 평균" — 각 열의 지점 값을 평균낸다.
  // 값이 없는 지점(매출 0, 객수 미입력)은 평균을 끌어내리지 않게 분모에서 뺀다.
  const meanOf = (pick) => {
    const vals = rows.map(pick).filter((v) => v > 0);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };
  const meanRevenue = meanOf((r) => r.avgMonthlyRevenue);
  const meanTicket = meanOf((r) => r.avgTicket);
  const meanCustomers = meanOf((r) => r.customersAll);

  tfoot.innerHTML = `
    <tr>
      <td>매장 평균</td>
      <td class="num center">${formatCurrency(meanRevenue * 0.9)}</td>
      <td class="num center">${formatCurrency(meanRevenue * 0.9 / 30)}</td>
      <td class="num center">${meanCustomers > 0 ? `${formatNumber(Math.round(meanCustomers))}명` : "-"}</td>
      <td class="num center">${meanTicket > 0 ? formatCurrency(meanTicket) : "-"}</td>
      <td class="num center">${channelCell(payChannelSplit(
        rows.flatMap((r) => branchPayTypes(r.store) || [])
      ))}</td>
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

// 해당 연월의 달력상 일수 (예: 2026-04 → 30)
function daysInYearMonth(ym) {
  const [y, mo] = ym.split("-").map(Number);
  return new Date(y, mo, 0).getDate();
}

/* ============================================================
 *  CRUD
 * ============================================================ */
function toggleStoreType(id) {
  const store = state.stores.find((s) => s.id === id);
  if (!store) return;
  const current = getStoreType(store);
  store.type = current === STORE_TYPE_DIRECT ? STORE_TYPE_OWNER : STORE_TYPE_DIRECT;
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
 * 한 달치 매출 + 객수 조회 (바리스 매출 캘린더 화면과 같은 소스).
 *  매출
 *   - 과거 월: tot_sell_month_predict (예상매출).
 *     : 0매출 일자를 비-0 일평균으로 채워 추정. 월 중간 오픈 케이스 처리.
 *   - 현재(진행 중)/미래 월: tot_sell_month - tot_refund_month (실제 누적).
 *     : 며칠 안 지난 시점에서의 과대 추정 방지.
 *  객수: tot_order_cnt (그 달 주문건수), 객단가: avg_cust_tran (그 달 평균 객단가).
 *   ↳ 바리스 매출 캘린더의 "주문건수 (평균 객단가)" 그대로. 객단가는 바리스 실매출 기준이라
 *     우리 매출(과거 월은 예상매출)로 나눈 값보다 정확해서 받아온 값을 그대로 쓴다.
 */
async function barisFetchMonthSales(branchID, ym, token) {
  const yyyymm = ym.replace("-", "");
  const j = await barisGet(`/analysis/sales/calendar/${branchID}/${yyyymm}`, token);
  const p = j?.payload || {};
  const actual = Number(p.tot_sell_month || 0);
  const refund = Number(p.tot_refund_month || 0);
  const predict = Number(p.tot_sell_month_predict || 0);

  const revenue = !isMonthInProgressOrFuture(ym) && predict > 0
    ? predict
    : Math.max(0, actual - refund);

  return {
    revenue,
    customers: Math.max(0, Math.round(Number(p.tot_order_cnt) || 0)),
    avgTicket: Math.max(0, Number(p.avg_cust_tran) || 0),
  };
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

/**
 * 지점 운영 현황 (바리스 홈의 "전체 N대 / 운영중 / 미운영" 과 같은 소스).
 * GET /home/robots/overview/detail → payload.list[{branch_id, branch_name, status}]
 */
async function barisFetchBranchStatus(token) {
  const j = await barisGet(
    "/home/robots/overview/detail?page=1&take=100&orderField=branch_name&order=ASC",
    token
  );
  const p = j?.payload || {};
  const list = Array.isArray(p.list) ? p.list : Array.isArray(p.items) ? p.items : [];
  return list.map((x) => ({
    // 바리스 응답에 brnach_id 오타 키가 섞여 있어 둘 다 받는다
    branchId: x.branch_id || x.brnach_id || "",
    branchName: x.branch_name || "",
    status: x.status || "NO_DATA",
    totalRate: Number(x.total_rate) || 0,
    runTime: Number(x.run_time) || 0,   // 분
    downTime: Number(x.down_time) || 0, // 분
  }));
}

/**
 * 지점 한 곳의 오늘 실적 + 상품 수 (바리스 "운영관리" 페이지와 같은 소스).
 * GET /manage/dashboard/main/{branchID}
 *   payload.payment       : today_payment(주문건수) / today_produce(제조수량) / today_amount(결제금액)
 *   payload.product_count : orderable(주문가능) / total_sellable(판매상품)
 *
 * 호출 전에 해당 지점으로 전환된 토큰을 넘겨야 한다(refreshBranchStatus 참고).
 */
async function barisFetchBranchDashboard(branchID, token) {
  const payload = (await barisGet(`/manage/dashboard/main/${branchID}`, token))?.payload;
  const pay = payload?.payment || {};
  const prod = payload?.product_count || {};
  return {
    todayOrders: toFiniteNumber(pay.today_payment),
    todayProduced: toFiniteNumber(pay.today_produce),
    todayAmount: toFiniteNumber(pay.today_amount),
    orderable: toFiniteNumber(prod.orderable),
    sellable: toFiniteNumber(prod.total_sellable),
  };
}

// 숫자로 못 읽히면 undefined — 카드에서 "-" 로 표시된다
function toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 지점 한 곳의 최근 6개월 일별 실적 (바리스 매출 캘린더와 같은 소스).
 * GET /analysis/sales/calendar/{branchID}/{YYYYMM}
 *   payload.data[{ date: "YYYYMMDD", tot_sell_today, tot_refund_today, weather }]
 *
 * 여섯 달치를 이어 붙여 카드 배경 스파크라인을 그리고, "지난달 대비"는 지난달·이번 달만 쓴다.
 */
async function barisFetchDailySeries(branchID, token) {
  const now = new Date();
  const ymKey = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}`;
  // 이번 달 포함 최근 6개월 (오래된 달 → 최근 달 순)
  const months = [5, 4, 3, 2, 1, 0].map((back) => new Date(now.getFullYear(), now.getMonth() - back, 1));

  const byMonth = await Promise.all(months.map((d) => barisFetchMonthDays(branchID, ymKey(d), token)));
  const last = byMonth[byMonth.length - 2] || [];
  const cur = byMonth[byMonth.length - 1] || [];
  const all = byMonth.flat();

  const todayKey = `${ymKey(now)}${pad(now.getDate())}`;
  return {
    series: all.map((r) => r.sales),
    monthChange: monthOverMonthChange(last, cur, now),
    todayWeather: cur.find((r) => r.date === todayKey)?.weather || undefined,
  };
}

async function barisFetchMonthDays(branchID, yyyymm, token) {
  const j = await barisGet(`/analysis/sales/calendar/${branchID}/${yyyymm}`, token);
  return (j?.payload?.data || [])
    .map((r) => ({
      date: String(r.date),
      // 매출은 환불을 뺀 순매출 (지점 상세의 월 매출과 같은 기준)
      sales: Math.max(0, (toFiniteNumber(r.tot_sell_today) ?? 0) - (toFiniteNumber(r.tot_refund_today) ?? 0)),
      weather: r.weather || "",
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 지난달 대비 매출 변화율(%).
 *
 * 이번 달은 아직 진행 중이라 총합끼리 바로 비교하면 매달 초에 -80% 씩 나온다.
 * 그래서 어제까지의 하루 평균 매출로 이번 달 전체를 추정해 지난달 실제 매출과 비교한다.
 *   예상 이번 달 = (어제까지 매출 합 ÷ 지난 일수) × 이번 달 총 일수
 *   변화율 = (예상 이번 달 − 지난달 실제) ÷ 지난달 실제
 * 오늘은 아직 안 끝났으므로 평균 계산에서 제외한다. 1일이면 표시하지 않는다.
 */
function monthOverMonthChange(lastDays, curDays, now) {
  const todayKey = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const done = curDays.filter((r) => r.date < todayKey);
  if (lastDays.length === 0 || done.length === 0) return undefined;

  const sum = (rows) => rows.reduce((acc, r) => acc + r.sales, 0);
  const lastTotal = sum(lastDays);
  if (lastTotal <= 0) return undefined;

  const daysThisMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projected = (sum(done) / done.length) * daysThisMonth;
  return ((projected - lastTotal) / lastTotal) * 100;
}

/**
 * 지점 한 곳의 누적 결제수단 구성 (바리스 매출분석 화면과 같은 소스).
 * GET /analysis/sales/graph/{branchID}?tab_cd=ALL
 *   payload.sales_pay_type[{ pay_type: "카드결제"…, count, tot_sell_amt }]
 *
 * 바리스는 주문 경로(앱/현장)를 따로 주지 않아 결제수단으로 갈음한다.
 * 어떤 수단이 앱 결제인지는 실제 응답 문자열을 보고 확정해야 하므로,
 * 여기서는 받은 그대로 보여주고 문자열을 콘솔에 남긴다.
 */
async function barisFetchPayTypes(branchID, token) {
  const j = await barisGet(`/analysis/sales/graph/${branchID}?tab_cd=ALL`, token);
  const list = Array.isArray(j?.payload?.sales_pay_type) ? j.payload.sales_pay_type : [];
  const payTypes = list
    .map((r) => ({
      name: String(r.pay_type || "").trim(),
      count: toFiniteNumber(r.count) ?? 0,
      amount: toFiniteNumber(r.tot_sell_amt) ?? 0,
    }))
    .filter((r) => r.name && r.count > 0)
    .sort((a, b) => b.count - a.count);
  return { payTypes };
}

/* 결제수단 문자열 → 앱 / 현장(키오스크).
   바리스는 앱 결제를 "앱 X-pay", "앱 기타결제", "앱 신용카드" 처럼 "앱" 을 붙여 구분한다.
   그래서 이름에 "앱" 이 있으면 앱, 나머지("신용카드" 등)는 현장으로 본다.
   ※ 카드/현금 같은 수단명을 먼저 보면 "앱 신용카드" 가 현장으로 새므로 앱을 먼저 판정한다. */
const APP_PAY = /앱/;
// 매출로 볼 수 없는 건들(재제조·무료·시연·테스트)은 비율에서 뺀다
const EXCLUDED_PAY = /재제조|무료|시연|테스트|면접|디버그/;

function payChannelSplit(payTypes) {
  if (!Array.isArray(payTypes) || payTypes.length === 0) return null;
  let onsite = 0, app = 0;
  for (const p of payTypes) {
    if (EXCLUDED_PAY.test(p.name)) continue;
    if (APP_PAY.test(p.name)) app += p.count;
    else onsite += p.count;
  }
  const total = onsite + app;
  if (total === 0) return null;
  return { onsite, app, onsitePct: (onsite / total) * 100, appPct: (app / total) * 100 };
}

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
        const { revenue, customers, avgTicket } = await barisFetchMonthSales(b.branchID, ym, branchToken);
        return { ym, revenue, customers, avgTicket };
      } catch {
        return { ym, revenue: 0, customers: 0, avgTicket: 0 };
      } finally {
        done++;
        if (done % 5 === 0 || done === total) {
          onProgress?.(`매출 조회 중... ${done}/${total}`);
        }
      }
    });

    let firstYM = null;
    const monthly = [];
    for (const { ym, revenue, customers, avgTicket } of monthResults) {
      if (revenue > 0) {
        if (!firstYM || ym < firstYM) firstYM = ym;
        monthly.push({ storeId: b.branchID, yearMonth: ym, revenue, customers, avgTicket, investorPayout: 0 });
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
  const incomingByYM = new Map(monthly.map((m) => [m.yearMonth, m]));
  // 기존 항목 업데이트
  for (const m of state.monthly) {
    if (m.storeId === branchID && incomingByYM.has(m.yearMonth)) {
      const incoming = incomingByYM.get(m.yearMonth);
      m.revenue = incoming.revenue;
      // 객수·객단가는 바리스에서 받아온 값이 있을 때만 덮어쓴다(수기 입력 보존)
      if (incoming.customers > 0) m.customers = incoming.customers;
      if (incoming.avgTicket > 0) m.avgTicket = incoming.avgTicket;
      incomingByYM.delete(m.yearMonth);
    }
  }
  // 신규 월 추가
  for (const [ym, incoming] of incomingByYM) {
    state.monthly.push({
      storeId: branchID,
      yearMonth: ym,
      revenue: incoming.revenue,
      customers: incoming.customers,
      avgTicket: incoming.avgTicket,
      investorPayout: 0,
    });
  }
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

    refreshBranchStatus();

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
      refreshBranchStatus();
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
  });

  // 타입 토글 위임
  document.body.addEventListener("click", (e) => {
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
// 데이터가 통째로 바뀐 뒤(클라우드 반영 등) 필터를 보정하고 다시 그림
function refreshAfterDataChange() {
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

  initFilters();
  bindEvents();
  renderToday();   // 날짜는 로그인 전에도 바로 보인다
  refreshWeather(); // 날씨는 로그인과 무관하게 바로 받는다
  renderAll();

  // 클라우드 공유 데이터를 불러와(최근 저장본 우선) 모든 기기에서 공통 표시
  refreshBranchStatus();

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
