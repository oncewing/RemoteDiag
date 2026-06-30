/**
 * 디바이스 정보 — WR-H912K / WR-2 컴포넌트
 *
 * default.js 섹션 + BAND 정보 (LTE / NSA / SA)
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

// ── BAND 파싱 ─────────────────────────────────────────────────────────
// LTE:  *WBANDPREF:0xHHHHHHHHHHHHHHHH,PRIORITY:...
// NSA/SA: *WBANDPREF:0xHHHHHHHHHHHHHHHH,HHHHHHHHHHHHHHHH,...  (이후 그룹은 0x 없음)
// prefix: LTE='B', NSA/SA='n'
function _parseBandPref(response, bandPrefix) {
  const m = response.match(/\*WBANDPREF\s*:\s*([^\r\n]+)/i);
  if (!m) return '(파싱 실패)';
  const hexGroups = [];
  for (const part of m[1].split(',')) {
    const s = part.trim();
    if (/^PRIORITY/i.test(s)) break;
    const hex = s.replace(/^0x/i, '');
    if (hex.length === 16 && /^[0-9a-f]+$/i.test(hex)) hexGroups.push(hex);
  }
  const bands = [];
  for (let g = 0; g < hexGroups.length; g++) {
    const hi = parseInt(hexGroups[g].slice(0, 8), 16);
    const lo = parseInt(hexGroups[g].slice(8, 16), 16);
    const base = g * 64;
    for (let bit = 0; bit < 32; bit++) {
      if ((lo >>> bit) & 1) bands.push(base + bit + 1);
      if ((hi >>> bit) & 1) bands.push(base + bit + 33);
    }
  }
  return bands.length ? bands.sort((a, b) => a - b).map(b => bandPrefix + b).join(', ') : '없음';
}

// ── 섹션 정의 ─────────────────────────────────────────────────────────
function _err(c, secId, msg) {
  _setContent(c, secId, `<span class="t-err">${_esc(msg)}</span>`);
}

function _sections(ctx) {
  return [
    {
      id: 'devid', title: '단말 식별 정보',
      async load(c) {
        _setContent(c, 'devid', '<span class="dim-text">읽는 중...</span>');
        try {
          const [mRes, cRes] = await Promise.all([
            ctx.shellCmd('cat /sys/devices/soc0/wnet_model 2>/dev/null || cat /var/tmp/model_name 2>/dev/null || true', 5),
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
        } catch (e) { _err(c, 'devid', String(e)); }
      },
    },
    {
      id: 'at', title: '모뎀 정보',
      async load(c) {
        _setContent(c, 'at', '<span class="dim-text">읽는 중...</span>');
        try {
          const lines = [];
          const r1 = await ctx.atCmd('AT$$DBS', 10);
          lines.push('▶ AT$$DBS');
          lines.push(r1.response || r1.error || '(응답 없음)');
          lines.push('');
          const r2 = await ctx.atCmd('AT+CGDCONT?', 10);
          lines.push('▶ AT+CGDCONT?');
          lines.push(r2.response || r2.error || '(응답 없음)');
          _setText(c, 'at', lines.join('\n'));
        } catch (e) { _err(c, 'at', String(e)); }
      },
    },
    {
      id: 'band', title: 'BAND 정보',
      async load(c) {
        _setContent(c, 'band', '<span class="dim-text">읽는 중...</span>');
        try {
          const rLte = await ctx.atCmd('AT*WBANDPREF=LTE', 5);
          const isError = (r) => !r.response || r.response.toUpperCase().includes('ERROR');

          if (isError(rLte)) {
            // 폴백: AT$$BANDPREF?
            const rFb = await ctx.atCmd('AT$$BANDPREF?', 5);
            const fbResp = rFb.response || '';
            // 0x... 줄 다음 줄에 "B1 B5" 형태의 LTE 밴드 정보
            const lines = fbResp.split(/\r?\n|\r/).map(l => l.trim()).filter(Boolean);
            const bandLine = lines.find(l => /^B\d/i.test(l));
            const lte = bandLine ? bandLine.replace(/\s+/g, ', ') : (rFb.error || '(응답 없음)');
            _setContent(c, 'band',
              `<table class="dns-table">
                 <tr><td class="dns-label">LTE</td><td class="dns-value">${_esc(lte)}</td></tr>
               </table>`
            );
          } else {
            const rNsa = await ctx.atCmd('AT*WBANDPREF=NSA', 5);
            const rSa  = await ctx.atCmd('AT*WBANDPREF=SA',  5);
            const lte = _parseBandPref(rLte.response, 'B') || '없음';
            const nsa = rNsa.response ? (_parseBandPref(rNsa.response, 'n') || '없음') : (rNsa.error || '(응답 없음)');
            const sa  = rSa.response  ? (_parseBandPref(rSa.response,  'n') || '없음') : (rSa.error  || '(응답 없음)');
            _setContent(c, 'band',
              `<table class="dns-table">
                 <tr><td class="dns-label">LTE</td><td class="dns-value">${_esc(lte)}</td></tr>
                 <tr><td class="dns-label">NSA</td><td class="dns-value">${_esc(nsa)}</td></tr>
                 <tr><td class="dns-label">SA</td> <td class="dns-value">${_esc(sa)}</td></tr>
               </table>`
            );
          }
        } catch (e) { _err(c, 'band', String(e)); }
      },
    },
    {
      id: 'ifconfig', title: '네트워크',
      async load(c) {
        _setContent(c, 'ifconfig', '<span class="dim-text">읽는 중...</span>');
        try {
          const r = await ctx.shellCmd('ifconfig', 30);
          r.success && r.stdout
            ? _setText(c, 'ifconfig', r.stdout)
            : _err(c, 'ifconfig', r.stderr || r.error || '오류');
        } catch (e) { _err(c, 'ifconfig', String(e)); }
      },
    },
    {
      id: 'dns', title: 'DNS/DHCP 정보',
      async load(c) {
        _setContent(c, 'dns', '<span class="dim-text">읽는 중...</span>');
        try {
          const r = await ctx.shellCmd('cat /var/run/data/dnsmasq.conf.bridge0', 30);
          if (!r.success) { _err(c, 'dns', r.error || '오류'); return; }
          _setContent(c, 'dns', _renderDnsmasqConf((r.stdout || '') + (r.stderr ? '\n' + r.stderr : '')));
        } catch (e) { _err(c, 'dns', String(e)); }
      },
    },
    {
      id: 'mem', title: '메모리 정보',
      async load(c) {
        _setContent(c, 'mem', '<span class="dim-text">읽는 중...</span>');
        try {
          const r = await ctx.shellCmd('cat /proc/meminfo', 30);
          r.success && r.stdout
            ? _setText(c, 'mem', r.stdout)
            : _err(c, 'mem', r.stderr || r.error || '오류');
        } catch (e) { _err(c, 'mem', String(e)); }
      },
    },
    {
      id: 'ps', title: '프로세스 정보',
      async load(c) {
        _setContent(c, 'ps', '<span class="dim-text">읽는 중...</span>');
        try {
          const r = await ctx.shellCmd('ps', 30);
          r.success && r.stdout
            ? _setText(c, 'ps', r.stdout)
            : _err(c, 'ps', r.stderr || r.error || '오류');
        } catch (e) { _err(c, 'ps', String(e)); }
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
  if (!body) return false;
  const isOpen = body.dataset.open === '1';
  if (isOpen) {
    body.style.display = 'none';
    body.dataset.open  = '0';
    if (arrow) arrow.textContent = '▶';
    return false;
  } else {
    body.style.display = '';
    body.dataset.open  = '1';
    if (arrow) arrow.textContent = '▼';
    return true;
  }
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────
export default {
  _ctx: null,
  _container: null,
  _secs: null,
  _ac: null,

  mount(container, ctx) {
    this._ctx       = ctx;
    this._container = container;
    const secs      = _sections(ctx);
    this._secs      = secs;

    this._ac?.abort();
    this._ac = new AbortController();
    const signal = this._ac.signal;

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
                <span class="dim-text">항목을 클릭하거나 새로고침 버튼을 누르세요.</span>
              </div>
            </div>
          </div>`).join('')}
      </div>`;

    container.addEventListener('click', e => {
      const hdr = e.target.closest('[data-sec]');
      const ref = e.target.closest('[data-refresh]');
      if (ref) {
        e.stopPropagation();
        const id    = ref.dataset.refresh;
        const sec   = secs.find(s => s.id === id);
        const body  = container.querySelector(`#di-body-${id}`);
        const arrow = container.querySelector(`#di-arrow-${id}`);
        if (body)  { body.style.display = ''; body.dataset.open = '1'; }
        if (arrow) arrow.textContent = '▼';
        if (sec) sec.load(container);
      } else if (hdr) {
        const id      = hdr.dataset.sec;
        const sec     = secs.find(s => s.id === id);
        const opening = _toggle(container, id);
        if (opening && sec) sec.load(container);
      }
    }, { signal });

    container.querySelector('#di-refresh-all')?.addEventListener('click', () => {
      this._refreshAll();
    });
  },

  async _refreshAll() {
    const ctx      = this._ctx;
    const statusEl = this._container?.querySelector('#di-status');
    if (!ctx.connReady({ needShell: true })) return;
    if (statusEl) statusEl.textContent = '읽는 중...';
    await Promise.all(this._secs.map(s => s.load(this._container)));
    if (statusEl) statusEl.textContent = '완료';
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
  },

  unmount() {
    this._ac?.abort();
    this._ac = null;
    this._ctx = this._container = this._secs = null;
  },
};
