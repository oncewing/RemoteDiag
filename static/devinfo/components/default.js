/**
 * 디바이스 정보 — 기본 컴포넌트
 *
 * 섹션: 단말 식별 정보 / 모뎀 정보 / 네트워크 / DNS / 메모리 / 프로세스
 */

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _renderDnsmasqConf(raw) {
  const parsed = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t.startsWith('dhcp-range=')) {
      const parts = t.slice('dhcp-range='.length).split(',');
      if (parts.length >= 4) {
        const hasIface = isNaN(parts[0].charAt(0));
        if (hasIface) {
          [parsed.dhcpIface, parsed.dhcpStart, parsed.dhcpEnd, parsed.dhcpMask, parsed.dhcpLease]
            = [parts[0], parts[1], parts[2], parts[3], parts[4] || ''];
        } else {
          [parsed.dhcpStart, parsed.dhcpEnd, parsed.dhcpMask, parsed.dhcpLease]
            = [parts[0], parts[1], parts[2], parts[3]];
        }
      }
    } else if (t.startsWith('dhcp-option-force=6,')) {
      parsed.dns = t.slice('dhcp-option-force=6,'.length).trim();
    } else if (t.startsWith('dhcp-option-force=26,')) {
      parsed.mtu = t.slice('dhcp-option-force=26,'.length).trim();
    }
  }
  function fmtLease(s) {
    const n = parseInt(s, 10);
    if (isNaN(n)) return s;
    if (n >= 86400) return `${Math.round(n / 86400)}일 (${n}초)`;
    if (n >= 3600)  return `${Math.round(n / 3600)}시간 (${n}초)`;
    if (n >= 60)    return `${Math.round(n / 60)}분 (${n}초)`;
    return `${n}초`;
  }
  function row(label, value) {
    return `<tr><td class="dns-label">${label}</td><td class="dns-value">${_esc(value)}</td></tr>`;
  }
  const rows = [];
  if (parsed.dhcpStart) rows.push(row('IP 범위', `${parsed.dhcpStart} ~ ${parsed.dhcpEnd}`));
  if (parsed.dhcpMask)  rows.push(row('서브넷 마스크', parsed.dhcpMask));
  if (parsed.dhcpLease) rows.push(row('임대 시간', fmtLease(parsed.dhcpLease)));
  if (parsed.dns)       rows.push(row('DNS 서버', parsed.dns));
  const summary = rows.length
    ? `<table class="dns-table">${rows.join('')}</table>`
    : '<span class="dim-text">파싱 가능한 항목 없음</span>';
  return `<div class="dns-summary">${summary}</div>`;
}

// ── 섹션 정의 ─────────────────────────────────────────────────────────
// { id, title, load(ctx) → Promise }
function _sections(ctx) {
  return [
    {
      id: 'devid', title: '단말 식별 정보',
      async load(c) {
        _setContent(c, 'devid', '<span class="dim-text">읽는 중...</span>');
        const [mRes, cRes] = await Promise.all([
          ctx.shellCmd('cat /sys/devices/soc0/wnet_model', 5),
          ctx.shellCmd('cat /sys/devices/soc0/wnet_customer', 5),
        ]);
        const model    = (mRes.stdout || '').trim() || '—';
        const customer = (cRes.stdout || '').trim() || '—';
        _setContent(c, 'devid',
          `<table class="dns-table">
             <tr><td class="dns-label">모델명</td>
                 <td class="dns-value">${_esc(model)}</td></tr>
             <tr><td class="dns-label">고객사 (내부)</td>
                 <td class="dns-value">${_esc(customer)}</td></tr>
           </table>`
        );
      },
    },
    {
      id: 'at', title: '모뎀 정보',
      async load(c) {
        _setContent(c, 'at', '<span class="dim-text">읽는 중...</span>');
        const lines = [];
        const r1 = await ctx.atCmd('AT$$DBS', 10);
        lines.push('▶ AT$$DBS');
        lines.push(r1.response || r1.error || '(응답 없음)');
        lines.push('');
        const r2 = await ctx.atCmd('AT+CGDCONT?', 10);
        lines.push('▶ AT+CGDCONT?');
        lines.push(r2.response || r2.error || '(응답 없음)');
        _setText(c, 'at', lines.join('\n'));
      },
    },
    {
      id: 'ifconfig', title: '네트워크',
      async load(c) {
        _setContent(c, 'ifconfig', '<span class="dim-text">읽는 중...</span>');
        const r = await ctx.shellCmd('ifconfig', 30);
        r.success && r.stdout
          ? _setText(c, 'ifconfig', r.stdout)
          : _setContent(c, 'ifconfig', `<span class="t-err">${_esc(r.stderr || r.error || '오류')}</span>`);
      },
    },
    {
      id: 'dns', title: 'DNS/DHCP 정보',
      async load(c) {
        _setContent(c, 'dns', '<span class="dim-text">읽는 중...</span>');
        const r = await ctx.shellCmd('cat /var/run/data/dnsmasq.conf.bridge0', 30);
        if (!r.success) {
          _setContent(c, 'dns', `<span class="t-err">${_esc(r.error || '오류')}</span>`);
          return;
        }
        _setContent(c, 'dns', _renderDnsmasqConf((r.stdout || '') + (r.stderr ? '\n' + r.stderr : '')));
      },
    },
    {
      id: 'mem', title: '메모리 정보',
      async load(c) {
        _setContent(c, 'mem', '<span class="dim-text">읽는 중...</span>');
        const r = await ctx.shellCmd('cat /proc/meminfo', 30);
        r.success && r.stdout
          ? _setText(c, 'mem', r.stdout)
          : _setContent(c, 'mem', `<span class="t-err">${_esc(r.stderr || r.error || '오류')}</span>`);
      },
    },
    {
      id: 'ps', title: '프로세스 정보',
      async load(c) {
        _setContent(c, 'ps', '<span class="dim-text">읽는 중...</span>');
        const r = await ctx.shellCmd('ps', 30);
        r.success && r.stdout
          ? _setText(c, 'ps', r.stdout)
          : _setContent(c, 'ps', `<span class="t-err">${_esc(r.stderr || r.error || '오류')}</span>`);
      },
    },
  ];
}

