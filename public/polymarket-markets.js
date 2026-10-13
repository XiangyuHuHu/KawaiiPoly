const predictionTabs = document.querySelector('#predictionTabs');
const predictionWhy = document.querySelector('#predictionWhy');
const predictionBoard = document.querySelector('#predictionBoard');
const perpsTabs = document.querySelector('#perpsTabs');
const perpsReason = document.querySelector('#perpsReason');
const perpsBoard = document.querySelector('#perpsBoard');
const boardStatus = document.querySelector('#boardStatus');

const PERP_LABELS = {
  all: '全部',
  crypto: '加密',
  equity: '股票',
  index: '指数',
  commodity: '商品'
};

let selectedCategory = 'sports';
let selectedPerp = 'all';
let catalog = null;
let perps = null;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: number >= 1000 ? 0 : 2 }).format(number);
}

function compact(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(number);
}

function cents(price) {
  const number = Number(price);
  if (!Number.isFinite(number)) return '--';
  return `${(number * 100).toFixed(1)}¢`;
}

function percent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  const text = `${number >= 0 ? '+' : ''}${(number * 100).toFixed(2)}%`;
  return `<span class="${number >= 0 ? 'board-up' : 'board-down'}">${text}</span>`;
}

function when(iso) {
  if (!iso) return '--';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function tradableLabel(value) {
  if (value === 'paper') return '模拟买入';
  return '只观察';
}

function syncTabs(container, items, selected, attr) {
  const signature = items.map((item) => item.id).join('|');
  if (container.dataset.signature !== signature) {
    container.dataset.signature = signature;
    container.innerHTML = items.map((item) => `
      <button type="button" class="pm-tab" ${attr}="${esc(item.id)}">${esc(item.label)}</button>
    `).join('');
  }
  for (const button of container.querySelectorAll(`[${attr}]`)) {
    const on = button.getAttribute(attr) === selected;
    button.classList.toggle('active', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

function renderPrediction() {
  const categories = catalog?.categories || [];
  syncTabs(predictionTabs, categories, selectedCategory, 'data-category');
  const board = (catalog?.boards || []).find((item) => item.id === selectedCategory);
  predictionWhy.textContent = board?.why || '';
  if (!board) {
    predictionBoard.innerHTML = '<div class="board-empty">这一类还没有数据。</div>';
    return;
  }
  if (board.error && !board.events.length) {
    predictionBoard.innerHTML = `<div class="board-empty">${esc(board.error)}</div>`;
    return;
  }
  if (!board.events.length) {
    predictionBoard.innerHTML = '<div class="board-empty">当前没有活跃事件。</div>';
    return;
  }
  predictionBoard.innerHTML = `
    <table class="board-table">
      <thead><tr><th>事件</th><th>领先结果</th><th>24h 成交</th><th>截止</th><th></th></tr></thead>
      <tbody>
        ${board.events.map((event) => `
          <tr>
            <td><a href="${esc(event.url)}" target="_blank" rel="noreferrer">${esc(event.title)}</a><div class="board-muted">${event.marketCount} 个市场</div></td>
            <td>${event.leader ? `${esc(event.leader.outcome)} <span class="board-pill">${cents(event.leader.price)}</span><div class="board-muted">${esc(event.leader.question)}</div>` : '--'}</td>
            <td>${compact(event.volume24hr)}</td>
            <td>${when(event.endDate)}</td>
            <td><span class="board-pill">${tradableLabel(board.tradable)}</span></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderPerps() {
  const categories = Object.keys(perps?.categories || {});
  const tabs = ['all', ...categories].map((id) => ({ id, label: PERP_LABELS[id] || id }));
  syncTabs(perpsTabs, tabs, selectedPerp, 'data-perp');
  if (perps?.reason) perpsReason.textContent = perps.reason;
  if (perps?.error && !(perps.rows || []).length) {
    perpsBoard.innerHTML = `<div class="board-empty">${esc(perps.error)}</div>`;
    return;
  }
  const rows = (perps?.rows || []).filter((row) => selectedPerp === 'all' || row.category === selectedPerp).slice(0, 40);
  if (!rows.length) {
    perpsBoard.innerHTML = '<div class="board-empty">这一类还没有合约。</div>';
    return;
  }
  perpsBoard.innerHTML = `
    <table class="board-table">
      <thead><tr><th>合约</th><th>标记价</th><th>24h</th><th>资金费</th><th>持仓量</th><th>杠杆</th></tr></thead>
      <tbody>
        ${rows.map((row) => `
          <tr>
            <td>${esc(row.symbol)}<div class="board-muted">${esc(PERP_LABELS[row.category] || row.category)}${row.closeOnly ? ' · 只减仓' : ''}</div></td>
            <td>${money(row.markPrice)}</td>
            <td>${percent(row.change24h)}</td>
            <td>${percent(row.fundingRate)}<div class="board-muted">${esc(row.fundingInterval || '')}</div></td>
            <td>${compact(row.openInterest)}</td>
            <td>${row.maxLeverage ? `${row.maxLeverage}x` : '--'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

predictionTabs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-category]');
  if (!button) return;
  selectedCategory = button.dataset.category;
  renderPrediction();
});

perpsTabs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-perp]');
  if (!button) return;
  selectedPerp = button.dataset.perp;
  renderPerps();
});

async function refresh() {
  const [catalogResult, perpsResult] = await Promise.allSettled([
    fetch('/api/polymarket/catalog').then((response) => response.json()),
    fetch('/api/polymarket/perps').then((response) => response.json())
  ]);
  if (catalogResult.status === 'fulfilled') catalog = catalogResult.value;
  if (perpsResult.status === 'fulfilled') perps = perpsResult.value;
  const catalogCount = (catalog?.boards || []).reduce((sum, board) => sum + (board.count || 0), 0);
  const perpCount = perps?.count || 0;
  const problems = [catalog?.error, perps?.error].filter(Boolean);
  boardStatus.textContent = problems.length && !catalogCount && !perpCount
    ? problems[0]
    : `事件 ${catalogCount} · 永续 ${perpCount}${perps?.tradable ? '' : ' · 永续未接实盘'}`;
  renderPrediction();
  renderPerps();
}

refresh();
setInterval(refresh, 20000);