// ── DOM 헬퍼 ──────────────────────────────────────────────────────────
function _setContent(container, secId, html) {
  const el = container.querySelector(`#di-pre-${secId}`);
  if (el) el.innerHTML = html;
}
function _setText(container, secId, text) {
  const el = container.querySelector(`#di-pre-${secId}`);
  if (el) el.textContent = text.replace(/\r/g, '').trimEnd();
}

function _toggle(container, secId) {
  const body  = container.querySelector(`#di-body-${secId}`);
  const arrow = container.querySelector(`#di-arrow-${secId}`);
  if (!body) return;
  const opening = body.style.display === 'none';
  body.style.display = opening ? '' : 'none';
  if (arrow) arrow.textContent = opening ? '▼' : '▶';
  return opening;
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────
export default {
  _ctx: null,
  _container: null,
  _secs: null,

  mount(container, ctx) {
    this._ctx       = ctx;
    this._container = container;
    const secs      = _sections(ctx);
    this._secs      = secs;

    container.innerHTML = `
      <div style="padding:8px 10px;border-bottom:1px solid var(--border);
                  display:flex;gap:8px;align-items:center;flex-shrink:0">
        <button class="btn-sm primary" id="di-refresh-all">⟳ 전체 새로고침</button>
        <span class="dim-text" id="di-status"></span>
      </div>
      <div style="flex:1;overflow-y:auto;padding:8px">
        ${secs.map(s => `
          <div class="info-section">
            <div class="info-section-hdr" data-sec="${s.id}">
              <span class="sec-arrow" id="di-arrow-${s.id}">▶</span>
              <span class="sec-title">${s.title}</span>
              <button class="btn-sm" data-refresh="${s.id}">새로고침</button>
            </div>
            <div class="info-section-body" id="di-body-${s.id}" style="display:none">
              <div id="di-pre-${s.id}" class="info-pre">
                <span class="dim-text">새로고침 버튼을 클릭하세요.</span>
              </div>
            </div>
          </div>`).join('')}
      </div>`;

    // 이벤트 위임
    container.addEventListener('click', e => {
      const hdr = e.target.closest('[data-sec]');
      const ref = e.target.closest('[data-refresh]');
      if (ref) {
        e.stopPropagation();
        const id  = ref.dataset.refresh;
        const sec = secs.find(s => s.id === id);
        const body  = container.querySelector(`#di-body-${id}`);
        const arrow = container.querySelector(`#di-arrow-${id}`);
        if (body)  body.style.display = '';
        if (arrow) arrow.textContent  = '▼';
        if (sec) sec.load(container);
      } else if (hdr) {
        const id  = hdr.dataset.sec;
        const sec = secs.find(s => s.id === id);
        const opening = _toggle(container, id);
        if (opening && sec) sec.load(container);
      }
    });

    container.querySelector('#di-refresh-all')?.addEventListener('click', () => {
      this._refreshAll();
    });
  },

  async _refreshAll() {
    const ctx     = this._ctx;
    const statusEl = this._container?.querySelector('#di-status');
    if (!ctx.connReady({ needShell: true })) return;
    if (statusEl) statusEl.textContent = '읽는 중...';
    await Promise.all(this._secs.map(s => s.load(this._container)));
    if (statusEl) statusEl.textContent = '완료';
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
  },

  unmount() {
    this._ctx = this._container = this._secs = null;
  },
};
